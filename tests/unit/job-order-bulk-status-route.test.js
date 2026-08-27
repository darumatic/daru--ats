import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// Drives PATCH /api/job-orders/bulk-status (the list view's "Close Selected")
// against a fake Prisma client: scoped lookup, per-record audit, skipped
// no-ops, out-of-scope ids reported as missing, and payload limits.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: {
		jobOrder: { findMany: vi.fn(), update: vi.fn() }
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

import { getActingUser } from '@/lib/access-control';
import { logUpdate } from '@/lib/audit-log';
import { PATCH as bulkStatus, BULK_STATUS_MAX_IDS } from '../../app/api/job-orders/bulk-status/route.js';

const director = { id: 6, role: 'DIRECTOR', divisionId: 2, division: { id: 2, accessMode: 'COLLABORATIVE' } };

function request(body) {
	return new Request('http://localhost/api/job-orders/bulk-status', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

beforeEach(() => {
	prismaMock.jobOrder.findMany.mockReset();
	prismaMock.jobOrder.update.mockReset();
	logUpdate.mockReset();
	getActingUser.mockReset();
	getActingUser.mockResolvedValue(director);
	prismaMock.jobOrder.update.mockImplementation(async ({ where, data }) => ({
		id: where.id,
		status: data.status,
		updatedAt: new Date('2026-08-27T00:00:00Z'),
		closedAt: data.closedAt
	}));
});

describe('PATCH /api/job-orders/bulk-status', () => {
	it('closes the open job orders in scope, skips closed ones and reports ids it cannot see', async () => {
		prismaMock.jobOrder.findMany.mockResolvedValue([
			{ id: 1, status: 'open', title: 'A' },
			{ id: 2, status: 'closed', title: 'B' },
			{ id: 3, status: 'on_hold', title: 'C' }
		]);

		const response = await bulkStatus(request({ ids: [1, '2', 3, 3, 44], status: 'Closed' }));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(prismaMock.jobOrder.findMany.mock.calls[0][0].where).toEqual({
			AND: [{ divisionId: 2 }, { id: { in: [1, 2, 3, 44] } }]
		});
		expect(payload.status).toBe('closed');
		expect(payload.updated.map((item) => item.id)).toEqual([1, 3]);
		expect(payload.updated.every((item) => item.status === 'closed' && item.closedAt)).toBe(true);
		expect(payload.skipped).toEqual([2]);
		expect(payload.missing).toEqual([44]);
		expect(prismaMock.jobOrder.update).toHaveBeenCalledTimes(2);
		expect(logUpdate).toHaveBeenCalledTimes(2);
		expect(logUpdate.mock.calls[0][0]).toMatchObject({ actorUserId: 6, entityType: 'JOB_ORDER', before: { id: 1 } });
	});

	it('rejects an empty selection, too many ids and unknown statuses', async () => {
		const empty = await bulkStatus(request({ ids: [], status: 'closed' }));
		expect(empty.status).toBe(400);
		expect((await empty.json()).error).toBe('Select at least one job order.');

		const tooMany = await bulkStatus(
			request({ ids: Array.from({ length: BULK_STATUS_MAX_IDS + 1 }, (_, index) => index + 1), status: 'closed' })
		);
		expect(tooMany.status).toBe(400);

		const badStatus = await bulkStatus(request({ ids: [1], status: 'nope' }));
		expect(badStatus.status).toBe(400);
		expect(prismaMock.jobOrder.findMany).not.toHaveBeenCalled();
	});

	it('returns nothing but missing ids when no selected record is in scope', async () => {
		prismaMock.jobOrder.findMany.mockResolvedValue([]);

		const response = await bulkStatus(request({ ids: [7, 8], status: 'closed' }));

		expect(await response.json()).toEqual({ status: 'closed', updated: [], skipped: [], missing: [7, 8] });
		expect(prismaMock.jobOrder.update).not.toHaveBeenCalled();
	});
});

describe('job-order list wiring', () => {
	const listPage = readFileSync(new URL('../../app/job-orders/page.js', import.meta.url), 'utf8');
	const table = readFileSync(new URL('../../app/components/entity-table.js', import.meta.url), 'utf8');

	it('the list page uses the bulk endpoint and passes a selection to EntityTable', () => {
		expect(listPage).toContain("fetch('/api/job-orders/bulk-status'");
		expect(listPage).toContain('onSelectionChange={setSelectedIds}');
		expect(listPage).toContain('Close Selected');
	});

	it('EntityTable exposes the opt-in selection props', () => {
		expect(table).toContain('selectedIds,');
		expect(table).toContain('onSelectionChange,');
		expect(table).toContain('table-select-checkbox');
	});
});
