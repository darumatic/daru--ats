import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser, getEntityScope } from '@/lib/access-control';
import { parseRouteId, ValidationError } from '@/lib/request-validation';
import { JOB_ORDER_MATCH_RATE_LIMIT_MAX_REQUESTS, JOB_ORDER_MATCH_RATE_LIMIT_WINDOW_SECONDS } from '@/lib/security-constants';
import { consumeRequestThrottle } from '@/lib/request-throttle';
import { formatPersonName } from '@/lib/person-name';
import { buildJobText, findJobSkillIds, toBooleanParam, toMatchLimit } from '@/lib/match-scoring';
import { buildCriteriaSetHash, resolveEffectiveCriteria, sortMatches } from '@/lib/match-criteria';
import { scoreCandidateForJobOrder } from '@/lib/match-criteria-evaluators';
import { getMatchCriteriaTemplate, loadScoreOverlays } from '@/lib/match-criteria-store';
import { MATCH_LIST_MAX_CANDIDATE_POOL } from '@/lib/security-constants';

import { withApiLogging } from '@/lib/api-logging';

const MATCH_CACHE_TTL_MS = 60_000;
const MATCH_CACHE_MAX_ENTRIES = 64;
const matchCache = new Map();

// The criteria hash is part of the key on purpose: without it, editing a weight
// leaves every match list serving the old numbers until the TTL expires, which
// reads as the edit not having worked.
function buildMatchCacheKey({ jobOrderId, includeSubmitted, limit, scope, criteriaHash }) {
	return `job-order-match|${jobOrderId}|${includeSubmitted ? 1 : 0}|${limit}|${criteriaHash}|${JSON.stringify(scope || {})}`;
}

function getCachedMatchResponse(key) {
	const entry = matchCache.get(key);
	if (!entry) return null;
	if (entry.expiresAt < Date.now()) {
		matchCache.delete(key);
		return null;
	}
	return entry.payload;
}

function setCachedMatchResponse(key, payload) {
	matchCache.set(key, {
		payload,
		expiresAt: Date.now() + MATCH_CACHE_TTL_MS
	});

	while (matchCache.size > MATCH_CACHE_MAX_ENTRIES) {
		const oldestKey = matchCache.keys().next().value;
		matchCache.delete(oldestKey);
	}
}

function isMissingJobMatchFieldError(error, fieldName) {
	if (!error || error.code !== 'P2022') return false;
	const message = `${error.message || ''}`;
	return fieldName ? message.includes(fieldName) : true;
}


function buildMatchRow({ candidate, jobOrder, criteria, skills, requiredSkillIds, overlay }) {
	const scored = scoreCandidateForJobOrder({
		candidate,
		jobOrder,
		criteria,
		skills,
		requiredSkillIds,
		overlay
	});

	return {
		candidateId: candidate.id,
		candidateName: formatPersonName(candidate.firstName, candidate.lastName, {
			format: 'last-first',
			fallback: 'Candidate'
		}),
		currentJobTitle: candidate.currentJobTitle || '',
		ownerName: candidate.ownerUser ? `${candidate.ownerUser.firstName} ${candidate.ownerUser.lastName}` : '-',
		submittedToJobOrder: Array.isArray(candidate.submissions) && candidate.submissions.length > 0,
		...scored
	};
}

function handleError(error, fallbackMessage) {
	if (error instanceof AccessControlError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	if (error instanceof ValidationError) {
		return NextResponse.json({ error: error.message }, { status: 400 });
	}
	return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

async function getJob_orders_id_matchesHandler(req, { params }) {
	try {
		const awaitedParams = await params;
		const id = parseRouteId(awaitedParams);
		const throttle = await consumeRequestThrottle({
			req,
			routeKey: `job-orders.${id}.matches`,
			maxRequests: JOB_ORDER_MATCH_RATE_LIMIT_MAX_REQUESTS,
			windowSeconds: JOB_ORDER_MATCH_RATE_LIMIT_WINDOW_SECONDS
		});
		if (!throttle.allowed) {
			return NextResponse.json(
				{ error: 'Too many candidate match checks from this network. Please try again shortly.' },
				{
					status: 429,
					headers: {
						'Retry-After': String(throttle.retryAfterSeconds || 60)
					}
				}
			);
		}

		const actingUser = await getActingUser(req);
		const scope = getEntityScope(actingUser);
		const { searchParams } = new URL(req.url);
		const includeSubmitted = toBooleanParam(searchParams.get('includeSubmitted'), false);
		const limit = toMatchLimit(searchParams.get('limit'), 10);

		let jobOrder;
		let includeDivisionFilter = true;
		try {
			jobOrder = await prisma.jobOrder.findFirst({
				where: addScopeToWhere({ id }, scope),
				select: {
					id: true,
					title: true,
					status: true,
					openings: true,
					description: true,
					publicDescription: true,
					location: true,
					locationLatitude: true,
					locationLongitude: true,
					city: true,
					state: true,
					employmentType: true,
					divisionId: true,
					matchCriteria: true,
					_count: {
						select: {
							submissions: true
						}
					}
				}
			});
		} catch (error) {
			if (
				!isMissingJobMatchFieldError(error, 'divisionId') &&
				!isMissingJobMatchFieldError(error, 'publicDescription')
			) {
				throw error;
			}
			includeDivisionFilter = false;
			jobOrder = await prisma.jobOrder.findFirst({
				where: addScopeToWhere({ id }, scope),
				select: {
					id: true,
					title: true,
					status: true,
					openings: true,
					description: true,
					location: true,
					employmentType: true,
					_count: {
						select: {
							submissions: true
						}
					}
				}
			});
		}

		if (!jobOrder) {
			return NextResponse.json({ error: 'Job order not found.' }, { status: 404 });
		}

		const templateCriteria = await getMatchCriteriaTemplate();
		const { criteria, source: criteriaSource, templateDrifted } = resolveEffectiveCriteria({
			jobOrder,
			templateCriteria
		});
		const criteriaHash = buildCriteriaSetHash(criteria);
		const criteriaPayload = criteria.map((criterion) => ({
			key: criterion.key,
			label: criterion.label,
			weight: criterion.weight,
			evaluatorKey: criterion.evaluatorKey,
			options: criterion.options || {}
		}));
		const cacheKey = buildMatchCacheKey({ jobOrderId: id, includeSubmitted, limit, scope, criteriaHash });
		const cached = getCachedMatchResponse(cacheKey);
		if (cached) {
			return NextResponse.json(cached);
		}

		if (jobOrder.status !== 'open') {
			const payload = {
				jobOrderId: id,
				computedAt: new Date().toISOString(),
				requiredSkillNames: [],
				totalCandidatesEvaluated: 0,
				activeHiring: false,
				matchEligibility:
					`Matches are unavailable while this job order is ${String(jobOrder.status).replaceAll('_', ' ')}.`,
				criteria: criteriaPayload,
				criteriaSource,
				criteriaHash,
				templateDrifted,
				matches: []
			};
			setCachedMatchResponse(cacheKey, payload);
			return NextResponse.json(payload);
		}

		const [skills, candidates] = await Promise.all([
			prisma.skill.findMany({
				where: { isActive: true },
				select: { id: true, name: true }
			}),
			prisma.candidate.findMany({
				where: addScopeToWhere(
					{
						divisionId: includeDivisionFilter ? jobOrder.divisionId || undefined : undefined,
						...(includeSubmitted
							? {}
							: {
									submissions: {
										none: {
											jobOrderId: id
										}
									}
								})
					},
					scope
				),
				include: {
					ownerUser: { select: { id: true, firstName: true, lastName: true } },
					candidateSkills: { include: { skill: { select: { id: true, name: true } } } },
					candidateWorkExperiences: {
						select: {
							title: true,
							companyName: true,
							location: true,
							startDate: true,
							endDate: true,
							isCurrent: true
						}
					},
					candidateEducations: {
						select: { schoolName: true, degree: true, fieldOfStudy: true }
					},
					submissions: {
						where: { jobOrderId: id },
						select: { id: true, status: true }
					}
				},
				orderBy: { updatedAt: 'desc' },
				// Previously unbounded: every request scored the entire in-scope
				// pool. The criteria engine does strictly more work per candidate,
				// so the scan is capped. A division larger than the cap sees the
				// most recently updated candidates, which is the order the query
				// already used.
				take: MATCH_LIST_MAX_CANDIDATE_POOL
			})
		]);

		const requiredSkillIds = findJobSkillIds(buildJobText(jobOrder), skills);
		const overlays = await loadScoreOverlays({
			jobOrderId: id,
			candidateIds: candidates.map((candidate) => candidate.id)
		});
		const scored = candidates.map((candidate) =>
			buildMatchRow({
				candidate,
				jobOrder,
				criteria,
				skills,
				requiredSkillIds,
				overlay: overlays.get(candidate.id) || null
			})
		);
		const sorted = sortMatches(scored).slice(0, limit);

		const payload = {
			jobOrderId: id,
			computedAt: new Date().toISOString(),
			requiredSkillNames: requiredSkillIds
				.map((skillId) => skills.find((skill) => skill.id === skillId)?.name)
				.filter(Boolean),
			totalCandidatesEvaluated: scored.length,
			// The criteria in force, so the list can show the weighting it scored
			// against and flag a job whose specialised set has fallen behind the
			// template.
			criteria: criteriaPayload,
			criteriaSource,
			criteriaHash,
			templateDrifted,
			matches: sorted
		};
		setCachedMatchResponse(cacheKey, payload);
		return NextResponse.json(payload);
	} catch (error) {
		return handleError(error, 'Failed to calculate candidate matches.');
	}
}

export const GET = withApiLogging('job_orders.id.matches.get', getJob_orders_id_matchesHandler);
