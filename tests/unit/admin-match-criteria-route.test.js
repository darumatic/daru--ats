import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins the admin surface for the scoring template: who may change it, that a
// partial edit still has to produce a criterion the engine can score with, and
// that removing one is a soft delete - stored breakdowns name the criteria they
// were computed against, so a hard delete would leave them dangling.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		matchCriterion: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			count: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn()
		}
	}
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser: vi.fn(),
	hasAdministrator: vi.fn()
}));
vi.mock('@/lib/mutation-throttle', () => ({ enforceMutationThrottle: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/audit-log', () => ({ logCreate: vi.fn(), logUpdate: vi.fn(), logDelete: vi.fn() }));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));

import { getActingUser, hasAdministrator } from '@/lib/access-control';
import { logUpdate } from '@/lib/audit-log';
import { GET as listCriteria, POST as createCriterion } from '../../app/api/admin/match-criteria/route.js';
import {
	PATCH as updateCriterion,
	DELETE as removeCriterion
} from '../../app/api/admin/match-criteria/[id]/route.js';

const admin = { id: 1, role: 'ADMINISTRATOR', isActive: true };
const recruiter = { id: 2, role: 'RECRUITER', isActive: true };

const STORED = {
	id: 5,
	recordId: 'MCR-AAAAAAAA',
	key: 'big_company',
	label: 'Big Company',
	description: null,
	evaluatorKey: 'big_company',
	weight: 15,
	aiEnabled: true,
	isActive: true,
	sortOrder: 40,
	options: { referenceValues: [] }
};

function jsonRequest(url, method, body) {
	return new Request(url, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

function listRequest(url) {
	const request = new Request(url);
	// The collection route reads searchParams through nextUrl.
	Object.defineProperty(request, 'nextUrl', { value: new URL(url) });
	return request;
}

beforeEach(() => {
	Object.values(prismaMock).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
	getActingUser.mockReset();
	hasAdministrator.mockReset();
	hasAdministrator.mockResolvedValue(true);
	getActingUser.mockResolvedValue(admin);
	logUpdate.mockClear();
	prismaMock.matchCriterion.count.mockResolvedValue(5);
	prismaMock.matchCriterion.update.mockImplementation(async ({ where, data }) => ({ ...STORED, ...data, id: where.id }));
	prismaMock.matchCriterion.create.mockImplementation(async ({ data }) => ({ ...data, id: 9 }));
});

describe('GET /api/admin/match-criteria', () => {
	it('returns the active criteria to an administrator', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValue([STORED]);

		const response = await listCriteria(listRequest('http://localhost/api/admin/match-criteria'));
		const rows = await response.json();

		expect(response.status).toBe(200);
		expect(rows[0]).toMatchObject({ key: 'big_company', weight: 15 });
		expect(prismaMock.matchCriterion.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
	});

	it('includes soft-deleted criteria when asked, so they can be restored', async () => {
		prismaMock.matchCriterion.findMany.mockResolvedValue([{ ...STORED, isActive: false }]);

		await listCriteria(listRequest('http://localhost/api/admin/match-criteria?includeInactive=true'));

		expect(prismaMock.matchCriterion.findMany.mock.calls[0][0].where).toEqual({});
	});

	it('refuses a non-administrator', async () => {
		getActingUser.mockResolvedValue(recruiter);

		const response = await listCriteria(listRequest('http://localhost/api/admin/match-criteria'));

		expect(response.status).toBe(403);
	});

	it('stays open while no administrator exists, so a fresh install can be set up', async () => {
		hasAdministrator.mockResolvedValue(false);
		getActingUser.mockResolvedValue(recruiter);
		prismaMock.matchCriterion.findMany.mockResolvedValue([STORED]);

		const response = await listCriteria(listRequest('http://localhost/api/admin/match-criteria'));

		expect(response.status).toBe(200);
	});
});

describe('POST /api/admin/match-criteria', () => {
	it('creates a criterion and files it after the existing ones', async () => {
		prismaMock.matchCriterion.findFirst.mockResolvedValue({ sortOrder: 50 });

		const response = await createCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria', 'POST', {
				key: 'security_clearance',
				label: 'Security Clearance',
				evaluatorKey: 'ai',
				weight: 25
			})
		);

		// `ai` is not a registered evaluator; the set of valid keys is closed.
		expect(response.status).toBe(400);
	});

	it('accepts a criterion naming a registered evaluator', async () => {
		prismaMock.matchCriterion.findFirst.mockResolvedValue({ sortOrder: 50 });

		const response = await createCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria', 'POST', {
				key: 'tenure',
				label: 'Tenure',
				evaluatorKey: 'experience_years',
				weight: 25
			})
		);

		expect(response.status).toBe(201);
		expect(prismaMock.matchCriterion.create.mock.calls[0][0].data).toMatchObject({
			key: 'tenure',
			evaluatorKey: 'experience_years',
			weight: 25,
			sortOrder: 60
		});
	});

	it('rejects a duplicate key with a 409 rather than a 500', async () => {
		prismaMock.matchCriterion.findFirst.mockResolvedValue(null);
		prismaMock.matchCriterion.create.mockRejectedValue(Object.assign(new Error('dupe'), { code: 'P2002' }));

		const response = await createCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria', 'POST', {
				key: 'location',
				label: 'Location',
				evaluatorKey: 'location',
				weight: 20
			})
		);

		expect(response.status).toBe(409);
	});

	it('refuses a non-administrator', async () => {
		getActingUser.mockResolvedValue(recruiter);

		const response = await createCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria', 'POST', {
				key: 'tenure',
				label: 'Tenure',
				evaluatorKey: 'experience_years',
				weight: 25
			})
		);

		expect(response.status).toBe(403);
		expect(prismaMock.matchCriterion.create).not.toHaveBeenCalled();
	});
});

describe('PATCH /api/admin/match-criteria/[id]', () => {
	it('applies a partial edit on top of the stored row', async () => {
		prismaMock.matchCriterion.findUnique.mockResolvedValue(STORED);

		const response = await updateCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria/5', 'PATCH', { weight: 35 }),
			{ params: Promise.resolve({ id: '5' }) }
		);

		expect(response.status).toBe(200);
		expect(prismaMock.matchCriterion.update.mock.calls[0][0].data).toMatchObject({
			key: 'big_company',
			evaluatorKey: 'big_company',
			weight: 35
		});
	});

	it('validates the merged row, not just the patch', async () => {
		prismaMock.matchCriterion.findUnique.mockResolvedValue(STORED);

		const response = await updateCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria/5', 'PATCH', { weight: 0 }),
			{ params: Promise.resolve({ id: '5' }) }
		);

		expect(response.status).toBe(400);
		expect(prismaMock.matchCriterion.update).not.toHaveBeenCalled();
	});

	it('stores an employer list against the criterion that uses it', async () => {
		prismaMock.matchCriterion.findUnique.mockResolvedValue(STORED);

		await updateCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria/5', 'PATCH', {
				options: { referenceValues: ['Atlassian', 'Canva'] }
			}),
			{ params: Promise.resolve({ id: '5' }) }
		);

		expect(prismaMock.matchCriterion.update.mock.calls[0][0].data.options).toEqual({
			referenceValues: ['Atlassian', 'Canva']
		});
	});

	it('reports a missing criterion as a 404', async () => {
		prismaMock.matchCriterion.findUnique.mockResolvedValue(null);

		const response = await updateCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria/99', 'PATCH', { weight: 20 }),
			{ params: Promise.resolve({ id: '99' }) }
		);

		expect(response.status).toBe(404);
	});

	it('refuses a non-administrator', async () => {
		getActingUser.mockResolvedValue(recruiter);

		const response = await updateCriterion(
			jsonRequest('http://localhost/api/admin/match-criteria/5', 'PATCH', { weight: 35 }),
			{ params: Promise.resolve({ id: '5' }) }
		);

		expect(response.status).toBe(403);
		expect(prismaMock.matchCriterion.update).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/admin/match-criteria/[id]', () => {
	it('deactivates the criterion instead of deleting the row', async () => {
		prismaMock.matchCriterion.findUnique.mockResolvedValue(STORED);

		const response = await removeCriterion(
			new Request('http://localhost/api/admin/match-criteria/5', { method: 'DELETE' }),
			{ params: Promise.resolve({ id: '5' }) }
		);

		expect(response.status).toBe(200);
		expect(prismaMock.matchCriterion.delete).not.toHaveBeenCalled();
		expect(prismaMock.matchCriterion.update.mock.calls[0][0]).toMatchObject({
			where: { id: 5 },
			data: { isActive: false }
		});
		expect(logUpdate.mock.calls[0][0].metadata).toEqual({ softDeleted: true });
	});

	it('refuses a non-administrator', async () => {
		getActingUser.mockResolvedValue(recruiter);

		const response = await removeCriterion(
			new Request('http://localhost/api/admin/match-criteria/5', { method: 'DELETE' }),
			{ params: Promise.resolve({ id: '5' }) }
		);

		expect(response.status).toBe(403);
		expect(prismaMock.matchCriterion.update).not.toHaveBeenCalled();
	});
});
