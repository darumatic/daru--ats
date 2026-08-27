import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drives PATCH /api/submissions/[id]/status (the job-order pipeline board's
// drag-and-drop move) against a fake Prisma client: scoped lookup, status-only
// update with audit, no-op on the same stage, and the two refusals — a
// submission locked by a placement (409) and `placed` as a drop target (400).

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		submission: { findFirst: vi.fn(), update: vi.fn() }
	}
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser: vi.fn()
}));
vi.mock('@/lib/mutation-throttle', () => ({ enforceMutationThrottle: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/audit-log', () => ({ logUpdate: vi.fn() }));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));

import { addScopeToWhere, getActingUser } from '@/lib/access-control';
import { getCandidateJobOrderScope } from '@/lib/related-record-scope';
import { logUpdate } from '@/lib/audit-log';
import { PATCH as patchStatus } from '../../app/api/submissions/[id]/status/route.js';

const recruiter = { id: 4, role: 'RECRUITER', divisionId: 2, division: { id: 2, accessMode: 'COLLABORATIVE' } };
const UPDATED_AT = new Date('2026-08-27T09:00:00Z');

function request(id, body) {
	return new Request(`http://localhost/api/submissions/${id}/status`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

function call(id, body) {
	return patchStatus(request(id, body), { params: Promise.resolve({ id: String(id) }) });
}

function existingSubmission(overrides = {}) {
	return {
		id: 12,
		status: 'submitted',
		updatedAt: new Date('2026-08-20T09:00:00Z'),
		candidateId: 7,
		jobOrderId: 3,
		offer: null,
		...overrides
	};
}

beforeEach(() => {
	prismaMock.submission.findFirst.mockReset();
	prismaMock.submission.update.mockReset();
	logUpdate.mockReset();
	getActingUser.mockReset();
	getActingUser.mockResolvedValue(recruiter);
	prismaMock.submission.update.mockImplementation(async ({ where, data }) => ({
		id: where.id,
		status: data.status,
		updatedAt: UPDATED_AT
	}));
});

describe('PATCH /api/submissions/[id]/status', () => {
	it('moves an in-scope submission to the new stage and audit-logs only the status change', async () => {
		prismaMock.submission.findFirst.mockResolvedValue(existingSubmission());

		const response = await call(12, { status: 'qualified' });
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ id: 12, status: 'qualified', updatedAt: UPDATED_AT.toISOString() });
		expect(prismaMock.submission.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: addScopeToWhere({ id: 12 }, getCandidateJobOrderScope(recruiter)) })
		);
		expect(prismaMock.submission.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: 12 }, data: { status: 'qualified' } })
		);
		expect(logUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				actorUserId: recruiter.id,
				entityType: 'SUBMISSION',
				before: expect.objectContaining({ id: 12, status: 'submitted' }),
				after: expect.objectContaining({ id: 12, status: 'qualified' })
			})
		);
	});

	it('is a no-op when the submission is already in that stage', async () => {
		prismaMock.submission.findFirst.mockResolvedValue(existingSubmission({ status: 'under_review' }));

		const response = await call(12, { status: 'under_review' });
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.status).toBe('under_review');
		expect(prismaMock.submission.update).not.toHaveBeenCalled();
		expect(logUpdate).not.toHaveBeenCalled();
	});

	it('refuses to move a submission that already has a placement', async () => {
		prismaMock.submission.findFirst.mockResolvedValue(existingSubmission({ status: 'placed', offer: { id: 5 } }));

		const response = await call(12, { status: 'qualified' });
		const payload = await response.json();

		expect(response.status).toBe(409);
		expect(payload.error).toMatch(/locked/i);
		expect(prismaMock.submission.update).not.toHaveBeenCalled();
	});

	it('refuses `placed` as a drop target and points at Convert to Placement', async () => {
		prismaMock.submission.findFirst.mockResolvedValue(existingSubmission({ status: 'hired' }));

		const response = await call(12, { status: 'placed' });
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toMatch(/Convert to Placement/);
		expect(prismaMock.submission.update).not.toHaveBeenCalled();
	});

	it('rejects an unknown stage', async () => {
		prismaMock.submission.findFirst.mockResolvedValue(existingSubmission());

		const response = await call(12, { status: 'interviewing' });

		expect(response.status).toBe(400);
		expect((await response.json()).errors).toBeTruthy();
		expect(prismaMock.submission.update).not.toHaveBeenCalled();
	});

	it('returns 404 when the submission is outside the acting user scope', async () => {
		prismaMock.submission.findFirst.mockResolvedValue(null);

		const response = await call(12, { status: 'qualified' });

		expect(response.status).toBe(404);
		expect(prismaMock.submission.update).not.toHaveBeenCalled();
	});

	it('rejects a non-numeric route id', async () => {
		const response = await patchStatus(request('abc', { status: 'qualified' }), {
			params: Promise.resolve({ id: 'abc' })
		});

		expect(response.status).toBe(400);
		expect(prismaMock.submission.findFirst).not.toHaveBeenCalled();
	});
});
