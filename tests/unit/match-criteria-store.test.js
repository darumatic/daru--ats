import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins the template read path and the AI overlay merge.
//
// Two behaviours here are easy to break and expensive to get wrong: seeding
// must not resurrect a criterion an admin deliberately removed, and a read
// failure must not silently score every candidate against nothing.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		matchCriterion: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
		candidateJobScore: { findMany: vi.fn() }
	}
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/logger', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));

import { logError } from '@/lib/logger';
import {
	clearMatchCriteriaCache,
	ensureDefaultMatchCriteria,
	getMatchCriteriaTemplate,
	loadScoreOverlays,
	loadScoreOverlaysForCandidate,
	serializeMatchCriterionRow
} from '@/lib/match-criteria-store';
import { DEFAULT_MATCH_CRITERIA, buildCriterionHash } from '@/lib/match-criteria';
import { mergeCriteriaResults } from '@/lib/match-criteria-evaluators';

function storedRow(overrides = {}) {
	return {
		id: 1,
		recordId: 'MCR-AAAAAAAA',
		key: 'location',
		label: 'Location',
		description: null,
		evaluatorKey: 'location',
		weight: 20,
		aiEnabled: true,
		isActive: true,
		sortOrder: 10,
		options: { maxDistanceMiles: 50 },
		...overrides
	};
}

beforeEach(() => {
	Object.values(prismaMock).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
	logError.mockReset();
	clearMatchCriteriaCache();
});

describe('serializeMatchCriterionRow', () => {
	it('normalises the stored options against the row’s evaluator', () => {
		const row = serializeMatchCriterionRow(
			storedRow({ evaluatorKey: 'big_company', options: { maxDistanceMiles: 9, referenceValues: ['Atlassian'] } })
		);

		expect(row.options).toEqual({ referenceValues: ['Atlassian'] });
		expect(row.description).toBe('');
	});
});

describe('ensureDefaultMatchCriteria', () => {
	it('seeds the defaults into an empty table', async () => {
		prismaMock.matchCriterion.count.mockResolvedValue(0);
		prismaMock.matchCriterion.create.mockResolvedValue(storedRow());

		const seeded = await ensureDefaultMatchCriteria();

		expect(seeded).toBe(true);
		expect(prismaMock.matchCriterion.create).toHaveBeenCalledTimes(DEFAULT_MATCH_CRITERIA.length);
	});

	it('counts inactive rows too, so a deliberately emptied template is not resurrected', async () => {
		// Every criterion soft-deleted: count() sees them, so nothing is written.
		prismaMock.matchCriterion.count.mockResolvedValue(5);

		const seeded = await ensureDefaultMatchCriteria();

		expect(seeded).toBe(false);
		expect(prismaMock.matchCriterion.create).not.toHaveBeenCalled();
		expect(prismaMock.matchCriterion.count.mock.calls[0]).toEqual([]);
	});

	it('tolerates losing a seeding race instead of failing the request', async () => {
		prismaMock.matchCriterion.count.mockResolvedValue(0);
		const duplicate = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
		prismaMock.matchCriterion.create.mockRejectedValue(duplicate);

		await expect(ensureDefaultMatchCriteria()).resolves.toBe(true);
	});

	it('still surfaces a failure that is not a duplicate key', async () => {
		prismaMock.matchCriterion.count.mockResolvedValue(0);
		prismaMock.matchCriterion.create.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P2010' }));

		await expect(ensureDefaultMatchCriteria()).rejects.toThrow('boom');
	});
});

describe('getMatchCriteriaTemplate', () => {
	it('returns the active criteria in sort order', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValue([storedRow()]);

		const criteria = await getMatchCriteriaTemplate();

		expect(criteria.map((row) => row.key)).toEqual(['location']);
		expect(prismaMock.matchCriterion.findMany.mock.calls[0][0]).toMatchObject({ where: { isActive: true } });
	});

	it('caches the template so a match list does not re-read it every request', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValue([storedRow()]);

		await getMatchCriteriaTemplate();
		await getMatchCriteriaTemplate();

		expect(prismaMock.matchCriterion.findMany).toHaveBeenCalledTimes(1);
	});

	it('re-reads on demand when the cache is explicitly bypassed', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValue([storedRow()]);

		await getMatchCriteriaTemplate();
		await getMatchCriteriaTemplate({ forceRefresh: true });

		expect(prismaMock.matchCriterion.findMany).toHaveBeenCalledTimes(2);
	});

	it('seeds and re-reads when the table is empty', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([storedRow()]);
		prismaMock.matchCriterion.count.mockResolvedValue(0);
		prismaMock.matchCriterion.create.mockResolvedValue(storedRow());

		const criteria = await getMatchCriteriaTemplate();

		expect(criteria.map((row) => row.key)).toEqual(['location']);
	});

	it('falls back to the built-in defaults when every criterion is soft-deleted', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValue([]);
		prismaMock.matchCriterion.count.mockResolvedValue(5);

		const criteria = await getMatchCriteriaTemplate();

		// Scoring against an empty set would report every candidate as unscored,
		// which reads as "no data" rather than as a misconfiguration.
		expect(criteria).toEqual([...DEFAULT_MATCH_CRITERIA]);
		expect(prismaMock.matchCriterion.create).not.toHaveBeenCalled();
	});

	it('logs a read failure and serves defaults rather than scoring against nothing', async () => {
		prismaMock.matchCriterion.findMany.mockRejectedValue(new Error('connection lost'));

		const criteria = await getMatchCriteriaTemplate();

		expect(criteria).toEqual([...DEFAULT_MATCH_CRITERIA]);
		expect(logError).toHaveBeenCalledWith('match_criteria.template.read_failed', expect.any(Object));
	});

	it('does not cache a failed read, so the next caller retries', async () => {
		prismaMock.matchCriterion.findMany.mockRejectedValueOnce(new Error('connection lost'));
		prismaMock.matchCriterion.findMany.mockResolvedValueOnce([storedRow()]);

		await getMatchCriteriaTemplate();
		const second = await getMatchCriteriaTemplate();

		expect(second.map((row) => row.key)).toEqual(['location']);
	});
});

describe('overlay loading', () => {
	it('indexes a job order’s scores by candidate', async () => {
		prismaMock.candidateJobScore.findMany.mockResolvedValue([{ candidateId: 7, jobOrderId: 3, criteriaResults: [] }]);

		const overlays = await loadScoreOverlays({ jobOrderId: 3, candidateIds: [7, 8] });

		expect(overlays.get(7)).toMatchObject({ candidateId: 7 });
		expect(overlays.has(8)).toBe(false);
	});

	it('indexes a candidate’s scores by job order', async () => {
		prismaMock.candidateJobScore.findMany.mockResolvedValue([{ candidateId: 7, jobOrderId: 3, criteriaResults: [] }]);

		const overlays = await loadScoreOverlaysForCandidate({ candidateId: 7, jobOrderIds: [3] });

		expect(overlays.get(3)).toMatchObject({ jobOrderId: 3 });
	});

	it('skips the query entirely when there is nothing to look up', async () => {
		expect((await loadScoreOverlays({ jobOrderId: 3, candidateIds: [] })).size).toBe(0);
		expect((await loadScoreOverlaysForCandidate({ candidateId: null, jobOrderIds: [1] })).size).toBe(0);
		expect(prismaMock.candidateJobScore.findMany).not.toHaveBeenCalled();
	});
});

describe('mergeCriteriaResults', () => {
	const criterion = { key: 'big_company', label: 'Big Company', evaluatorKey: 'big_company', weight: 15, options: { referenceValues: [] } };
	const deterministic = [
		{ key: 'big_company', label: 'Big Company', weight: 15, score: null, assessed: false, source: 'none', basis: 'no list' }
	];

	it('lets a matching cached judgement supersede the deterministic result', () => {
		const { results, usedAi } = mergeCriteriaResults({
			deterministic,
			criteria: [criterion],
			overlay: {
				criteriaResults: [
					{ key: 'big_company', criterionHash: buildCriterionHash(criterion), score: 88, assessed: true, rationale: 'well known' }
				]
			}
		});

		expect(usedAi).toBe(true);
		expect(results[0]).toMatchObject({ score: 88, assessed: true, source: 'ai', basis: 'well known' });
	});

	it('keeps the cached judgement after a re-weight, because weight is not part of the hash', () => {
		const { usedAi } = mergeCriteriaResults({
			deterministic,
			criteria: [{ ...criterion, weight: 60 }],
			overlay: {
				criteriaResults: [
					{ key: 'big_company', criterionHash: buildCriterionHash(criterion), score: 88, assessed: true }
				]
			}
		});

		expect(usedAi).toBe(true);
	});

	it('drops the cached judgement once the criterion is redefined', () => {
		const { results, usedAi } = mergeCriteriaResults({
			deterministic,
			criteria: [{ ...criterion, options: { referenceValues: ['Atlassian'] } }],
			overlay: {
				criteriaResults: [
					{ key: 'big_company', criterionHash: buildCriterionHash(criterion), score: 88, assessed: true }
				]
			}
		});

		expect(usedAi).toBe(false);
		expect(results[0].assessed).toBe(false);
	});

	it('ignores a cached row that is itself unassessed or unusable', () => {
		const hash = buildCriterionHash(criterion);

		expect(
			mergeCriteriaResults({
				deterministic,
				criteria: [criterion],
				overlay: { criteriaResults: [{ key: 'big_company', criterionHash: hash, score: null, assessed: false }] }
			}).usedAi
		).toBe(false);

		expect(
			mergeCriteriaResults({
				deterministic,
				criteria: [criterion],
				overlay: { criteriaResults: [{ key: 'big_company', criterionHash: hash, score: 'high', assessed: true }] }
			}).usedAi
		).toBe(false);
	});

	it('clamps a cached score into range', () => {
		const { results } = mergeCriteriaResults({
			deterministic,
			criteria: [criterion],
			overlay: {
				criteriaResults: [
					{ key: 'big_company', criterionHash: buildCriterionHash(criterion), score: 1000, assessed: true }
				]
			}
		});

		expect(results[0].score).toBe(100);
	});

	it('is a no-op when there is no overlay at all', () => {
		const { results, usedAi } = mergeCriteriaResults({ deterministic, criteria: [criterion], overlay: null });

		expect(usedAi).toBe(false);
		expect(results).toEqual(deterministic);
	});
});
