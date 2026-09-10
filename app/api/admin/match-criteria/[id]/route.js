import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, getActingUser, hasAdministrator } from '@/lib/access-control';
import { withApiLogging } from '@/lib/api-logging';
import { logUpdate } from '@/lib/audit-log';
import { parseJsonBody, parseRouteId, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { matchCriterionSchema } from '@/lib/match-criteria';
import { clearMatchCriteriaCache, serializeMatchCriterionRow } from '@/lib/match-criteria-store';

// Duplicated from the collection route rather than imported from it: route
// modules are not a shared-code surface, and this mirrors the custom-fields
// pair. On a fresh install with no administrator yet the module stays open so
// the first admin can be set up.
async function assertMatchCriteriaAdminAccess(req) {
	const hasAdmin = await hasAdministrator();
	const actingUser = await getActingUser(req, { allowFallback: false });
	if (hasAdmin && actingUser?.role !== 'ADMINISTRATOR') {
		throw new AccessControlError('Only administrators can manage match criteria.', 403);
	}
	return actingUser;
}

function handleError(error, fallbackMessage) {
	if (error instanceof AccessControlError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	if (error instanceof ValidationError) {
		return NextResponse.json({ error: error.message }, { status: error.status || 400 });
	}
	if (error?.code === 'P2002') {
		return NextResponse.json({ error: 'A criterion with this key already exists.' }, { status: 409 });
	}
	if (error?.code === 'P2025') {
		return NextResponse.json({ error: 'Match criterion not found.' }, { status: 404 });
	}
	return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

async function patchAdmin_matchCriteria_idHandler(req, { params }) {
	const mutationThrottleResponse = await enforceMutationThrottle(req, 'admin.match_criteria.patch');
	if (mutationThrottleResponse) {
		return mutationThrottleResponse;
	}

	const actingUser = await assertMatchCriteriaAdminAccess(req);
	const id = parseRouteId(await params);
	const body = await parseJsonBody(req);

	const existing = await prisma.matchCriterion.findUnique({ where: { id } });
	if (!existing) {
		return NextResponse.json({ error: 'Match criterion not found.' }, { status: 404 });
	}

	// Validate the merged row rather than the patch, so a partial edit still has
	// to produce a criterion the engine can score with.
	const parsed = matchCriterionSchema.safeParse({
		key: body?.key ?? existing.key,
		label: body?.label ?? existing.label,
		description: body?.description ?? existing.description ?? '',
		evaluatorKey: body?.evaluatorKey ?? existing.evaluatorKey,
		weight: body?.weight ?? existing.weight,
		aiEnabled: body?.aiEnabled ?? existing.aiEnabled,
		options: body?.options ?? existing.options
	});
	if (!parsed.success) {
		return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
	}

	const criterion = await prisma.matchCriterion.update({
		where: { id },
		data: {
			key: parsed.data.key,
			label: parsed.data.label,
			description: parsed.data.description || null,
			evaluatorKey: parsed.data.evaluatorKey,
			weight: parsed.data.weight,
			aiEnabled: parsed.data.aiEnabled,
			options: parsed.data.options,
			...(typeof body?.sortOrder === 'number' ? { sortOrder: body.sortOrder } : {}),
			...(typeof body?.isActive === 'boolean' ? { isActive: body.isActive } : {})
		}
	});

	clearMatchCriteriaCache();
	await logUpdate({
		actorUserId: actingUser?.id,
		entityType: 'MATCH_CRITERION',
		before: existing,
		after: criterion
	});

	return NextResponse.json(serializeMatchCriterionRow(criterion));
}

async function deleteAdmin_matchCriteria_idHandler(req, { params }) {
	const mutationThrottleResponse = await enforceMutationThrottle(req, 'admin.match_criteria.delete');
	if (mutationThrottleResponse) {
		return mutationThrottleResponse;
	}

	const actingUser = await assertMatchCriteriaAdminAccess(req);
	const id = parseRouteId(await params);

	const existing = await prisma.matchCriterion.findUnique({ where: { id } });
	if (!existing) {
		return NextResponse.json({ error: 'Match criterion not found.' }, { status: 404 });
	}

	// A soft delete, like custom fields. Scores already stored name the criteria
	// they were computed against, so hard-deleting the row would leave those
	// breakdowns referring to something that no longer exists.
	const criterion = await prisma.matchCriterion.update({
		where: { id },
		data: { isActive: false }
	});

	clearMatchCriteriaCache();
	await logUpdate({
		actorUserId: actingUser?.id,
		entityType: 'MATCH_CRITERION',
		before: existing,
		after: criterion,
		metadata: { softDeleted: true }
	});

	return NextResponse.json(serializeMatchCriterionRow(criterion));
}

async function patchHandler(req, context) {
	try {
		return await patchAdmin_matchCriteria_idHandler(req, context);
	} catch (error) {
		return handleError(error, 'Failed to update match criterion.');
	}
}

async function deleteHandler(req, context) {
	try {
		return await deleteAdmin_matchCriteria_idHandler(req, context);
	} catch (error) {
		return handleError(error, 'Failed to remove match criterion.');
	}
}

export const PATCH = withApiLogging('admin.match_criteria.id.patch', patchHandler);
export const DELETE = withApiLogging('admin.match_criteria.id.delete', deleteHandler);
