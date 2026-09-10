import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, getActingUser, hasAdministrator } from '@/lib/access-control';
import { withApiLogging } from '@/lib/api-logging';
import { logCreate } from '@/lib/audit-log';
import { parseJsonBody, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { createRecordId } from '@/lib/record-id';
import { matchCriterionSchema } from '@/lib/match-criteria';
import {
	clearMatchCriteriaCache,
	ensureDefaultMatchCriteria,
	serializeMatchCriterionRow
} from '@/lib/match-criteria-store';

function toBooleanFlag(value, fallback = false) {
	if (value == null) return fallback;
	const normalized = String(value).trim().toLowerCase();
	if (!normalized) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
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
	return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

// Matches the custom-fields guard: on a fresh install with no administrator yet,
// the module stays open so the first admin can be set up.
async function assertMatchCriteriaAdminAccess(req) {
	const hasAdmin = await hasAdministrator();
	const actingUser = await getActingUser(req, { allowFallback: false });
	if (hasAdmin && actingUser?.role !== 'ADMINISTRATOR') {
		throw new AccessControlError('Only administrators can manage match criteria.', 403);
	}
	return actingUser;
}

async function getAdmin_matchCriteriaHandler(req) {
	await assertMatchCriteriaAdminAccess(req);

	const includeInactive = toBooleanFlag(req.nextUrl.searchParams.get('includeInactive'), false);
	await ensureDefaultMatchCriteria();

	const rows = await prisma.matchCriterion.findMany({
		where: includeInactive ? {} : { isActive: true },
		orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
	});

	return NextResponse.json(rows.map(serializeMatchCriterionRow));
}

async function postAdmin_matchCriteriaHandler(req) {
	const mutationThrottleResponse = await enforceMutationThrottle(req, 'admin.match_criteria.post');
	if (mutationThrottleResponse) {
		return mutationThrottleResponse;
	}

	const actingUser = await assertMatchCriteriaAdminAccess(req);
	const body = await parseJsonBody(req);
	const parsed = matchCriterionSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
	}

	const highest = await prisma.matchCriterion.findFirst({
		orderBy: { sortOrder: 'desc' },
		select: { sortOrder: true }
	});

	const criterion = await prisma.matchCriterion.create({
		data: {
			recordId: createRecordId('MatchCriterion'),
			key: parsed.data.key,
			label: parsed.data.label,
			description: parsed.data.description || null,
			evaluatorKey: parsed.data.evaluatorKey,
			weight: parsed.data.weight,
			aiEnabled: parsed.data.aiEnabled,
			options: parsed.data.options,
			sortOrder: (highest?.sortOrder ?? 0) + 10
		}
	});

	clearMatchCriteriaCache();
	await logCreate({ actorUserId: actingUser?.id, entityType: 'MATCH_CRITERION', entity: criterion });

	return NextResponse.json(serializeMatchCriterionRow(criterion), { status: 201 });
}

async function getHandler(req) {
	try {
		return await getAdmin_matchCriteriaHandler(req);
	} catch (error) {
		return handleError(error, 'Failed to load match criteria.');
	}
}

async function postHandler(req) {
	try {
		return await postAdmin_matchCriteriaHandler(req);
	} catch (error) {
		return handleError(error, 'Failed to create match criterion.');
	}
}

export const GET = withApiLogging('admin.match_criteria.get', getHandler);
export const POST = withApiLogging('admin.match_criteria.post', postHandler);
