import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, getActingUser } from '@/lib/access-control';
import { validateScopedCandidateAndJobOrder } from '@/lib/related-record-scope';
import { parseJsonBody, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { logCreate, logUpdate } from '@/lib/audit-log';
import { withApiLogging } from '@/lib/api-logging';
import { buildCriteriaSetHash, resolveEffectiveCriteria } from '@/lib/match-criteria';
import { getMatchCriteriaTemplate } from '@/lib/match-criteria-store';
import { describeScoreFreshness, scoreAndPersistPair } from '@/lib/match-score-service';

function parsePositiveInt(value) {
	const parsed = Number.parseInt(String(value ?? '').trim(), 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

async function getMatch_scoresHandler(req) {
	try {
		const actingUser = await getActingUser(req, { allowFallback: false });
		const candidateId = parsePositiveInt(req.nextUrl.searchParams.get('candidateId'));
		const jobOrderId = parsePositiveInt(req.nextUrl.searchParams.get('jobOrderId'));

		if (!candidateId || !jobOrderId) {
			return NextResponse.json({ error: 'candidateId and jobOrderId are required.' }, { status: 400 });
		}

		await validateScopedCandidateAndJobOrder({ actingUser, candidateId, jobOrderId });

		const [score, candidate, jobOrder, templateCriteria] = await Promise.all([
			prisma.candidateJobScore.findUnique({ where: { candidateId_jobOrderId: { candidateId, jobOrderId } } }),
			prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true, updatedAt: true } }),
			prisma.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true, updatedAt: true, matchCriteria: true } }),
			getMatchCriteriaTemplate()
		]);

		const { criteria } = resolveEffectiveCriteria({ jobOrder, templateCriteria });
		const freshness = describeScoreFreshness({
			score,
			candidate,
			jobOrder,
			criteriaSetHash: buildCriteriaSetHash(criteria)
		});

		return NextResponse.json({ score: score || null, criteria, ...freshness });
	} catch (error) {
		return handleError(error, 'Failed to load candidate score.');
	}
}

async function postMatch_scoresHandler(req) {
	try {
		const mutationThrottleResponse = await enforceMutationThrottle(req, 'match-scores.post');
		if (mutationThrottleResponse) {
			return mutationThrottleResponse;
		}

		const actingUser = await getActingUser(req, { allowFallback: false });
		const body = await parseJsonBody(req);
		const candidateId = parsePositiveInt(body?.candidateId);
		const jobOrderId = parsePositiveInt(body?.jobOrderId);
		const useAi = body?.useAi !== false;

		if (!candidateId || !jobOrderId) {
			return NextResponse.json({ error: 'candidateId and jobOrderId are required.' }, { status: 400 });
		}

		await validateScopedCandidateAndJobOrder({ actingUser, candidateId, jobOrderId });

		// Nothing about the score comes from the request body. The caller says
		// which pair to score and whether to consult the model; the number itself
		// is always computed here.
		const outcome = await scoreAndPersistPair({
			candidateId,
			jobOrderId,
			actingUserId: actingUser.id,
			useAi
		});

		if (!outcome.ok) {
			return NextResponse.json({ error: outcome.error }, { status: outcome.status || 400 });
		}

		if (outcome.created) {
			await logCreate({
				actorUserId: actingUser.id,
				entityType: 'CANDIDATE_JOB_SCORE',
				entity: outcome.score,
				metadata: { candidateId, jobOrderId, useAi }
			});
		} else {
			await logUpdate({
				actorUserId: actingUser.id,
				entityType: 'CANDIDATE_JOB_SCORE',
				before: outcome.previous,
				after: outcome.score,
				metadata: { candidateId, jobOrderId, useAi }
			});
		}

		return NextResponse.json({
			score: outcome.score,
			criteria: outcome.criteria,
			criteriaResults: outcome.criteriaResults,
			stale: false,
			criteriaChanged: false,
			// A refused or failed AI call still leaves a deterministic score
			// behind, so this is a warning rather than an error - but it must not
			// be swallowed, or a broken key looks like a working rules-only score.
			aiError: outcome.aiError || null
		});
	} catch (error) {
		return handleError(error, 'Failed to score this candidate.');
	}
}

export const GET = withApiLogging('match_scores.get', getMatch_scoresHandler);
export const POST = withApiLogging('match_scores.post', postMatch_scoresHandler);
