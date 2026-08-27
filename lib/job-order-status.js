import { z } from 'zod';
import { JOB_ORDER_STATUS_VALUES, normalizeJobOrderStatusInput } from '@/lib/job-order-options';

// Shared by the single-record and bulk status endpoints so that "what a
// status change means" (closedAt bookkeeping, no-op detection, audit shape)
// lives in one place.

export const jobOrderStatusField = z.preprocess(
	(value) => normalizeJobOrderStatusInput(value),
	z.enum(JOB_ORDER_STATUS_VALUES)
);

export const JOB_ORDER_STATUS_SELECT = { id: true, status: true, updatedAt: true, closedAt: true };

export function jobOrderStatusDidChange(existing, nextStatus) {
	return String(existing?.status || '').trim() !== String(nextStatus || '').trim();
}

export function buildJobOrderStatusUpdate(nextStatus, now = new Date()) {
	return {
		status: nextStatus,
		closedAt: nextStatus === 'closed' ? now : null
	};
}

export function toJobOrderStatusSnapshot(jobOrder) {
	return {
		id: jobOrder.id,
		status: jobOrder.status,
		updatedAt: jobOrder.updatedAt,
		closedAt: jobOrder.closedAt
	};
}

// Applies `nextStatus` to one scoped job order and writes the audit entry.
// Returns the status snapshot; a no-op change returns the stored snapshot
// without writing anything.
export async function applyJobOrderStatusChange({ db, existing, nextStatus, actorUserId, logUpdate, now }) {
	if (!jobOrderStatusDidChange(existing, nextStatus)) {
		return { jobOrder: toJobOrderStatusSnapshot(existing), changed: false };
	}

	const jobOrder = await db.jobOrder.update({
		where: { id: existing.id },
		data: buildJobOrderStatusUpdate(nextStatus, now),
		select: JOB_ORDER_STATUS_SELECT
	});

	await logUpdate({
		actorUserId,
		entityType: 'JOB_ORDER',
		before: existing,
		after: jobOrder
	});

	return { jobOrder, changed: true };
}
