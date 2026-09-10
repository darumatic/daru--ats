import { z } from 'zod';

// The weighted criteria that define a match score: their shape, their defaults,
// and the arithmetic that turns per-criterion scores into one number.
//
// Dependency-free apart from Zod on purpose - the admin editor and the job-order
// page are client components and import the catalogue and the schemas, so
// nothing here may reach for Prisma or node:crypto.

export const MATCH_CRITERIA_MAX = 12;
export const MATCH_CRITERION_KEY_PATTERN = /^[a-z0-9_]{2,40}$/;

// Every evaluator has a deterministic implementation that can run over the whole
// candidate pool. `alwaysAssessable: false` means it stays honestly unassessed
// until an admin supplies the reference list it needs - a criterion nobody has
// configured must not contribute a guessed number to the total.
export const MATCH_EVALUATOR_OPTIONS = Object.freeze([
	{
		value: 'jd_criteria_match',
		label: 'JD Criteria Match',
		hint: 'Skills, title and keyword alignment against the job description.',
		alwaysAssessable: true
	},
	{
		value: 'location',
		label: 'Location',
		hint: 'Distance between the candidate and the job, falling back to city/state text.',
		alwaysAssessable: true
	},
	{
		value: 'local_experience',
		label: 'Local Experience',
		hint: 'Share of the candidate’s work history in the job’s market.',
		alwaysAssessable: true
	},
	{
		value: 'big_company',
		label: 'Big Company',
		hint: 'Employers matched against a list you supply. Needs AI or a list to score.',
		alwaysAssessable: false
	},
	{
		value: 'university',
		label: 'University',
		hint: 'Schools and degree levels you supply. Needs AI or a list to score.',
		alwaysAssessable: false
	},
	{
		value: 'experience_years',
		label: 'Years of Experience',
		hint: 'Total career length against the years the job asks for.',
		alwaysAssessable: true
	},
	{
		value: 'skills_coverage',
		label: 'Skills Coverage',
		hint: 'Required skills present on the candidate record, on its own.',
		alwaysAssessable: true
	}
]);

export const MATCH_EVALUATOR_KEYS = Object.freeze(MATCH_EVALUATOR_OPTIONS.map((option) => option.value));

export const DEGREE_LEVEL_OPTIONS = Object.freeze([
	{ value: 'associate', label: 'Associate' },
	{ value: 'bachelor', label: 'Bachelor' },
	{ value: 'master', label: 'Master' },
	{ value: 'doctorate', label: 'Doctorate' }
]);

// Weights are relative, not percentages: they never have to add up to anything.
// Requiring a sum of 100 would turn "add a criterion" into an edit of every
// other row, so the engine normalises and the editor shows the derived share.
export const DEFAULT_MATCH_CRITERIA = Object.freeze([
	{
		key: 'jd_criteria_match',
		label: 'JD Criteria Match',
		description: 'Skills, title and keyword alignment against the job description.',
		evaluatorKey: 'jd_criteria_match',
		weight: 40,
		aiEnabled: true,
		options: {}
	},
	{
		key: 'location',
		label: 'Location',
		description: 'How close the candidate is to where the job is based.',
		evaluatorKey: 'location',
		weight: 20,
		aiEnabled: true,
		options: { maxDistanceMiles: 50 }
	},
	{
		key: 'local_experience',
		label: 'Local Experience',
		description: 'Has already worked in this market.',
		evaluatorKey: 'local_experience',
		weight: 15,
		aiEnabled: true,
		options: {}
	},
	{
		key: 'big_company',
		label: 'Big Company',
		description: 'Experience at a large or recognised employer.',
		evaluatorKey: 'big_company',
		weight: 15,
		aiEnabled: true,
		options: { referenceValues: [] }
	},
	{
		key: 'university',
		label: 'University',
		description: 'Education level and institution.',
		evaluatorKey: 'university',
		weight: 10,
		aiEnabled: true,
		options: { referenceValues: [], degreeLevels: [] }
	}
]);

const referenceValuesSchema = z.array(z.string().trim().min(1).max(120)).max(200).default([]);

const optionsByEvaluator = {
	location: z.object({ maxDistanceMiles: z.number().int().min(1).max(12000).default(50) }),
	big_company: z.object({ referenceValues: referenceValuesSchema }),
	university: z.object({
		referenceValues: referenceValuesSchema,
		degreeLevels: z.array(z.enum(['associate', 'bachelor', 'master', 'doctorate'])).max(4).default([])
	})
};

// Unknown option keys are stripped rather than rejected: an admin switching a
// criterion from one evaluator to another would otherwise be blocked by options
// left behind by the previous evaluator.
export function normalizeCriterionOptions(evaluatorKey, options) {
	const schema = optionsByEvaluator[evaluatorKey];
	if (!schema) return {};
	const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
	const parsed = schema.safeParse(source);
	return parsed.success ? parsed.data : schema.parse({});
}

export const matchCriterionSchema = z
	.object({
		id: z.string().trim().max(64).optional(),
		key: z.string().trim().regex(MATCH_CRITERION_KEY_PATTERN, 'Use 2-40 lowercase letters, digits or underscores.'),
		label: z.string().trim().min(1).max(80),
		description: z.string().trim().max(400).default(''),
		evaluatorKey: z.enum(MATCH_EVALUATOR_KEYS),
		weight: z.number().int().min(1).max(100),
		aiEnabled: z.boolean().default(true),
		options: z.any().optional()
	})
	.transform((criterion) => ({
		...criterion,
		options: normalizeCriterionOptions(criterion.evaluatorKey, criterion.options)
	}));

export const matchCriteriaSetSchema = z
	.array(matchCriterionSchema)
	.min(1, 'At least one criterion is required.')
	.max(MATCH_CRITERIA_MAX, `At most ${MATCH_CRITERIA_MAX} criteria are supported.`)
	.superRefine((criteria, ctx) => {
		const seen = new Set();
		criteria.forEach((criterion, index) => {
			if (seen.has(criterion.key)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [index, 'key'],
					message: `Duplicate criterion key "${criterion.key}".`
				});
			}
			seen.add(criterion.key);
		});
	});

// A job order stores an envelope rather than a bare array so it can record the
// template it was specialised from. null means "inherit the live template",
// which is what every job order does until someone deliberately specialises it.
export const jobOrderMatchCriteriaSchema = z.union([
	z.null(),
	z.object({
		version: z.literal(1).default(1),
		templateHash: z.string().trim().max(64).default(''),
		criteria: matchCriteriaSetSchema
	})
]);

// A small stable string hash, not a cryptographic one: this only has to change
// when the definition changes, and keeping it dependency-free means the client
// editor can compute it too.
function stableHash(value) {
	let hash = 0x811c9dc5;
	const text = String(value);
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

function canonicalOptions(options) {
	if (!options || typeof options !== 'object') return '';
	return Object.keys(options)
		.sort()
		.map((key) => {
			const value = options[key];
			return `${key}=${Array.isArray(value) ? [...value].map(String).sort().join(',') : String(value)}`;
		})
		.join('&');
}

// Weight is deliberately NOT part of a criterion's hash. Re-weighting a
// criterion changes the total but not what the criterion means, so cached AI
// judgements stay valid and nobody pays to score the same thing twice.
export function buildCriterionHash(criterion) {
	return stableHash(
		[criterion?.key, criterion?.evaluatorKey, canonicalOptions(criterion?.options)].join('|')
	);
}

// The set hash does include weights, because the resulting number changes.
export function buildCriteriaSetHash(criteria) {
	const rows = Array.isArray(criteria) ? criteria : [];
	return stableHash(
		rows
			.map((criterion) => `${buildCriterionHash(criterion)}:${criterion?.weight}`)
			.sort()
			.join('|')
	);
}

/**
 * Turns per-criterion results into one number.
 *
 * A criterion that could not be assessed leaves BOTH the numerator and the
 * denominator, so the score reflects only what was actually judged and coverage
 * says how much that was. A criterion assessed as 0 stays in the denominator -
 * "scored badly" and "could not be scored" are different answers, and
 * collapsing them is exactly the dishonesty this engine exists to avoid.
 */
export function computeWeightedScore(results) {
	const rows = Array.isArray(results) ? results : [];
	let assessedWeight = 0;
	let totalWeight = 0;
	let weightedSum = 0;

	for (const row of rows) {
		const weight = Number(row?.weight);
		if (!Number.isFinite(weight) || weight <= 0) continue;
		totalWeight += weight;
		if (!row?.assessed) continue;
		const score = Number(row?.score);
		if (!Number.isFinite(score)) continue;
		assessedWeight += weight;
		weightedSum += Math.max(0, Math.min(100, score)) * weight;
	}

	return {
		scorePercent: assessedWeight > 0 ? Math.round(weightedSum / assessedWeight) : null,
		coveragePercent: totalWeight > 0 ? Math.round((assessedWeight / totalWeight) * 100) : 0,
		assessedWeight,
		totalWeight
	};
}

export function criteriaWeightShares(criteria) {
	const rows = Array.isArray(criteria) ? criteria : [];
	const total = rows.reduce((sum, criterion) => sum + (Number(criterion?.weight) || 0), 0);
	return rows.map((criterion) => ({
		key: criterion?.key,
		percent: total > 0 ? Math.round(((Number(criterion?.weight) || 0) / total) * 100) : 0
	}));
}

/**
 * Which criteria a job order actually scores against.
 *
 * A job inherits the live template until someone specialises it, at which point
 * it keeps its own snapshot and stops tracking template edits. `templateDrifted`
 * is how the UI can offer to re-apply the template instead of a specialised job
 * silently missing every criterion added afterwards.
 */
export function resolveEffectiveCriteria({ jobOrder, templateCriteria }) {
	const template = Array.isArray(templateCriteria) && templateCriteria.length > 0
		? templateCriteria
		: DEFAULT_MATCH_CRITERIA;
	const override = jobOrder?.matchCriteria;

	if (!override || !Array.isArray(override?.criteria) || override.criteria.length === 0) {
		return { criteria: template, source: 'template', templateDrifted: false };
	}

	return {
		criteria: override.criteria,
		source: 'job',
		templateDrifted: Boolean(override.templateHash) && override.templateHash !== buildCriteriaSetHash(template)
	};
}

const STRONG_CRITERION_SCORE = 70;
const WEAK_CRITERION_SCORE = 40;

/**
 * Turns a criteria breakdown into the reason/risk lines the match lists and the
 * AI explanation prompt consume.
 *
 * An unassessed criterion is reported as a risk in its own words rather than
 * being left out: "we could not judge this" is something a recruiter needs to
 * see before trusting the number.
 */
export function summarizeCriteriaResults(results) {
	const reasons = [];
	const risks = [];

	for (const row of Array.isArray(results) ? results : []) {
		const label = row?.label || row?.key || 'Criterion';
		if (!row?.assessed) {
			risks.push(`${label}: not assessed - ${row?.basis || 'no data'}`);
			continue;
		}
		const score = Number(row?.score);
		if (!Number.isFinite(score)) continue;
		if (score >= STRONG_CRITERION_SCORE) {
			reasons.push(`${label} ${score}% - ${row?.basis || ''}`.trim());
		} else if (score < WEAK_CRITERION_SCORE) {
			risks.push(`${label} ${score}% - ${row?.basis || ''}`.trim());
		}
	}

	return { reasons, risks };
}

/**
 * Ranks matches best first, with unscored rows last.
 *
 * A null score means "we could not assess this candidate", which must not sort
 * as though it were a zero - it has not been judged badly, it has not been
 * judged at all. Ties break on coverage so that, between two equal scores, the
 * one resting on more evidence comes first.
 */
export function sortMatches(rows) {
	return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
		const aScore = Number.isFinite(Number(a?.scorePercent)) ? Number(a.scorePercent) : null;
		const bScore = Number.isFinite(Number(b?.scorePercent)) ? Number(b.scorePercent) : null;
		if (aScore === null && bScore === null) return 0;
		if (aScore === null) return 1;
		if (bScore === null) return -1;
		if (bScore !== aScore) return bScore - aScore;
		return (Number(b?.coveragePercent) || 0) - (Number(a?.coveragePercent) || 0);
	});
}
