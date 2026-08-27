import { describe, it, expect, vi } from 'vitest';
import {
	applyJobOrderStatusChange,
	buildJobOrderStatusUpdate,
	jobOrderStatusDidChange,
	jobOrderStatusField,
	toJobOrderStatusSnapshot
} from '../../lib/job-order-status.js';

describe('job-order status helpers (shared by single and bulk endpoints)', () => {
	it('normalises status input and rejects unknown values', () => {
		expect(jobOrderStatusField.parse('Closed')).toBe('closed');
		expect(jobOrderStatusField.safeParse('archived').success).toBe(false);
	});

	it('detects a real status change, ignoring whitespace', () => {
		expect(jobOrderStatusDidChange({ status: 'open ' }, 'open')).toBe(false);
		expect(jobOrderStatusDidChange({ status: 'open' }, 'closed')).toBe(true);
	});

	it('stamps closedAt only when closing', () => {
		const now = new Date('2026-08-27T00:00:00Z');
		expect(buildJobOrderStatusUpdate('closed', now)).toEqual({ status: 'closed', closedAt: now });
		expect(buildJobOrderStatusUpdate('open', now)).toEqual({ status: 'open', closedAt: null });
	});

	it('applies a change through the db and audits it', async () => {
		const now = new Date('2026-08-27T00:00:00Z');
		const updated = { id: 5, status: 'closed', updatedAt: now, closedAt: now };
		const db = { jobOrder: { update: vi.fn().mockResolvedValue(updated) } };
		const logUpdate = vi.fn();
		const existing = { id: 5, status: 'open', title: 'Role', updatedAt: null, closedAt: null };

		const result = await applyJobOrderStatusChange({ db, existing, nextStatus: 'closed', actorUserId: 9, logUpdate, now });

		expect(result).toEqual({ jobOrder: updated, changed: true });
		expect(db.jobOrder.update).toHaveBeenCalledWith({
			where: { id: 5 },
			data: { status: 'closed', closedAt: now },
			select: { id: true, status: true, updatedAt: true, closedAt: true }
		});
		expect(logUpdate).toHaveBeenCalledWith({ actorUserId: 9, entityType: 'JOB_ORDER', before: existing, after: updated });
	});

	it('is a no-op (no write, no audit) when the status is unchanged', async () => {
		const db = { jobOrder: { update: vi.fn() } };
		const logUpdate = vi.fn();
		const existing = { id: 5, status: 'closed', updatedAt: 'u', closedAt: 'c', title: 'Role' };

		const result = await applyJobOrderStatusChange({ db, existing, nextStatus: 'closed', actorUserId: 9, logUpdate });

		expect(result).toEqual({ jobOrder: toJobOrderStatusSnapshot(existing), changed: false });
		expect(result.jobOrder).not.toHaveProperty('title');
		expect(db.jobOrder.update).not.toHaveBeenCalled();
		expect(logUpdate).not.toHaveBeenCalled();
	});
});
