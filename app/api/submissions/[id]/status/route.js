import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser } from '@/lib/access-control';
import { getCandidateJobOrderScope } from '@/lib/related-record-scope';
import { logUpdate } from '@/lib/audit-log';
import { parseRouteId, parseJsonBody, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { getSubmissionStatusMoveBlocker, SUBMISSION_STATUS_VALUES } from '@/lib/submission-status';
import { withApiLogging } from '@/lib/api-logging';

// Status-only update used by the job-order pipeline board. The full
// `PATCH /api/submissions/[id]` replaces every editable field (a body without
// `notes` clears them), so stage moves get their own narrow endpoint.

const submissionStatusSchema = z.object({
	status: z.enum(SUBMISSION_STATUS_VALUES)
});

const SUBMISSION_STATUS_SELECT = {
	id: true,
	status: true,
	updatedAt: true,
	candidateId: true,
	jobOrderId: true,
	offer: { select: { id: true } }
};

function blockerHttpStatus(blocker) {
	return blocker?.reason === 'locked' ? 409 : 400;
}

function handleError(error, fallbackMessage) {
	if (error instanceof AccessControlError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	if (error instanceof ValidationError) {
		return NextResponse.json({ error: error.message }, { status: error.status || 400 });
	}
	return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

async function patchSubmissions_id_statusHandler(req, { params }) {
	try {
		const mutationThrottleResponse = await enforceMutationThrottle(req, 'submissions.id.status.patch');
		if (mutationThrottleResponse) {
			return mutationThrottleResponse;
		}

		const awaitedParams = await params;
		const id = parseRouteId(awaitedParams);
		const actingUser = await getActingUser(req, { allowFallback: false });
		const existing = await prisma.submission.findFirst({
			where: addScopeToWhere({ id }, getCandidateJobOrderScope(actingUser)),
			select: SUBMISSION_STATUS_SELECT
		});
		if (!existing) {
			return NextResponse.json({ error: 'Submission not found.' }, { status: 404 });
		}

		const body = await parseJsonBody(req);
		const parsed = submissionStatusSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
		}

		const nextStatus = parsed.data.status;
		if (String(existing.status || '').trim() === nextStatus) {
			return NextResponse.json({ id: existing.id, status: existing.status, updatedAt: existing.updatedAt });
		}

		const blocker = getSubmissionStatusMoveBlocker(existing, nextStatus);
		if (blocker) {
			return NextResponse.json({ error: blocker.message }, { status: blockerHttpStatus(blocker) });
		}

		const submission = await prisma.submission.update({
			where: { id },
			data: { status: nextStatus },
			select: { id: true, status: true, updatedAt: true }
		});

		await logUpdate({
			actorUserId: actingUser?.id,
			entityType: 'SUBMISSION',
			before: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
			after: submission
		});

		return NextResponse.json(submission);
	} catch (error) {
		return handleError(error, 'Failed to update submission status.');
	}
}

export const PATCH = withApiLogging('submissions.id.status.patch', patchSubmissions_id_statusHandler);
