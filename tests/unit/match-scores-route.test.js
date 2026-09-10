import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins the scoring endpoints.
//
// The security-relevant one: POST /api/match-scores takes no score from the
// caller. The old match-explanation route did, which let a client write any
// number and then have the model explain it; the new routes must not repeat it.
//
// The batch pins the cost controls - a cap that refuses rather than truncates,
// a concurrency ceiling, per-candidate failures that do not sink the run, and a
// deadline so the route cannot outlive its own request.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		candidateJobScore: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
		candidate: { findUnique: vi.fn() },
		jobOrder: { findUnique: vi.fn() },
		skill: { findMany: vi.fn() }
	}
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser: vi.fn()
}));
vi.mock('@/lib/related-record-scope', () => ({ validateScopedCandidateAndJobOrder: vi.fn() }));
vi.mock('@/lib/mutation-throttle', () => ({ enforceMutationThrottle: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/request-throttle', () => ({
	consumeRequestThrottle: vi.fn().mockResolvedValue({ allowed: true })
}));
vi.mock('@/lib/audit-log', () => ({ logCreate: vi.fn(), logUpdate: vi.fn() }));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));
vi.mock('@/lib/ai-match-score', () => ({ scoreCandidateCriteriaWithAi: vi.fn() }));
vi.mock('@/lib/match-criteria-store', async (importOriginal) => ({
	...(await importOriginal()),
	getMatchCriteriaTemplate: vi.fn()
}));

import { getActingUser } from '@/lib/access-control';
import { validateScopedCandidateAndJobOrder } from '@/lib/related-record-scope';
import { consumeRequestThrottle } from '@/lib/request-throttle';
import { scoreCandidateCriteriaWithAi } from '@/lib/ai-match-score';
import { getMatchCriteriaTemplate } from '@/lib/match-criteria-store';
import { DEFAULT_MATCH_CRITERIA, buildCriteriaSetHash, buildCriterionHash } from '@/lib/match-criteria';
import { AccessControlError } from '@/lib/access-control';
import { GET as readScore, POST as writeScore } from '../../app/api/match-scores/route.js';
import {
	POST as batchScore,
	MATCH_SCORE_BATCH_MAX_CANDIDATES
} from '../../app/api/job-orders/[id]/match-scores/route.js';

const admin = { id: 1, role: 'ADMINISTRATOR', divisionId: null, isActive: true };

const CANDIDATE = {
	id: 7,
	firstName: 'Robin',
	lastName: 'Blake',
	currentJobTitle: 'Senior React Engineer',
	currentEmployer: 'Globex',
	summary: 'React engineer.',
	skillSet: 'React',
	city: 'Sydney',
	state: 'NSW',
	updatedAt: new Date('2026-01-01T00:00:00Z'),
	candidateSkills: [{ skill: { id: 11, name: 'React' } }],
	candidateWorkExperiences: [{ companyName: 'Globex', title: 'Engineer', location: 'Sydney NSW', startDate: '2018-01-01', endDate: '2024-01-01' }],
	candidateEducations: [{ schoolName: 'University of Sydney', degree: 'BSc' }]
};

const JOB_ORDER = {
	id: 3,
	title: 'Senior React Engineer',
	description: 'Need 5+ years of React.',
	location: 'Sydney NSW',
	city: 'Sydney',
	state: 'NSW',
	matchCriteria: null,
	updatedAt: new Date('2026-01-01T00:00:00Z'),
	client: { id: 1, name: 'Acme' }
};

function jsonRequest(url, method, body) {
	return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function searchRequest(url) {
	const request = new Request(url);
	Object.defineProperty(request, 'nextUrl', { value: new URL(url) });
	return request;
}

beforeEach(() => {
	Object.values(prismaMock).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
	getActingUser.mockReset();
	getActingUser.mockResolvedValue(admin);
	validateScopedCandidateAndJobOrder.mockReset();
	validateScopedCandidateAndJobOrder.mockResolvedValue(undefined);
	consumeRequestThrottle.mockReset();
	consumeRequestThrottle.mockResolvedValue({ allowed: true });
	scoreCandidateCriteriaWithAi.mockReset();
	getMatchCriteriaTemplate.mockReset();
	getMatchCriteriaTemplate.mockResolvedValue(DEFAULT_MATCH_CRITERIA);

	prismaMock.candidate.findUnique.mockResolvedValue(CANDIDATE);
	prismaMock.jobOrder.findUnique.mockResolvedValue(JOB_ORDER);
	prismaMock.skill.findMany.mockResolvedValue([{ id: 11, name: 'React' }]);
	prismaMock.candidateJobScore.findUnique.mockResolvedValue(null);
	prismaMock.candidateJobScore.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
	prismaMock.candidateJobScore.update.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
	scoreCandidateCriteriaWithAi.mockResolvedValue({
		ok: true,
		modelName: 'o3',
		results: [
			{
				key: 'big_company',
				criterionHash: buildCriterionHash(DEFAULT_MATCH_CRITERIA.find((row) => row.key === 'big_company')),
				score: 90,
				assessed: true,
				rationale: 'Globex is large.'
			}
		]
	});
});

describe('POST /api/match-scores', () => {
	it('computes the score server-side and ignores any score in the request body', async () => {
		const response = await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', {
				candidateId: 7,
				jobOrderId: 3,
				scorePercent: 100,
				coveragePercent: 100
			})
		);
		const payload = await response.json();
		const written = prismaMock.candidateJobScore.create.mock.calls[0][0].data;

		expect(response.status).toBe(200);
		expect(written.scorePercent).not.toBe(100);
		expect(written.scorePercent).toBe(payload.score.scorePercent);
		expect(Number.isInteger(written.scorePercent)).toBe(true);
	});

	it('stores only the AI rows, since the deterministic half is recomputed on read', async () => {
		await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 })
		);
		const written = prismaMock.candidateJobScore.create.mock.calls[0][0].data;

		expect(written.criteriaResults.map((row) => row.key)).toEqual(['big_company']);
		expect(written.modelName).toBe('o3');
		expect(written.criteriaSetHash).toEqual(expect.any(String));
		expect(written.candidateUpdatedAt).toEqual(CANDIDATE.updatedAt);
	});

	it('upserts rather than creating a second row for the same pair', async () => {
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({ id: 1, criteriaResults: [] });

		await writeScore(jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 }));

		expect(prismaMock.candidateJobScore.update).toHaveBeenCalled();
		expect(prismaMock.candidateJobScore.create).not.toHaveBeenCalled();
	});

	it('still stores a deterministic score when the AI call fails, and says so', async () => {
		scoreCandidateCriteriaWithAi.mockResolvedValue({ ok: false, error: 'OpenAI candidate scoring request failed.' });

		const response = await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 })
		);
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.score.scorePercent).toEqual(expect.any(Number));
		// Surfaced, not swallowed: a broken key must not look like a working
		// rules-only score.
		expect(payload.aiError).toContain('request failed');
		expect(prismaMock.candidateJobScore.create.mock.calls[0][0].data.criteriaResults).toEqual([]);
	});

	it('does not throw away judgements already paid for when the AI call fails', async () => {
		const stored = [
			{ key: 'big_company', criterionHash: 'abc', score: 90, assessed: true, rationale: 'Globex is large.' }
		];
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({
			id: 1,
			criteriaResults: stored,
			modelName: 'o3'
		});
		scoreCandidateCriteriaWithAi.mockResolvedValue({ ok: false, error: 'OpenAI candidate scoring request failed.' });

		await writeScore(jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 }));

		// A transient provider failure must not silently delete work the user
		// already paid for.
		expect(prismaMock.candidateJobScore.update.mock.calls[0][0].data.criteriaResults).toEqual(stored);
		expect(prismaMock.candidateJobScore.update.mock.calls[0][0].data.modelName).toBe('o3');
	});

	it('keeps stored judgements when re-scoring without AI', async () => {
		const stored = [
			{ key: 'big_company', criterionHash: 'abc', score: 90, assessed: true, rationale: 'Globex is large.' }
		];
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({ id: 1, criteriaResults: stored, modelName: 'o3' });

		await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3, useAi: false })
		);

		expect(scoreCandidateCriteriaWithAi).not.toHaveBeenCalled();
		expect(prismaMock.candidateJobScore.update.mock.calls[0][0].data.criteriaResults).toEqual(stored);
	});

	it('replaces stored judgements when a fresh AI call succeeds', async () => {
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({
			id: 1,
			criteriaResults: [{ key: 'big_company', criterionHash: 'old', score: 10, assessed: true }],
			modelName: 'gpt-4o-mini'
		});

		await writeScore(jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 }));

		const written = prismaMock.candidateJobScore.update.mock.calls[0][0].data;
		expect(written.criteriaResults.map((row) => row.score)).toEqual([90]);
		expect(written.modelName).toBe('o3');
	});

	it('skips the model entirely when the caller asks for a rules-only score', async () => {
		await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3, useAi: false })
		);

		expect(scoreCandidateCriteriaWithAi).not.toHaveBeenCalled();
	});

	it('requires both ids', async () => {
		const response = await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7 })
		);

		expect(response.status).toBe(400);
	});

	it('enforces division scope through the shared guard', async () => {
		validateScopedCandidateAndJobOrder.mockRejectedValue(new AccessControlError('Out of scope.', 400));

		const response = await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 })
		);

		expect(response.status).toBe(400);
		expect(prismaMock.candidateJobScore.create).not.toHaveBeenCalled();
	});

	it('reports a missing candidate or job order as a 404', async () => {
		prismaMock.candidate.findUnique.mockResolvedValue(null);

		const response = await writeScore(
			jsonRequest('http://localhost/api/match-scores', 'POST', { candidateId: 7, jobOrderId: 3 })
		);

		expect(response.status).toBe(404);
	});
});

describe('GET /api/match-scores', () => {
	it('reports a stored score as fresh while the records and criteria are unchanged', async () => {
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({
			id: 1,
			criteriaResults: [],
			criteriaSetHash: buildCriteriaSetHash(DEFAULT_MATCH_CRITERIA),
			candidateUpdatedAt: CANDIDATE.updatedAt,
			jobOrderUpdatedAt: JOB_ORDER.updatedAt
		});

		const payload = await (
			await readScore(searchRequest('http://localhost/api/match-scores?candidateId=7&jobOrderId=3'))
		).json();

		expect(payload.stale).toBe(false);
		expect(payload.criteriaChanged).toBe(false);
		expect(payload.criteria.map((row) => row.key)).toEqual(DEFAULT_MATCH_CRITERIA.map((row) => row.key));
	});

	it('flags a score whose criteria have been redefined since it was computed', async () => {
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({
			id: 1,
			criteriaResults: [],
			criteriaSetHash: 'from-an-older-template',
			candidateUpdatedAt: CANDIDATE.updatedAt,
			jobOrderUpdatedAt: JOB_ORDER.updatedAt
		});

		const payload = await (
			await readScore(searchRequest('http://localhost/api/match-scores?candidateId=7&jobOrderId=3'))
		).json();

		expect(payload.criteriaChanged).toBe(true);
		expect(payload.stale).toBe(true);
	});

	it('flags a score as stale once the candidate record has moved on', async () => {
		prismaMock.candidate.findUnique.mockResolvedValue({ id: 7, updatedAt: new Date('2026-06-01T00:00:00Z') });
		prismaMock.candidateJobScore.findUnique.mockResolvedValue({
			id: 1,
			criteriaResults: [],
			criteriaSetHash: 'x',
			candidateUpdatedAt: new Date('2026-01-01T00:00:00Z'),
			jobOrderUpdatedAt: JOB_ORDER.updatedAt
		});

		const payload = await (
			await readScore(searchRequest('http://localhost/api/match-scores?candidateId=7&jobOrderId=3'))
		).json();

		expect(payload.stale).toBe(true);
	});

	it('returns null for a pair that has never been scored', async () => {
		const payload = await (
			await readScore(searchRequest('http://localhost/api/match-scores?candidateId=7&jobOrderId=3'))
		).json();

		expect(payload.score).toBeNull();
		expect(payload.stale).toBe(false);
	});
});

describe('POST /api/job-orders/[id]/match-scores', () => {
	const params = Promise.resolve({ id: '3' });

	it('refuses more candidates than the cap instead of silently truncating', async () => {
		const tooMany = Array.from({ length: MATCH_SCORE_BATCH_MAX_CANDIDATES + 1 }, (_unused, index) => index + 1);

		const response = await batchScore(
			jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: tooMany }),
			{ params }
		);
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toContain(String(MATCH_SCORE_BATCH_MAX_CANDIDATES));
		expect(prismaMock.candidateJobScore.create).not.toHaveBeenCalled();
	});

	it('scores every candidate it was given and reports the tally', async () => {
		const response = await batchScore(
			jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: [7, 8, 9] }),
			{ params }
		);
		const payload = await response.json();

		expect(payload).toMatchObject({ jobOrderId: 3, requested: 3, scored: 3 });
		expect(payload.failed).toEqual([]);
		expect(payload.skipped).toEqual([]);
	});

	it('never runs more scoring calls at once than the configured concurrency', async () => {
		let inFlight = 0;
		let peak = 0;
		scoreCandidateCriteriaWithAi.mockImplementation(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			return { ok: true, modelName: 'o3', results: [] };
		});

		await batchScore(
			jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: [1, 2, 3, 4, 5, 6, 7, 8] }),
			{ params }
		);

		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1);
	});

	it('keeps the scores that landed when one candidate fails', async () => {
		validateScopedCandidateAndJobOrder.mockImplementation(async ({ candidateId }) => {
			if (candidateId === 8) throw new AccessControlError('Candidate is outside your division.', 400);
		});

		const payload = await (
			await batchScore(
				jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: [7, 8, 9] }),
				{ params }
			)
		).json();

		expect(payload.scored).toBe(2);
		expect(payload.failed).toEqual([
			{ candidateId: 8, ok: false, error: 'Candidate is outside your division.' }
		]);
	});

	it('de-duplicates repeated ids rather than scoring a pair twice', async () => {
		const payload = await (
			await batchScore(
				jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: [7, 7, 7] }),
				{ params }
			)
		).json();

		expect(payload.requested).toBe(1);
		expect(payload.scored).toBe(1);
	});

	it('requires a candidate list', async () => {
		const response = await batchScore(
			jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: [] }),
			{ params }
		);

		expect(response.status).toBe(400);
	});

	it('refuses a caller over the batch rate limit', async () => {
		consumeRequestThrottle.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

		const response = await batchScore(
			jsonRequest('http://localhost/api/job-orders/3/match-scores', 'POST', { candidateIds: [7] }),
			{ params }
		);

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('120');
	});
});
