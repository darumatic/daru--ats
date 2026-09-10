import { describe, it, expect } from 'vitest';

// Pins each deterministic evaluator, and in particular when it refuses to
// answer. "Not assessed" is the designed outcome for a criterion nobody
// configured or the data cannot support, and every evaluator that can reach it
// has a case here - a regression that quietly turns one of those into a zero
// would move every score without failing anything else.
//
// It also pins that the old hard-coded match formula survived the move into the
// criteria engine rather than being rewritten along the way.

import { evaluateCriteria, MATCH_EVALUATORS } from '@/lib/match-criteria-evaluators';
import { computeWeightedScore } from '@/lib/match-criteria';
import {
	buildCandidateText,
	buildJobText,
	inferRequiredYears,
	inferYearsFromWorkExperience,
	locationScore,
	overlapRatio,
	tokenize
} from '@/lib/match-scoring';

const SKILLS = [
	{ id: 11, name: 'React' },
	{ id: 12, name: 'Terraform' }
];

const jobOrder = {
	title: 'Senior React Engineer',
	description: 'We need 5+ years of React and Terraform.',
	location: 'Sydney NSW',
	city: 'Sydney',
	state: 'NSW',
	employmentType: 'full_time'
};

const candidate = {
	currentJobTitle: 'Senior React Engineer',
	currentEmployer: 'Globex',
	summary: 'React and Terraform engineer.',
	skillSet: 'React, Terraform',
	city: 'Sydney',
	state: 'NSW',
	candidateSkills: [{ skill: { id: 11, name: 'React' } }],
	candidateWorkExperiences: [
		{ title: 'Senior React Engineer', companyName: 'Globex', location: 'Sydney NSW', startDate: '2018-01-01', endDate: '2024-01-01' }
	],
	candidateEducations: [{ schoolName: 'University of Sydney', degree: 'BSc Computer Science', fieldOfStudy: 'Computing' }]
};

function run(evaluatorKey, { candidate: person = candidate, jobOrder: job = jobOrder, options = {} } = {}) {
	return MATCH_EVALUATORS[evaluatorKey]({
		candidate: person,
		jobOrder: job,
		options,
		context: { skills: SKILLS, requiredSkillIds: [11, 12] }
	});
}

describe('jd_criteria_match', () => {
	it('reproduces the hard-coded formula it replaced, once location is weighted back in at 5%', () => {
		// The original score was
		//   coverage*0.45 + title*0.2 + keyword*0.15 + experience*0.15 + location*0.05
		// computed here from the same helpers, so this fails if the blend drifts.
		const coverage = 1 / 2;
		const keyword = overlapRatio(tokenize(buildJobText(jobOrder)), tokenize(buildCandidateText(candidate)));
		const title = overlapRatio(tokenize(jobOrder.title), tokenize(candidate.currentJobTitle));
		const years = inferYearsFromWorkExperience(candidate.candidateWorkExperiences);
		const experience = Math.max(0, Math.min(1, years / inferRequiredYears(jobOrder)));
		const location = locationScore(jobOrder, candidate);
		const original = Math.round(
			(coverage * 0.45 + title * 0.2 + keyword * 0.15 + experience * 0.15 + location * 0.05) * 100
		);

		const viaCriteria = computeWeightedScore(
			evaluateCriteria({
				criteria: [
					{ key: 'jd', label: 'JD', evaluatorKey: 'jd_criteria_match', weight: 95, options: {} },
					{ key: 'loc', label: 'Location', evaluatorKey: 'location', weight: 5, options: {} }
				],
				candidate,
				jobOrder,
				skills: SKILLS,
				requiredSkillIds: [11, 12]
			})
		).scorePercent;

		expect(Math.abs(viaCriteria - original)).toBeLessThanOrEqual(1);
	});

	it('exposes the component breakdown the old route computed and threw away', () => {
		const result = run('jd_criteria_match');

		expect(result.assessed).toBe(true);
		expect(result.detail.components).toEqual(
			expect.objectContaining({
				requiredSkillCoverage: expect.any(Number),
				titleOverlap: expect.any(Number),
				keywordOverlap: expect.any(Number),
				experienceFit: expect.any(Number)
			})
		);
		expect(result.detail.requiredSkillsMatched).toEqual(['React']);
		expect(result.detail.requiredSkillsMissing).toEqual(['Terraform']);
	});

	it('refuses to score a job order with no title and no description', () => {
		const result = run('jd_criteria_match', { jobOrder: { title: '', description: '', publicDescription: '' } });

		expect(result.assessed).toBe(false);
		expect(result.score).toBeNull();
	});
});

describe('location', () => {
	it('uses real distance when both sides have coordinates', () => {
		// Sydney CBD to Parramatta is roughly 14 miles.
		const result = run('location', {
			jobOrder: { ...jobOrder, locationLatitude: -33.8688, locationLongitude: 151.2093 },
			candidate: { ...candidate, addressLatitude: -33.815, addressLongitude: 151.0 },
			options: { maxDistanceMiles: 50 }
		});

		expect(result.assessed).toBe(true);
		expect(result.detail.distanceMiles).toBeGreaterThan(8);
		expect(result.detail.distanceMiles).toBeLessThan(20);
		expect(result.score).toBeGreaterThan(55);
	});

	it('scores a candidate beyond the configured radius at zero rather than refusing', () => {
		const result = run('location', {
			jobOrder: { ...jobOrder, locationLatitude: -33.8688, locationLongitude: 151.2093 },
			candidate: { ...candidate, addressLatitude: -31.95, addressLongitude: 115.86 },
			options: { maxDistanceMiles: 50 }
		});

		expect(result.assessed).toBe(true);
		expect(result.score).toBe(0);
	});

	it('treats a remote job as a full match without needing the candidate location', () => {
		const result = run('location', {
			jobOrder: { location: 'Remote (Australia)' },
			candidate: { city: '', state: '' }
		});

		expect(result).toMatchObject({ score: 100, assessed: true });
	});

	it('falls back to city and state text when coordinates are missing on either side', () => {
		const result = run('location');

		expect(result.assessed).toBe(true);
		expect(result.basis).toContain('city and state text');
		expect(result.score).toBe(100);
	});

	it('refuses to score when the job order has no location at all', () => {
		const result = run('location', { jobOrder: { title: 'Engineer' } });

		expect(result.assessed).toBe(false);
		expect(result.basis).toContain('no location on file');
	});

	it('refuses to score when the candidate has no location at all', () => {
		const result = run('location', { candidate: { ...candidate, city: '', state: '' } });

		expect(result.assessed).toBe(false);
		expect(result.basis).toContain('no city, state or coordinates');
	});
});

describe('local_experience', () => {
	it('scores the share of located roles that were in the job market', () => {
		const result = run('local_experience', {
			candidate: {
				...candidate,
				candidateWorkExperiences: [
					{ companyName: 'A', location: 'Sydney NSW' },
					{ companyName: 'B', location: 'Melbourne VIC' }
				]
			}
		});

		expect(result).toMatchObject({ score: 50, assessed: true });
		expect(result.detail).toEqual({ localRoles: 1, locatedRoles: 2 });
	});

	it('refuses to score when no role records a location', () => {
		const result = run('local_experience', {
			candidate: { ...candidate, candidateWorkExperiences: [{ companyName: 'A' }] }
		});

		expect(result.assessed).toBe(false);
	});
});

describe('big_company', () => {
	it('refuses to score until an employer list is configured', () => {
		const result = run('big_company', { options: { referenceValues: [] } });

		expect(result.assessed).toBe(false);
		expect(result.basis).toContain('only AI can judge it');
	});

	it('scores a current listed employer above a past one', () => {
		const current = run('big_company', { options: { referenceValues: ['Globex'] } });
		const past = run('big_company', {
			candidate: { ...candidate, currentEmployer: 'Tiny Co' },
			options: { referenceValues: ['Globex'] }
		});

		expect(current.score).toBe(100);
		expect(past.score).toBe(75);
	});

	it('matches a listed name inside a longer legal entity name', () => {
		const result = run('big_company', {
			candidate: { ...candidate, currentEmployer: 'Globex Australia Pty Ltd' },
			options: { referenceValues: ['Globex'] }
		});

		expect(result.score).toBe(100);
	});

	it('scores an unlisted employer as zero, which is an answer rather than a gap', () => {
		const result = run('big_company', { options: { referenceValues: ['Initech'] } });

		expect(result).toMatchObject({ score: 0, assessed: true });
	});
});

describe('university', () => {
	it('refuses to score until a school list or degree level is configured', () => {
		expect(run('university', { options: {} }).assessed).toBe(false);
	});

	it('scores a listed school', () => {
		const result = run('university', { options: { referenceValues: ['University of Sydney'] } });

		expect(result).toMatchObject({ score: 100, assessed: true });
	});

	it('reads the degree level out of the degree text', () => {
		const met = run('university', { options: { degreeLevels: ['bachelor'] } });
		const notMet = run('university', { options: { degreeLevels: ['doctorate'] } });

		expect(met.score).toBe(100);
		expect(notMet.score).toBe(0);
	});

	it('averages the checks when both a school list and a degree level are configured', () => {
		const result = run('university', {
			options: { referenceValues: ['University of Sydney'], degreeLevels: ['doctorate'] }
		});

		expect(result.score).toBe(50);
	});

	it('refuses to score a candidate with no education history', () => {
		const result = run('university', {
			candidate: { ...candidate, candidateEducations: [] },
			options: { referenceValues: ['University of Sydney'] }
		});

		expect(result.assessed).toBe(false);
	});
});

describe('experience_years', () => {
	it('prefers the stated experienceYears column over re-deriving it', () => {
		const result = run('experience_years', { candidate: { ...candidate, experienceYears: 10 } });

		expect(result.detail).toEqual({ years: 10, requiredYears: 5 });
		expect(result.score).toBe(100);
	});

	it('falls back to dated work history when the column is empty', () => {
		const result = run('experience_years');

		expect(result.assessed).toBe(true);
		expect(result.detail.years).toBeGreaterThan(5);
	});

	it('refuses to score a candidate with neither', () => {
		const result = run('experience_years', {
			candidate: { ...candidate, experienceYears: null, candidateWorkExperiences: [] }
		});

		expect(result.assessed).toBe(false);
	});
});

describe('skills_coverage', () => {
	it('scores required-skill coverage on its own', () => {
		expect(run('skills_coverage').score).toBe(50);
	});

	it('refuses to score when the job text named no known skills', () => {
		const result = MATCH_EVALUATORS.skills_coverage({
			candidate,
			jobOrder,
			options: {},
			context: { skills: SKILLS, requiredSkillIds: [] }
		});

		expect(result.assessed).toBe(false);
	});
});

describe('evaluateCriteria', () => {
	it('carries the criterion key, label and weight through to the result row', () => {
		const [row] = evaluateCriteria({
			criteria: [{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 20, options: {} }],
			candidate,
			jobOrder,
			skills: SKILLS,
			requiredSkillIds: [11]
		});

		expect(row).toMatchObject({ key: 'location', label: 'Location', weight: 20, source: 'rule' });
	});

	it('reports a criterion naming an unknown evaluator as unassessed rather than dropping it', () => {
		const [row] = evaluateCriteria({
			criteria: [{ key: 'future', label: 'Future', evaluatorKey: 'from_a_newer_build', weight: 20, options: {} }],
			candidate,
			jobOrder,
			skills: SKILLS,
			requiredSkillIds: []
		});

		expect(row).toMatchObject({ key: 'future', assessed: false, source: 'none' });
		expect(row.basis).toContain('from_a_newer_build');
	});
});
