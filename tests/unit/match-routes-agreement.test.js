import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two match routes answer the same question from opposite ends - "who fits
// this job" and "which jobs fit this candidate" - and for a long time each
// carried its own byte-identical copy of the scoring heuristics, so a fix to
// one silently left the other behind. Both now import one shared module, and
// this pins the property that made the duplication worth removing: for the same
// candidate/job pair, both routes report the same score and the same reasons.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		jobOrder: { findFirst: vi.fn(), findMany: vi.fn() },
		candidate: { findFirst: vi.fn(), findMany: vi.fn() },
		candidateJobScore: { findMany: vi.fn() },
		matchCriterion: { findMany: vi.fn(), count: vi.fn() },
		skill: { findMany: vi.fn() }
	}
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser: vi.fn()
}));
vi.mock('@/lib/request-throttle', () => ({
	consumeRequestThrottle: vi.fn().mockResolvedValue({ allowed: true })
}));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));
// The template is mocked rather than read through Prisma: the store keeps a 30s
// process-wide cache, which would otherwise leak one test's template into the
// next. Overlays stay real so the merge path is exercised.
vi.mock('@/lib/match-criteria-store', async (importOriginal) => ({
	...(await importOriginal()),
	getMatchCriteriaTemplate: vi.fn(),
	loadScoreOverlays: vi.fn(),
	loadScoreOverlaysForCandidate: vi.fn()
}));

import { getActingUser } from '@/lib/access-control';
import { consumeRequestThrottle } from '@/lib/request-throttle';
import {
	getMatchCriteriaTemplate,
	loadScoreOverlays,
	loadScoreOverlaysForCandidate
} from '@/lib/match-criteria-store';
import { DEFAULT_MATCH_CRITERIA, buildCriterionHash } from '@/lib/match-criteria';
import { GET as jobOrderMatches } from '../../app/api/job-orders/[id]/matches/route.js';
import { GET as candidateMatches } from '../../app/api/candidates/[id]/matches/route.js';

const admin = { id: 1, role: 'ADMINISTRATOR', divisionId: null, division: null, isActive: true };

const SKILLS = [
	{ id: 11, name: 'React' },
	{ id: 12, name: 'Terraform' },
	{ id: 13, name: 'Kubernetes' }
];

function buildJobOrder(id) {
	return {
		id,
		title: 'Senior React Engineer',
		status: 'open',
		openings: 2,
		description: 'We need 5+ years of React and Terraform.',
		publicDescription: '',
		location: 'Sydney NSW',
		employmentType: 'full_time',
		divisionId: 3,
		client: { id: 5, name: 'Acme' },
		contact: { id: 6, firstName: 'Dana', lastName: 'Reed' },
		ownerUser: { id: 7, firstName: 'Sam', lastName: 'Ng' },
		_count: { submissions: 1 },
		submissions: []
	};
}

function buildCandidate(id) {
	return {
		id,
		firstName: 'Robin',
		lastName: 'Blake',
		currentJobTitle: 'Senior React Engineer',
		currentEmployer: 'Globex',
		summary: 'React and Terraform engineer.',
		skillSet: 'React, Terraform',
		city: 'Sydney',
		state: 'NSW',
		divisionId: 3,
		ownerUser: { id: 7, firstName: 'Sam', lastName: 'Ng' },
		candidateSkills: [
			{ skill: { id: 11, name: 'React' } },
			{ skill: { id: 12, name: 'Terraform' } }
		],
		candidateWorkExperiences: [
			{ title: 'Senior React Engineer', startDate: '2018-01-01', endDate: '2024-01-01', isCurrent: false }
		],
		submissions: []
	};
}

async function readJobOrderMatch(jobOrderId, candidate) {
	prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(jobOrderId));
	prismaMock.skill.findMany.mockResolvedValue(SKILLS);
	prismaMock.candidate.findMany.mockResolvedValue([candidate]);

	const response = await jobOrderMatches(
		new Request(`http://localhost/api/job-orders/${jobOrderId}/matches`),
		{ params: Promise.resolve({ id: String(jobOrderId) }) }
	);
	expect(response.status).toBe(200);
	const payload = await response.json();
	return payload.matches[0];
}

async function readCandidateMatch(candidateId, jobOrder) {
	prismaMock.candidate.findFirst.mockResolvedValue(buildCandidate(candidateId));
	prismaMock.skill.findMany.mockResolvedValue(SKILLS);
	prismaMock.jobOrder.findMany.mockResolvedValue([jobOrder]);

	const response = await candidateMatches(
		new Request(`http://localhost/api/candidates/${candidateId}/matches`),
		{ params: Promise.resolve({ id: String(candidateId) }) }
	);
	expect(response.status).toBe(200);
	const payload = await response.json();
	return payload.matches[0];
}

beforeEach(() => {
	Object.values(prismaMock).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
	getActingUser.mockReset();
	getActingUser.mockResolvedValue(admin);
	consumeRequestThrottle.mockClear();
	consumeRequestThrottle.mockResolvedValue({ allowed: true });
	getMatchCriteriaTemplate.mockReset();
	getMatchCriteriaTemplate.mockResolvedValue(DEFAULT_MATCH_CRITERIA);
	loadScoreOverlays.mockReset();
	loadScoreOverlays.mockResolvedValue(new Map());
	loadScoreOverlaysForCandidate.mockReset();
	loadScoreOverlaysForCandidate.mockResolvedValue(new Map());
});

describe('candidate/job-order match scoring, from both directions', () => {
	it('reports the same score and reasons for the same pair', async () => {
		// Distinct job-order ids per assertion: the job-order route keeps a 60s
		// in-process cache keyed by job order, which would otherwise serve a
		// stale payload to a later test in the same run.
		const fromJob = await readJobOrderMatch(101, buildCandidate(55));
		const fromCandidate = await readCandidateMatch(55, buildJobOrder(101));

		expect(fromJob.scorePercent).toBe(fromCandidate.scorePercent);
		expect(fromJob.reasons).toEqual(fromCandidate.reasons);
		expect(fromJob.risks).toEqual(fromCandidate.risks);
	});

	it('still agrees when the candidate is a poor fit', async () => {
		const weakCandidate = {
			...buildCandidate(56),
			currentJobTitle: 'Warehouse Supervisor',
			summary: 'Logistics and stock control.',
			skillSet: 'Forklift',
			city: 'Perth',
			state: 'WA',
			candidateSkills: [],
			candidateWorkExperiences: []
		};

		const fromJob = await readJobOrderMatch(102, weakCandidate);

		prismaMock.candidate.findFirst.mockResolvedValue(weakCandidate);
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.jobOrder.findMany.mockResolvedValue([buildJobOrder(102)]);
		const response = await candidateMatches(
			new Request('http://localhost/api/candidates/56/matches'),
			{ params: Promise.resolve({ id: '56' }) }
		);
		const fromCandidate = (await response.json()).matches[0];

		expect(fromJob.scorePercent).toBe(fromCandidate.scorePercent);
		expect(fromJob.risks).toEqual(fromCandidate.risks);
		expect(fromJob.scorePercent).toBeLessThan(50);
	});

	it('scores a matching candidate above a mismatched one', async () => {
		const strong = await readJobOrderMatch(103, buildCandidate(57));
		const weak = await readJobOrderMatch(104, {
			...buildCandidate(58),
			currentJobTitle: 'Warehouse Supervisor',
			summary: 'Logistics.',
			skillSet: '',
			city: 'Perth',
			state: 'WA',
			candidateSkills: [],
			candidateWorkExperiences: []
		});

		expect(strong.scorePercent).toBeGreaterThan(weak.scorePercent);
	});
});

describe('job-order match eligibility', () => {
	it('returns no matches while the job order is not open, without scanning candidates', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue({ ...buildJobOrder(105), status: 'on_hold' });

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/105/matches'),
			{ params: Promise.resolve({ id: '105' }) }
		);
		const payload = await response.json();

		expect(payload.matches).toEqual([]);
		expect(payload.matchEligibility).toContain('on hold');
		expect(prismaMock.candidate.findMany).not.toHaveBeenCalled();
	});

	it('still reports the criteria for a job order that is not open', async () => {
		// The job-order editor seeds a specialisation from this list. Omitting it
		// here would let someone specialise a closed role into an empty criteria
		// set, which the save then rejects.
		prismaMock.jobOrder.findFirst.mockResolvedValue({ ...buildJobOrder(109), status: 'closed' });

		const payload = await (
			await jobOrderMatches(new Request('http://localhost/api/job-orders/109/matches'), {
				params: Promise.resolve({ id: '109' })
			})
		).json();

		expect(payload.matches).toEqual([]);
		expect(payload.criteria.map((criterion) => criterion.key)).toEqual(
			DEFAULT_MATCH_CRITERIA.map((criterion) => criterion.key)
		);
		expect(payload.criteriaHash).toEqual(expect.any(String));
	});

	it('carries each criterion\u2019s options, so specialising does not drop a reference list', async () => {
		getMatchCriteriaTemplate.mockResolvedValue([
			{
				key: 'big_company',
				label: 'Big Company',
				evaluatorKey: 'big_company',
				weight: 20,
				options: { referenceValues: ['Atlassian', 'Canva'] }
			}
		]);
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(110));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(70)]);

		const payload = await (
			await jobOrderMatches(new Request('http://localhost/api/job-orders/110/matches'), {
				params: Promise.resolve({ id: '110' })
			})
		).json();

		expect(payload.criteria[0].options).toEqual({ referenceValues: ['Atlassian', 'Canva'] });
	});

	it('carries each criterion\u2019s guidance, so specialising a role keeps the questions', async () => {
		getMatchCriteriaTemplate.mockResolvedValue([
			{
				key: 'big_company',
				label: 'Big Company',
				description: 'Worked at a firm of 1000+ headcount.',
				evaluatorKey: 'big_company',
				weight: 20,
				options: { referenceValues: [] }
			}
		]);
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(111));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(71)]);

		const payload = await (
			await jobOrderMatches(new Request('http://localhost/api/job-orders/111/matches'), {
				params: Promise.resolve({ id: '111' })
			})
		).json();

		expect(payload.criteria[0].description).toBe('Worked at a firm of 1000+ headcount.');
	});

	it('reports a missing job order as a 404', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue(null);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/106/matches'),
			{ params: Promise.resolve({ id: '106' }) }
		);

		expect(response.status).toBe(404);
	});

	it('refuses to score when the caller is over the rate limit', async () => {
		consumeRequestThrottle.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/107/matches'),
			{ params: Promise.resolve({ id: '107' }) }
		);

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('30');
		expect(prismaMock.jobOrder.findFirst).not.toHaveBeenCalled();
	});
});

describe('criteria-driven job-order matches', () => {
	it('reports the criteria it scored against, so the number can be read', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(201));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(60)]);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/201/matches'),
			{ params: Promise.resolve({ id: '201' }) }
		);
		const payload = await response.json();

		expect(payload.criteriaSource).toBe('template');
		expect(payload.criteria.map((criterion) => criterion.key)).toEqual(
			DEFAULT_MATCH_CRITERIA.map((criterion) => criterion.key)
		);
		expect(payload.matches[0].criteriaResults).toHaveLength(DEFAULT_MATCH_CRITERIA.length);
		expect(payload.matches[0].coveragePercent).toBeLessThan(100);
	});

	it('leaves an unconfigured criterion out of the score instead of scoring it zero', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(202));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(61)]);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/202/matches'),
			{ params: Promise.resolve({ id: '202' }) }
		);
		const [match] = (await response.json()).matches;
		const bigCompany = match.criteriaResults.find((row) => row.key === 'big_company');

		// Seeded with an empty employer list, so the rules engine cannot judge it.
		expect(bigCompany).toMatchObject({ assessed: false, score: null, source: 'none' });
		// Three of the five criteria cannot be judged here: big_company (15) and
		// university (10) ship with empty reference lists, and local_experience
		// (15) has no located work history to read. Only jd_criteria_match (40)
		// and location (20) count, so coverage is 60% - and the score is the
		// average of those two alone rather than being dragged down by three
		// invented zeroes.
		expect(match.coveragePercent).toBe(60);
		expect(match.hasAiScore).toBe(false);
	});

	it('lets a fresh AI judgement supersede the rule score and raise coverage', async () => {
		const criterion = DEFAULT_MATCH_CRITERIA.find((row) => row.key === 'big_company');
		loadScoreOverlays.mockResolvedValue(
			new Map([
				[
					62,
					{
						candidateId: 62,
						criteriaResults: [
							{
								key: 'big_company',
								criterionHash: buildCriterionHash(criterion),
								score: 90,
								assessed: true,
								rationale: 'Globex is a household name in this market.'
							}
						]
					}
				]
			])
		);
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(203));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(62)]);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/203/matches'),
			{ params: Promise.resolve({ id: '203' }) }
		);
		const [match] = (await response.json()).matches;
		const bigCompany = match.criteriaResults.find((row) => row.key === 'big_company');

		expect(bigCompany).toMatchObject({ assessed: true, score: 90, source: 'ai' });
		expect(bigCompany.basis).toContain('household name');
		expect(match.hasAiScore).toBe(true);
		// 60% plus the 15 that big_company carries once AI has judged it.
		expect(match.coveragePercent).toBe(75);
	});

	it('ignores a cached judgement once the criterion it judged has been redefined', async () => {
		loadScoreOverlays.mockResolvedValue(
			new Map([
				[
					63,
					{
						candidateId: 63,
						criteriaResults: [
							{ key: 'big_company', criterionHash: 'stale000', score: 90, assessed: true, rationale: 'old' }
						]
					}
				]
			])
		);
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(204));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(63)]);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/204/matches'),
			{ params: Promise.resolve({ id: '204' }) }
		);
		const [match] = (await response.json()).matches;

		expect(match.criteriaResults.find((row) => row.key === 'big_company').assessed).toBe(false);
		expect(match.hasAiScore).toBe(false);
	});

	it('scores a specialised job order against its own criteria, not the template', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue({
			...buildJobOrder(205),
			matchCriteria: {
				version: 1,
				templateHash: 'whatever',
				criteria: [
					{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 100, options: {} }
				]
			}
		});
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(64)]);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/205/matches'),
			{ params: Promise.resolve({ id: '205' }) }
		);
		const payload = await response.json();

		expect(payload.criteriaSource).toBe('job');
		expect(payload.criteria.map((criterion) => criterion.key)).toEqual(['location']);
		// Sydney candidate, Sydney job, scored on location alone.
		expect(payload.matches[0].scorePercent).toBe(100);
		expect(payload.matches[0].coveragePercent).toBe(100);
	});

	it('flags a specialised job order whose template has since moved on', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue({
			...buildJobOrder(206),
			matchCriteria: {
				version: 1,
				templateHash: 'from-an-older-template',
				criteria: [{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 100, options: {} }]
			}
		});
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(65)]);

		const response = await jobOrderMatches(
			new Request('http://localhost/api/job-orders/206/matches'),
			{ params: Promise.resolve({ id: '206' }) }
		);

		expect((await response.json()).templateDrifted).toBe(true);
	});

	it('bounds the candidate scan instead of reading the whole division', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(207));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(66)]);

		await jobOrderMatches(new Request('http://localhost/api/job-orders/207/matches'), {
			params: Promise.resolve({ id: '207' })
		});

		expect(prismaMock.candidate.findMany.mock.calls[0][0].take).toBe(500);
	});

	it('does not serve a cached list after the criteria have changed', async () => {
		prismaMock.jobOrder.findFirst.mockResolvedValue(buildJobOrder(208));
		prismaMock.skill.findMany.mockResolvedValue(SKILLS);
		prismaMock.candidate.findMany.mockResolvedValue([buildCandidate(67)]);

		const first = await jobOrderMatches(new Request('http://localhost/api/job-orders/208/matches'), {
			params: Promise.resolve({ id: '208' })
		});
		const firstScore = (await first.json()).matches[0].scorePercent;

		// Re-weight the template so location alone decides the score.
		getMatchCriteriaTemplate.mockResolvedValue([
			{ key: 'location', label: 'Location', evaluatorKey: 'location', weight: 100, options: {} }
		]);
		const second = await jobOrderMatches(new Request('http://localhost/api/job-orders/208/matches'), {
			params: Promise.resolve({ id: '208' })
		});
		const secondPayload = await second.json();

		expect(secondPayload.criteria.map((criterion) => criterion.key)).toEqual(['location']);
		expect(secondPayload.matches[0].scorePercent).not.toBe(firstScore);
	});
});
