import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser, getEntityScope } from '@/lib/access-control';
import { logUpdate } from '@/lib/audit-log';
import { parseJsonBody, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { applyJobOrderStatusChange, jobOrderStatusField } from '@/lib/job-order-status';
import { withApiLogging } from '@/lib/api-logging';

export const BULK_STATUS_MAX_IDS = 100;

// One request changes the status of many job orders (the list view's
// "Close Selected"). Records outside the caller's scope are reported as
// `missing`, unchanged ones as `skipped`; each real change is audited
// exactly like the single-record endpoint.
export const bulkJobOrderStatusSchema = z.object({
	ids: z
		.array(z.coerce.number().int().positive())
		.min(1, 'Select at least one job order.')
		.max(BULK_STATUS_MAX_IDS, `You can update at most ${BULK_STATUS_MAX_IDS} job orders at once.`),
	status: jobOrderStatusField
});

function handleError(error, fallbackMessage) {
	if (error instanceof AccessControlError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	if (error instanceof ValidationError) {
		return NextResponse.json({ error: error.message }, { status: error.status || 400 });
	}
	return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

async function patchJob_orders_bulk_statusHandler(req) {
	try {
		const mutationThrottleResponse = await enforceMutationThrottle(req, 'job_orders.bulk_status.patch');
		if (mutationThrottleResponse) {
			return mutationThrottleResponse;
		}

		const actingUser = await getActingUser(req, { allowFallback: false });
		const body = await parseJsonBody(req);
		const parsed = bulkJobOrderStatusSchema.safeParse(body);
		if (!parsed.success) {
			const firstIssue = parsed.error.issues[0];
			return NextResponse.json(
				{ error: firstIssue?.message || 'Invalid bulk status payload.', errors: parsed.error.flatten() },
				{ status: 400 }
			);
		}

		const ids = [...new Set(parsed.data.ids)];
		const nextStatus = parsed.data.status;
		const existingJobOrders = await prisma.jobOrder.findMany({
			where: addScopeToWhere({ id: { in: ids } }, getEntityScope(actingUser)),
			orderBy: { id: 'asc' }
		});
		const foundIds = new Set(existingJobOrders.map((jobOrder) => jobOrder.id));
		const missing = ids.filter((id) => !foundIds.has(id));

		const updated = [];
		const skipped = [];
		const now = new Date();
		for (const existing of existingJobOrders) {
			const { jobOrder, changed } = await applyJobOrderStatusChange({
				db: prisma,
				existing,
				nextStatus,
				actorUserId: actingUser?.id,
				logUpdate,
				now
			});
			if (changed) {
				updated.push(jobOrder);
			} else {
				skipped.push(jobOrder.id);
			}
		}

		return NextResponse.json({ status: nextStatus, updated, skipped, missing });
	} catch (error) {
		return handleError(error, 'Failed to update job order statuses.');
	}
}

export const PATCH = withApiLogging('job_orders.bulk_status.patch', patchJob_orders_bulk_statusHandler);
