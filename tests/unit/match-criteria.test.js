import { describe, it, expect } from 'vitest';

// Pins the weighted-criteria arithmetic and the inherit-vs-specialise rule.
//
// The assertion that matters most: a criterion nobody could assess leaves both
// sides of the fraction, while a criterion assessed as zero stays in the
// denominator. Collapsing those two into one number is the dishonesty this
// engine exists to avoid, and it is an easy regression to introduce.

import {
	DEFAULT_MATCH_CRITERIA,
	MATCH_CRITERIA_MAX,
	buildCriteriaSetHash,
	buildCriterionHash,
	computeWeightedScore,
	criteriaWeightShares,
	jobOrderMatchCriteriaSchema,
	matchCriteriaSetSchema,
	normalizeCriterionOptions,
	resolveEffectiveCriteria
} from '@/lib/match-criteria';

describe('computeWeightedScore', () => {
	it('weights assessed criteria and renormalises over them alone', () => {
		const result = computeWeightedScore([
			{ weight: 60, score: 80, assessed: true },
			{ weight: 40, score: 40, assessed: true }
		]);

		expect(result.scorePercent).toBe(64);
		expect(result.coveragePercent).toBe(100);
	});

	it('excludes an unassessed criterion from both the numerator and the denominator', () => {
		const result = computeWeightedScore([
			{ weight: 50, score: 80, assessed: true },
			{ weight: 50, score: null, assessed: false }
		]);

		// 80, not 40: the unassessed half is not a zero, it is a gap.
		expect(result.scorePercent).toBe(80);
		expect(result.coveragePercent).toBe(50);
		expect(result.assessedWeight).toBe(50);
		expect(result.totalWeight).toBe(100);
	});

	it('keeps a criterion assessed as zero in the denominator', () => {
		const scoredZero = computeWeightedScore([
			{ weight: 50, score: 80, assessed: true },
			{ weight: 50, score: 0, assessed: true }
		]);
		const notAssessed = computeWeightedScore([
			{ weight: 50, score: 80, assessed: true },
			{ weight: 50, score: null, assessed: false }
		]);

		expect(scoredZero.scorePercent).toBe(40);
		expect(notAssessed.scorePercent).toBe(80);
		expect(scoredZero.coveragePercent).toBe(100);
	});

	it('returns null rather than zero when nothing could be assessed', () => {
		const result = computeWeightedScore([
			{ weight: 50, score: null, assessed: false },
			{ weight: 50, score: null, assessed: false }
		]);

		expect(result.scorePercent).toBeNull();
		expect(result.coveragePercent).toBe(0);
	});

	it('clamps a component score into 0-100 before weighting it', () => {
		expect(computeWeightedScore([{ weight: 10, score: 500, assessed: true }]).scorePercent).toBe(100);
		expect(computeWeightedScore([{ weight: 10, score: -20, assessed: true }]).scorePercent).toBe(0);
	});

	it('ignores rows with no usable weight instead of dividing by zero', () => {
		expect(computeWeightedScore([]).scorePercent).toBeNull();
		expect(computeWeightedScore([{ weight: 0, score: 90, assessed: true }]).scorePercent).toBeNull();
	});
});

describe('criteriaWeightShares', () => {
	it('turns relative weights into the percentages the editor displays', () => {
		const shares = criteriaWeightShares([
			{ key: 'a', weight: 30 },
			{ key: 'b', weight: 10 }
		]);

		expect(shares).toEqual([
			{ key: 'a', percent: 75 },
			{ key: 'b', percent: 25 }
		]);
	});
});

describe('criteria hashing', () => {
	const criterion = { key: 'location', evaluatorKey: 'location', weight: 20, options: { maxDistanceMiles: 50 } };

	it('leaves a criterion hash unchanged when only its weight moves, so paid-for AI work survives a re-weight', () => {
		expect(buildCriterionHash({ ...criterion, weight: 45 })).toBe(buildCriterionHash(criterion));
	});

	it('changes a criterion hash when its options change', () => {
		expect(buildCriterionHash({ ...criterion, options: { maxDistanceMiles: 10 } })).not.toBe(
			buildCriterionHash(criterion)
		);
	});

	it('changes the set hash when a weight moves, because the resulting number does', () => {
		expect(buildCriteriaSetHash([{ ...criterion, weight: 45 }])).not.toBe(buildCriteriaSetHash([criterion]));
	});

	it('is stable across criterion order and option key order', () => {
		const other = { key: 'university', evaluatorKey: 'university', weight: 10, options: { referenceValues: ['UNSW', 'USyd'] } };
		const reordered = { ...other, options: { referenceValues: ['USyd', 'UNSW'] } };

		expect(buildCriteriaSetHash([criterion, other])).toBe(buildCriteriaSetHash([reordered, criterion]));
	});
});

describe('matchCriteriaSetSchema', () => {
	const valid = {
		key: 'location',
		label: 'Location',
		evaluatorKey: 'location',
		weight: 20,
		options: { maxDistanceMiles: 50 }
	};

	it('accepts a well-formed set and fills in the defaults', () => {
		const parsed = matchCriteriaSetSchema.parse([valid]);

		expect(parsed[0].aiEnabled).toBe(true);
		expect(parsed[0].description).toBe('');
		expect(parsed[0].options).toEqual({ maxDistanceMiles: 50 });
	});

	it('rejects duplicate keys, which would make an overlay ambiguous', () => {
		const result = matchCriteriaSetSchema.safeParse([valid, { ...valid, label: 'Location again' }]);

		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error.issues)).toContain('Duplicate criterion key');
	});

	it('rejects a weight outside 1-100 and an unknown evaluator', () => {
		expect(matchCriteriaSetSchema.safeParse([{ ...valid, weight: 0 }]).success).toBe(false);
		expect(matchCriteriaSetSchema.safeParse([{ ...valid, weight: 101 }]).success).toBe(false);
		expect(matchCriteriaSetSchema.safeParse([{ ...valid, evaluatorKey: 'vibes' }]).success).toBe(false);
	});

	it('rejects a malformed key and an empty or oversized set', () => {
		expect(matchCriteriaSetSchema.safeParse([{ ...valid, key: 'Location Fit' }]).success).toBe(false);
		expect(matchCriteriaSetSchema.safeParse([]).success).toBe(false);
		const tooMany = Array.from({ length: MATCH_CRITERIA_MAX + 1 }, (_unused, index) => ({
			...valid,
			key: `criterion_${index}`
		}));
		expect(matchCriteriaSetSchema.safeParse(tooMany).success).toBe(false);
	});

	it('strips options left behind by a previous evaluator instead of rejecting the row', () => {
		const parsed = matchCriteriaSetSchema.parse([
			{ ...valid, evaluatorKey: 'big_company', options: { maxDistanceMiles: 50, referenceValues: ['Atlassian'] } }
		]);

		expect(parsed[0].options).toEqual({ referenceValues: ['Atlassian'] });
	});

	it('gives an evaluator with no options an empty object', () => {
		expect(normalizeCriterionOptions('jd_criteria_match', { anything: true })).toEqual({});
	});
});

describe('resolveEffectiveCriteria', () => {
	const template = DEFAULT_MATCH_CRITERIA;

	it('inherits the live template when the job order has no override', () => {
		const resolved = resolveEffectiveCriteria({ jobOrder: { matchCriteria: null }, templateCriteria: template });

		expect(resolved.source).toBe('template');
		expect(resolved.criteria).toBe(template);
		expect(resolved.templateDrifted).toBe(false);
	});

	it('falls back to the built-in defaults when no template rows exist yet', () => {
		const resolved = resolveEffectiveCriteria({ jobOrder: {}, templateCriteria: [] });

		expect(resolved.criteria).toBe(DEFAULT_MATCH_CRITERIA);
	});

	it('uses the job order snapshot once it has been specialised', () => {
		const criteria = [{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 100, options: {} }];
		const resolved = resolveEffectiveCriteria({
			jobOrder: { matchCriteria: { version: 1, templateHash: buildCriteriaSetHash(template), criteria } },
			templateCriteria: template
		});

		expect(resolved.source).toBe('job');
		expect(resolved.criteria).toEqual(criteria);
		expect(resolved.templateDrifted).toBe(false);
	});

	it('flags drift once the template has moved on from what was specialised', () => {
		const criteria = [{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 100, options: {} }];
		const movedOn = [...template.slice(1), { ...template[0], weight: 99 }];
		const resolved = resolveEffectiveCriteria({
			jobOrder: { matchCriteria: { version: 1, templateHash: buildCriteriaSetHash(template), criteria } },
			templateCriteria: movedOn
		});

		expect(resolved.templateDrifted).toBe(true);
	});
});

describe('jobOrderMatchCriteriaSchema', () => {
	it('accepts null, which is how a job order says "inherit the template"', () => {
		expect(jobOrderMatchCriteriaSchema.parse(null)).toBeNull();
	});

	it('accepts a specialised envelope and rejects a bare array', () => {
		const criteria = [{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 20, options: {} }];

		expect(jobOrderMatchCriteriaSchema.parse({ version: 1, templateHash: 'abc', criteria }).criteria).toHaveLength(1);
		expect(jobOrderMatchCriteriaSchema.safeParse(criteria).success).toBe(false);
	});
});

describe('DEFAULT_MATCH_CRITERIA', () => {
	it('is a valid criteria set in its own right', () => {
		expect(matchCriteriaSetSchema.safeParse(DEFAULT_MATCH_CRITERIA).success).toBe(true);
	});

	it('seeds the five criteria the recruiters asked for, with JD match carrying the most weight', () => {
		expect(DEFAULT_MATCH_CRITERIA.map((criterion) => criterion.key)).toEqual([
			'jd_criteria_match',
			'location',
			'local_experience',
			'big_company',
			'university'
		]);

		const heaviest = [...DEFAULT_MATCH_CRITERIA].sort((a, b) => b.weight - a.weight)[0];
		expect(heaviest.key).toBe('jd_criteria_match');
	});
});
