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

import { getActingUser } from '@/lib/access-control';
import { consumeRequestThrottle } from '@/lib/request-throttle';
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
