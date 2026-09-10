import { describe, it, expect } from 'vitest';

// Pins the shared matching helpers that both match routes now import from one
// place. They used to exist as two byte-identical private copies, so nothing
// ever exercised them; these assertions describe the behaviour the extraction
// had to preserve exactly, and are what a future change to the heuristics has
// to argue with.

import {
	buildReasons,
	findJobSkillIds,
	inferRequiredYears,
	inferYearsFromWorkExperience,
	locationScore,
	normalizeText,
	overlapRatio,
	toBooleanParam,
	toMatchLimit,
	toPercent,
	tokenize
} from '@/lib/match-scoring';

describe('normalizeText and tokenize', () => {
	it('strips markup and punctuation but keeps the characters that live inside tech names', () => {
		expect(normalizeText('<p>C++, C#, .NET &amp; Node.js</p>')).toBe('c++ c# .net amp node.js');
	});

	it('drops single-character tokens so initials and stray letters do not count as skills', () => {
		expect(tokenize('a Go Java x')).toEqual(['go', 'java']);
	});
});

describe('overlapRatio', () => {
	it('divides by the first argument, so argument order decides the question being asked', () => {
		const job = ['react', 'node', 'aws', 'terraform'];
		const candidate = ['react', 'node'];

		expect(overlapRatio(job, candidate)).toBe(0.5);
		expect(overlapRatio(candidate, job)).toBe(1);
	});

	it('treats an empty side as no overlap rather than dividing by zero', () => {
		expect(overlapRatio([], ['react'])).toBe(0);
		expect(overlapRatio(['react'], [])).toBe(0);
	});

	it('counts distinct values, so a repeated token cannot inflate the ratio', () => {
		expect(overlapRatio(['react', 'react'], ['react'])).toBe(1);
	});
});

describe('inferYearsFromWorkExperience', () => {
	it('sums every range and caps the total at 30 years', () => {
		const forty = Array.from({ length: 8 }, () => ({
			startDate: '2000-01-01',
			endDate: '2005-01-01'
		}));

		expect(inferYearsFromWorkExperience(forty)).toBe(30);
	});

	it('treats a current role as running until today', () => {
		const startedTwoYearsAgo = new Date();
		startedTwoYearsAgo.setFullYear(startedTwoYearsAgo.getFullYear() - 2);

		const years = inferYearsFromWorkExperience([
			{ startDate: startedTwoYearsAgo.toISOString(), endDate: null, isCurrent: true }
		]);

		expect(years).toBeGreaterThan(1.9);
		expect(years).toBeLessThan(2.1);
	});

	it('ignores rows with no start date, an unparseable date, or an end before the start', () => {
		expect(
			inferYearsFromWorkExperience([
				{ startDate: null, endDate: '2020-01-01' },
				{ startDate: 'not a date', endDate: '2020-01-01' },
				{ startDate: '2020-01-01', endDate: '2015-01-01' }
			])
		).toBe(0);
	});

	it('returns zero for an empty or missing history', () => {
		expect(inferYearsFromWorkExperience([])).toBe(0);
		expect(inferYearsFromWorkExperience(null)).toBe(0);
	});
});

describe('inferRequiredYears', () => {
	it('reads a year requirement out of the title or the description', () => {
		expect(inferRequiredYears({ title: 'Engineer', description: 'Needs 7+ years of Go' })).toBe(7);
		expect(inferRequiredYears({ title: '5 years experience required', description: '' })).toBe(5);
	});

	it('caps the requirement at 20 years so a stray number cannot dominate the score', () => {
		expect(inferRequiredYears({ title: '', description: '45 years' })).toBe(20);
	});

	it('returns zero when the job never states one', () => {
		expect(inferRequiredYears({ title: 'Engineer', description: 'Great team' })).toBe(0);
	});
});

describe('locationScore', () => {
	it('scores remote and hybrid roles on the job alone, ignoring where the candidate lives', () => {
		expect(locationScore({ location: 'Remote (AU)' }, { city: '', state: '' })).toBe(1);
		expect(locationScore({ location: 'Hybrid - Sydney' }, { city: '', state: '' })).toBe(0.8);
	});

	it('stays neutral when the job states no location at all', () => {
		expect(locationScore({ location: '' }, { city: 'Sydney', state: 'NSW' })).toBe(0.6);
	});

	it('rewards a city match above a state match', () => {
		expect(locationScore({ location: 'Sydney NSW' }, { city: 'Sydney', state: 'NSW' })).toBe(1);
		expect(locationScore({ location: 'Newcastle NSW' }, { city: 'Sydney', state: 'NSW' })).toBe(0.85);
	});

	it('penalises an outright mismatch harder than a candidate with no location on file', () => {
		const unknown = locationScore({ location: 'Sydney NSW' }, { city: '', state: '' });
		const mismatch = locationScore({ location: 'Sydney NSW' }, { city: 'Perth', state: 'WA' });

		expect(unknown).toBe(0.25);
		expect(mismatch).toBe(0.35);
	});
});

describe('findJobSkillIds', () => {
	const skills = [
		{ id: 1, name: 'React' },
		{ id: 2, name: 'Terraform' },
		{ id: 3, name: 'Kubernetes' }
	];

	it('matches skills named anywhere in the job text and leaves the rest out', () => {
		expect(findJobSkillIds('We need React and Terraform experience', skills)).toEqual([1, 2]);
	});

	it('returns each skill once even when the job mentions it repeatedly', () => {
		expect(findJobSkillIds('React React React', skills)).toEqual([1]);
	});

	it('skips skills with a blank name instead of matching everything', () => {
		expect(findJobSkillIds('anything at all', [{ id: 9, name: '   ' }])).toEqual([]);
	});
});

describe('toPercent', () => {
	it('clamps to 0-100 so a component score can never push the total out of range', () => {
		expect(toPercent(0.5)).toBe(50);
		expect(toPercent(-1)).toBe(0);
		expect(toPercent(2)).toBe(100);
	});
});

describe('request parameter helpers', () => {
	it('reads the truthy spellings the match lists actually send', () => {
		expect(toBooleanParam('true')).toBe(true);
		expect(toBooleanParam('1')).toBe(true);
		expect(toBooleanParam('yes')).toBe(true);
		expect(toBooleanParam('false')).toBe(false);
		expect(toBooleanParam(null, true)).toBe(true);
	});

	it('caps the limit at 100 and falls back on junk', () => {
		expect(toMatchLimit('25')).toBe(25);
		expect(toMatchLimit('5000')).toBe(100);
		expect(toMatchLimit('-1')).toBe(10);
		expect(toMatchLimit('abc', 7)).toBe(7);
	});
});

describe('buildReasons', () => {
	it('splits matched skills into reasons and missing skills into risks', () => {
		const { reasons, risks } = buildReasons({
			requiredSkillsMatched: ['React'],
			requiredSkillsMissing: ['Terraform'],
			experienceYears: 6,
			requiredYears: 5,
			locationFit: 1,
			titleOverlap: 0.6
		});

		expect(reasons).toContain('Matched skills: React');
		expect(reasons).toContain('Experience fit: 6.0 years vs 5+ target');
		expect(reasons).toContain('Strong title alignment with job order');
		expect(risks).toContain('Missing skills: Terraform');
	});

	it('reports an experience shortfall as a risk rather than a reason', () => {
		const { reasons, risks } = buildReasons({
			requiredSkillsMatched: [],
			requiredSkillsMissing: [],
			experienceYears: 2,
			requiredYears: 8,
			locationFit: 0.2,
			titleOverlap: 0
		});

		expect(reasons).toEqual([]);
		expect(risks).toContain('Experience gap: 2.0 years vs 8+ target');
		expect(risks).toContain('Low title alignment');
		expect(risks).toContain('Potential location mismatch');
	});

	it('says nothing about experience when the job never stated a requirement', () => {
		const { reasons, risks } = buildReasons({
			requiredSkillsMatched: [],
			requiredSkillsMissing: [],
			experienceYears: 12,
			requiredYears: 0,
			locationFit: 1,
			titleOverlap: 0.3
		});

		expect([...reasons, ...risks].join(' ')).not.toMatch(/[Ee]xperience/);
	});
});
