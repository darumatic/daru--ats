import { NextResponse } from 'next/server';
import { AccessControlError, getActingUser } from '@/lib/access-control';
import { validateScopedCandidateAndJobOrder } from '@/lib/related-record-scope';
import { parseJsonBody, parseRouteId, ValidationError } from '@/lib/request-validation';
import { enforceMutationThrottle } from '@/lib/mutation-throttle';
import { consumeRequestThrottle } from '@/lib/request-throttle';
import { logCreate, logUpdate } from '@/lib/audit-log';
import { withApiLogging } from '@/lib/api-logging';
import {
	MATCH_SCORE_BATCH_CONCURRENCY,
	MATCH_SCORE_BATCH_DEADLINE_SECONDS,
	MATCH_SCORE_BATCH_MAX_CANDIDATES,
	MATCH_SCORE_BATCH_RATE_LIMIT_MAX_REQUESTS,
	MATCH_SCORE_BATCH_RATE_LIMIT_WINDOW_SECONDS
} from '@/lib/security-constants';
import { scoreAndPersistPair } from '@/lib/match-score-service';

export { MATCH_SCORE_BATCH_MAX_CANDIDATES };

function handleError(error, fallbackMessage) {
	if (error instanceof AccessControlError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	if (error instanceof ValidationError) {
		return NextResponse.json({ error: error.message }, { status: error.status || 400 });
	}
	return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

function parseCandidateIds(value) {
	if (!Array.isArray(value)) return null;
	const ids = value
		.map((entry) => Number.parseInt(String(entry ?? '').trim(), 10))
		.filter((entry) => Number.isInteger(entry) && entry > 0);
	return [...new Set(ids)];
}

/**
 * Runs the scoring calls a few at a time, stopping cleanly at a deadline.
 *
 * A hand-rolled pool rather than a dependency: the repo is deliberately
 * dependency-light and this is a dozen lines. The deadline matters because each
 * call can take a reasoning model many seconds - without it a full batch could
 * outlive its own HTTP request and the caller would see a timeout with no idea
 * what had been written.
 */
async function runPool(items, worker, { concurrency, deadlineAt }) {
	const results = [];
	const skipped = [];
	let cursor = 0;

	async function pump() {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			if (Date.now() >= deadlineAt) {
				skipped.push(items[index]);
				continue;
			}
			results.push(await worker(items[index]));
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => pump()));
	return { results, skipped };
}

async function postJob_orders_id_matchScoresHandler(req, { params }) {
	try {
		const mutationThrottleResponse = await enforceMutationThrottle(req, 'job_orders.id.match_scores.post');
		if (mutationThrottleResponse) {
			return mutationThrottleResponse;
		}

		const id = parseRouteId(await params);
		const throttle = await consumeRequestThrottle({
			req,
			routeKey: `job-orders.${id}.match-scores`,
			maxRequests: MATCH_SCORE_BATCH_RATE_LIMIT_MAX_REQUESTS,
			windowSeconds: MATCH_SCORE_BATCH_RATE_LIMIT_WINDOW_SECONDS
		});
		if (!throttle.allowed) {
			return NextResponse.json(
				{ error: 'Too many scoring runs from this network. Please try again shortly.' },
				{ status: 429, headers: { 'Retry-After': String(throttle.retryAfterSeconds || 60) } }
			);
		}

		const actingUser = await getActingUser(req, { allowFallback: false });
		const body = await parseJsonBody(req);
		const candidateIds = parseCandidateIds(body?.candidateIds);
		const useAi = body?.useAi !== false;

		if (!candidateIds || candidateIds.length === 0) {
			return NextResponse.json({ error: 'candidateIds is required.' }, { status: 400 });
		}

		// Refused rather than truncated: someone who asked for two hundred
		// candidates needs to be told they got twenty-five, not left to discover
		// it from a short list.
		if (candidateIds.length > MATCH_SCORE_BATCH_MAX_CANDIDATES) {
			return NextResponse.json(
				{
					error: `Score at most ${MATCH_SCORE_BATCH_MAX_CANDIDATES} candidates at a time. ${candidateIds.length} were requested.`
				},
				{ status: 400 }
			);
		}

		const deadlineAt = Date.now() + MATCH_SCORE_BATCH_DEADLINE_SECONDS * 1000;
		const { results, skipped } = await runPool(
			candidateIds,
			async (candidateId) => {
				try {
					await validateScopedCandidateAndJobOrder({ actingUser, candidateId, jobOrderId: id });
					const outcome = await scoreAndPersistPair({
						candidateId,
						jobOrderId: id,
						actingUserId: actingUser.id,
						useAi
					});
					if (!outcome.ok) {
						return { candidateId, ok: false, error: outcome.error };
					}

					if (outcome.created) {
						await logCreate({
							actorUserId: actingUser.id,
							entityType: 'CANDIDATE_JOB_SCORE',
							entity: outcome.score,
							metadata: { candidateId, jobOrderId: id, useAi, batch: true }
						});
					} else {
						await logUpdate({
							actorUserId: actingUser.id,
							entityType: 'CANDIDATE_JOB_SCORE',
							before: outcome.previous,
							after: outcome.score,
							metadata: { candidateId, jobOrderId: id, useAi, batch: true }
						});
					}

					return {
						candidateId,
						ok: true,
						scorePercent: outcome.score.scorePercent,
						coveragePercent: outcome.score.coveragePercent,
						aiError: outcome.aiError || null
					};
				} catch (error) {
					// One candidate failing must not sink the run: the recruiter
					// keeps the scores that did land and is told which did not.
					return {
						candidateId,
						ok: false,
						error: error instanceof AccessControlError ? error.message : 'Scoring failed for this candidate.'
					};
				}
			},
			{ concurrency: MATCH_SCORE_BATCH_CONCURRENCY, deadlineAt }
		);

		const scored = results.filter((row) => row.ok);
		const failed = results.filter((row) => !row.ok);

		return NextResponse.json({
			jobOrderId: id,
			requested: candidateIds.length,
			scored: scored.length,
			results,
			failed,
			skipped
		});
	} catch (error) {
		return handleError(error, 'Failed to score candidates for this job order.');
	}
}

export const POST = withApiLogging('job_orders.id.match_scores.post', postJob_orders_id_matchScoresHandler);
