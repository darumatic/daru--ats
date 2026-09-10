import { prisma } from '@/lib/prisma';
import { logError } from '@/lib/logger';
import { createRecordId } from '@/lib/record-id';
import { DEFAULT_MATCH_CRITERIA, normalizeCriterionOptions } from '@/lib/match-criteria';

// The only Prisma-touching part of criteria scoring: reading the template,
// seeding it when a database has none, and bulk-loading cached AI scores.
//
// The template is cached like integration settings are, and for the same
// reason: without it every match-list request adds a MatchCriterion.findMany,
// and the list path is the one that has to stay cheap.

const TEMPLATE_CACHE_TTL_MS = 30_000;

let templateCache = null;
let templateCacheAt = 0;
let templatePromise = null;

export function serializeMatchCriterionRow(row) {
	return {
		id: row.id,
		recordId: row.recordId,
		key: row.key,
		label: row.label,
		description: row.description || '',
		evaluatorKey: row.evaluatorKey,
		weight: row.weight,
		aiEnabled: row.aiEnabled !== false,
		isActive: row.isActive !== false,
		sortOrder: row.sortOrder ?? 0,
		options: normalizeCriterionOptions(row.evaluatorKey, row.options)
	};
}

export function clearMatchCriteriaCache() {
	templateCache = null;
	templateCacheAt = 0;
	templatePromise = null;
}

/**
 * Puts the seeded template back when a database has none at all.
 *
 * The emptiness check deliberately counts inactive rows too. Removing a
 * criterion in the admin UI is a soft delete, so counting only active rows
 * would resurrect every default the moment an admin turned the last one off.
 * Find-then-create, race-tolerant in the same shape as
 * ensureDefaultUnassignedClient: on a collision the row that already exists
 * wins and this call simply reads it back.
 */
export async function ensureDefaultMatchCriteria(dbClient = prisma) {
	const existing = await dbClient.matchCriterion.count();
	if (existing > 0) return false;

	await Promise.all(
		DEFAULT_MATCH_CRITERIA.map((criterion, index) =>
			dbClient.matchCriterion
				.create({
					data: {
						recordId: createRecordId('MatchCriterion'),
						key: criterion.key,
						label: criterion.label,
						description: criterion.description,
						evaluatorKey: criterion.evaluatorKey,
						weight: criterion.weight,
						aiEnabled: criterion.aiEnabled,
						options: criterion.options,
						sortOrder: (index + 1) * 10
					}
				})
				// A concurrent seeder got there first. The unique key on `key`
				// makes that safe to ignore rather than something to undo.
				.catch((error) => {
					if (error?.code !== 'P2002') throw error;
				})
		)
	);

	clearMatchCriteriaCache();
	return true;
}

async function readTemplate() {
	const rows = await prisma.matchCriterion.findMany({
		where: { isActive: true },
		orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
	});
	return rows.map(serializeMatchCriterionRow);
}

/**
 * The criteria every job order inherits.
 *
 * A read failure returns the built-in defaults rather than an empty set, and is
 * logged and left uncached: scoring against nothing would silently produce a
 * null score for every candidate, which looks like "no data" rather than like
 * the fault it is.
 */
export async function getMatchCriteriaTemplate({ forceRefresh = false } = {}) {
	const now = Date.now();
	if (!forceRefresh && templateCache && now - templateCacheAt < TEMPLATE_CACHE_TTL_MS) {
		return templateCache;
	}

	if (!forceRefresh && templatePromise) {
		return templatePromise;
	}

	templatePromise = (async () => {
		try {
			let criteria = await readTemplate();
			if (criteria.length === 0) {
				const seeded = await ensureDefaultMatchCriteria();
				criteria = seeded ? await readTemplate() : criteria;
			}
			// Every criterion soft-deleted is a legitimate state, but scoring
			// against an empty set is not, so fall back to the defaults without
			// writing anything back.
			const resolved = criteria.length > 0 ? criteria : [...DEFAULT_MATCH_CRITERIA];
			templateCache = resolved;
			templateCacheAt = Date.now();
			return resolved;
		} catch (error) {
			logError('match_criteria.template.read_failed', { detail: String(error?.message || error) });
			return [...DEFAULT_MATCH_CRITERIA];
		}
	})().finally(() => {
		templatePromise = null;
	});

	return templatePromise;
}

function indexOverlays(rows) {
	const byCandidate = new Map();
	const byJobOrder = new Map();
	for (const row of rows) {
		byCandidate.set(row.candidateId, row);
		byJobOrder.set(row.jobOrderId, row);
	}
	return { byCandidate, byJobOrder };
}

export async function loadScoreOverlays({ jobOrderId, candidateIds }) {
	const ids = (Array.isArray(candidateIds) ? candidateIds : []).filter(Boolean);
	if (!jobOrderId || ids.length === 0) return new Map();

	const rows = await prisma.candidateJobScore.findMany({
		where: { jobOrderId, candidateId: { in: ids } }
	});
	return indexOverlays(rows).byCandidate;
}

export async function loadScoreOverlaysForCandidate({ candidateId, jobOrderIds }) {
	const ids = (Array.isArray(jobOrderIds) ? jobOrderIds : []).filter(Boolean);
	if (!candidateId || ids.length === 0) return new Map();

	const rows = await prisma.candidateJobScore.findMany({
		where: { candidateId, jobOrderId: { in: ids } }
	});
	return indexOverlays(rows).byJobOrder;
}
