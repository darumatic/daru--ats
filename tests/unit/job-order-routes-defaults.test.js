import { describe, it, expect, vi, beforeEach } from 'vitest';

// Exercises the job-order create/update handlers with a fake Prisma client:
// creating a job with only title/status/zip must file it under the division's
// "Unassigned" placeholder client and default the owner to the creator, and
// saving an existing job without assignment ids must carry the stored
// client/contact/owner/division over untouched (no re-validation).

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		client: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
		contact: { findUnique: vi.fn() },
		user: { findUnique: vi.fn() },
		division: { upsert: vi.fn(), findUnique: vi.fn() },
		jobOrder: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() }
	}
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser: vi.fn()
}));
vi.mock('@/lib/system-settings', () => ({
	getSystemSettingRecord: vi.fn().mockResolvedValue({ careerSiteEnabled: false })
}));
vi.mock('@/lib/mutation-throttle', () => ({ enforceMutationThrottle: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/audit-log', () => ({ logCreate: vi.fn(), logUpdate: vi.fn() }));
vi.mock('@/lib/notifications', () => ({ createOwnerAssignmentNotifications: vi.fn() }));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));
vi.mock('@/lib/custom-fields', () => ({
	validateAndNormalizeCustomFieldValues: vi.fn(async ({ customFieldsInput }) => ({
		errors: [],
		customFields: customFieldsInput ?? null
	}))
}));
vi.mock('@/lib/zip-code-lookup', () => ({ withInferredCityStateFromZip: vi.fn(async (_db, input) => input) }));

import { getActingUser } from '@/lib/access-control';
import { POST as createJobOrder } from '../../app/api/job-orders/route.js';
import { PATCH as updateJobOrder } from '../../app/api/job-orders/[id]/route.js';

const UNASSIGNED_DIVISION = { id: 1, name: 'Unassigned', accessMode: 'COLLABORATIVE' };
const SALES_DIVISION = { id: 7, name: 'Sales', accessMode: 'COLLABORATIVE' };

const admin = { id: 1, role: 'ADMINISTRATOR', divisionId: 1, division: UNASSIGNED_DIVISION, isActive: true };
const adminWithoutDivision = { id: 2, role: 'ADMINISTRATOR', divisionId: null, division: null, isActive: true };
const recruiter = { id: 3, role: 'RECRUITER', divisionId: 7, division: SALES_DIVISION, isActive: true };

const MINIMAL_BODY = { title: 'Backend Engineer', zipCode: '2000', status: 'open' };

function jsonRequest(url, method, body) {
	return new Request(url, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

function primeLookups({ owner, division, client }) {
	prismaMock.user.findUnique.mockResolvedValue(owner);
	prismaMock.division.findUnique.mockResolvedValue(division);
	prismaMock.client.findUnique.mockResolvedValue(client);
}

beforeEach(() => {
	Object.values(prismaMock).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
	getActingUser.mockReset();
	prismaMock.jobOrder.create.mockImplementation(async ({ data }) => ({ id: 99, ...data }));
	prismaMock.jobOrder.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
});

describe('POST /api/job-orders without client/contact/owner/division', () => {
	it('files an administrator\'s job under the Unassigned client in their division and makes them the owner', async () => {
		getActingUser.mockResolvedValue(admin);
		prismaMock.client.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 50, divisionId: 1 });
		prismaMock.client.create.mockResolvedValue({ id: 50, divisionId: 1 });
		primeLookups({
			owner: { id: 1, isActive: true, role: 'ADMINISTRATOR', divisionId: 1 },
			division: UNASSIGNED_DIVISION,
			client: { id: 50, divisionId: 1 }
		});

		const response = await createJobOrder(jsonRequest('http://localhost/api/job-orders', 'POST', MINIMAL_BODY));

		expect(response.status).toBe(201);
		expect(prismaMock.client.create).toHaveBeenCalledTimes(1);
		expect(prismaMock.client.create.mock.calls[0][0].data).toMatchObject({ name: 'Unassigned', divisionId: 1, ownerId: null });
		expect(prismaMock.jobOrder.create.mock.calls[0][0].data).toMatchObject({
			title: 'Backend Engineer',
			clientId: 50,
			contactId: null,
			ownerId: 1,
			divisionId: 1
		});
		expect(prismaMock.division.upsert).not.toHaveBeenCalled();
	});

	it('reuses the division\'s existing placeholder client for a recruiter and owns the job to them', async () => {
		getActingUser.mockResolvedValue(recruiter);
		prismaMock.client.findFirst.mockResolvedValue({ id: 60, divisionId: 7 });
		primeLookups({
			owner: { id: 3, isActive: true, role: 'RECRUITER', divisionId: 7 },
			division: SALES_DIVISION,
			client: { id: 60, divisionId: 7 }
		});

		const response = await createJobOrder(jsonRequest('http://localhost/api/job-orders', 'POST', MINIMAL_BODY));

		expect(response.status).toBe(201);
		expect(prismaMock.client.create).not.toHaveBeenCalled();
		expect(prismaMock.client.findFirst.mock.calls[0][0].where).toEqual({ name: 'Unassigned', divisionId: 7 });
		expect(prismaMock.jobOrder.create.mock.calls[0][0].data).toMatchObject({ clientId: 60, ownerId: 3, divisionId: 7, contactId: null });
	});

	it('falls back to the Unassigned division and a blank owner for an administrator without a division', async () => {
		getActingUser.mockResolvedValue(adminWithoutDivision);
		prismaMock.division.upsert.mockResolvedValue(UNASSIGNED_DIVISION);
		prismaMock.client.findFirst.mockResolvedValue({ id: 50, divisionId: 1 });
		primeLookups({ owner: null, division: UNASSIGNED_DIVISION, client: { id: 50, divisionId: 1 } });

		const response = await createJobOrder(jsonRequest('http://localhost/api/job-orders', 'POST', MINIMAL_BODY));

		expect(response.status).toBe(201);
		expect(prismaMock.division.upsert).toHaveBeenCalledTimes(1);
		expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
		expect(prismaMock.jobOrder.create.mock.calls[0][0].data).toMatchObject({ clientId: 50, ownerId: null, divisionId: 1 });
	});

	it('still honours a client and contact prefilled from a client/contact record', async () => {
		getActingUser.mockResolvedValue(recruiter);
		prismaMock.contact.findUnique.mockResolvedValue({ id: 20, clientId: 10, divisionId: 7 });
		primeLookups({
			owner: { id: 3, isActive: true, role: 'RECRUITER', divisionId: 7 },
			division: SALES_DIVISION,
			client: { id: 10, divisionId: 7 }
		});

		const response = await createJobOrder(
			jsonRequest('http://localhost/api/job-orders', 'POST', { ...MINIMAL_BODY, clientId: '10', contactId: '20' })
		);

		expect(response.status).toBe(201);
		expect(prismaMock.client.findFirst).not.toHaveBeenCalled();
		expect(prismaMock.jobOrder.create.mock.calls[0][0].data).toMatchObject({ clientId: 10, contactId: 20, ownerId: 3, divisionId: 7 });
	});
});

describe('PATCH /api/job-orders/[id] without assignment ids', () => {
	const existing = {
		id: 5,
		title: 'Legacy role',
		zipCode: '2000',
		status: 'open',
		publishToCareerSite: false,
		customFields: null,
		applicationQuestions: [],
		clientId: 10,
		contactId: 20,
		ownerId: 30,
		divisionId: 40
	};
	const params = Promise.resolve({ id: '5' });

	it('keeps the stored client, contact, owner and division without re-validating them', async () => {
		getActingUser.mockResolvedValue(admin);
		prismaMock.jobOrder.findFirst.mockResolvedValue(existing);

		const response = await updateJobOrder(
			jsonRequest('http://localhost/api/job-orders/5', 'PATCH', { ...MINIMAL_BODY, title: 'Renamed role', employmentType: 'Permanent' }),
			{ params }
		);

		expect(response.status).toBe(200);
		expect(prismaMock.client.findUnique).not.toHaveBeenCalled();
		expect(prismaMock.contact.findUnique).not.toHaveBeenCalled();
		expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
		expect(prismaMock.jobOrder.update.mock.calls[0][0].data).toMatchObject({
			title: 'Renamed role',
			clientId: 10,
			contactId: 20,
			ownerId: 30,
			divisionId: 40
		});
	});

	it('re-validates and re-derives the division when an API caller changes the client', async () => {
		getActingUser.mockResolvedValue(admin);
		prismaMock.jobOrder.findFirst.mockResolvedValue(existing);
		prismaMock.contact.findUnique.mockResolvedValue({ id: 20, clientId: 11, divisionId: 40 });
		primeLookups({
			owner: { id: 30, isActive: true, role: 'RECRUITER', divisionId: 40 },
			division: { id: 40, name: 'Ops', accessMode: 'COLLABORATIVE' },
			client: { id: 11, divisionId: 40 }
		});

		const response = await updateJobOrder(
			jsonRequest('http://localhost/api/job-orders/5', 'PATCH', { ...MINIMAL_BODY, clientId: 11 }),
			{ params }
		);

		expect(response.status).toBe(200);
		expect(prismaMock.client.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 11 } }));
		expect(prismaMock.jobOrder.update.mock.calls[0][0].data).toMatchObject({ clientId: 11, contactId: 20, ownerId: 30, divisionId: 40 });
	});
});
