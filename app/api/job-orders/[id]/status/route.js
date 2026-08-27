import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser, getEntityScope } from '@/lib/access-control';
import { logUpdate } from '@/lib/audit-log';
import { parseRouteId, parseJsonBody, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { applyJobOrderStatusChange, jobOrderStatusField } from '@/lib/job-order-status';
import { withApiLogging } from '@/lib/api-logging';

const jobOrderStatusSchema = z.object({
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

async function patchJob_orders_id_statusHandler(req, { params }) {
	try {
		const mutationThrottleResponse = await enforceMutationThrottle(req, 'job_orders.id.status.patch');
		if (mutationThrottleResponse) {
			return mutationThrottleResponse;
		}

		const awaitedParams = await params;
		const id = parseRouteId(awaitedParams);
		const actingUser = await getActingUser(req, { allowFallback: false });
		const existing = await prisma.jobOrder.findFirst({
			where: addScopeToWhere({ id }, getEntityScope(actingUser))
		});
		if (!existing) {
			return NextResponse.json({ error: 'Job order not found.' }, { status: 404 });
		}

		const body = await parseJsonBody(req);
		const parsed = jobOrderStatusSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
		}

		const { jobOrder } = await applyJobOrderStatusChange({
			db: prisma,
			existing,
			nextStatus: parsed.data.status,
			actorUserId: actingUser?.id,
			logUpdate
		});

		return NextResponse.json(jobOrder);
	} catch (error) {
		return handleError(error, 'Failed to update job order status.');
	}
}

export const PATCH = withApiLogging('job_orders.id.status.patch', patchJob_orders_id_statusHandler);
