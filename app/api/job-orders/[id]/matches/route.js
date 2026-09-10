import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser, getEntityScope } from '@/lib/access-control';
import { parseRouteId, ValidationError } from '@/lib/request-validation';
import { JOB_ORDER_MATCH_RATE_LIMIT_MAX_REQUESTS, JOB_ORDER_MATCH_RATE_LIMIT_WINDOW_SECONDS } from '@/lib/security-constants';
import { consumeRequestThrottle } from '@/lib/request-throttle';
import { formatPersonName } from '@/lib/person-name';
import {
	buildCandidateText,
	buildJobText,
	buildReasons,
	findJobSkillIds,
	inferRequiredYears,
	inferYearsFromWorkExperience,
	locationScore,
	overlapRatio,
	toBooleanParam,
	toMatchLimit,
	toPercent,
	tokenize
} from '@/lib/match-scoring';

import { withApiLogging } from '@/lib/api-logging';

const MATCH_CACHE_TTL_MS = 60_000;
const MATCH_CACHE_MAX_ENTRIES = 64;
const matchCache = new Map();

function buildMatchCacheKey({ jobOrderId, includeSubmitted, limit, scope }) {
	return `job-order-match|${jobOrderId}|${includeSubmitted ? 1 : 0}|${limit}|${JSON.stringify(scope || {})}`;
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


function scoreCandidate(candidate, jobOrder, allSkills, requiredSkillIds) {
	const candidateSkillIds = new Set(
		(candidate.candidateSkills || []).map((item) => item?.skill?.id).filter(Boolean)
	);
	const requiredSkillsMatched = requiredSkillIds
		.filter((skillId) => candidateSkillIds.has(skillId))
		.map((skillId) => allSkills.find((skill) => skill.id === skillId)?.name)
		.filter(Boolean);
	const requiredSkillsMissing = requiredSkillIds
		.filter((skillId) => !candidateSkillIds.has(skillId))
		.map((skillId) => allSkills.find((skill) => skill.id === skillId)?.name)
		.filter(Boolean);

	const requiredSkillCoverage =
		requiredSkillIds.length > 0 ? requiredSkillsMatched.length / requiredSkillIds.length : 0.6;

	const jobTokens = tokenize(buildJobText(jobOrder));
	const candidateTokens = tokenize(buildCandidateText(candidate));
	const keywordOverlap = overlapRatio(jobTokens, candidateTokens);
	const titleOverlap = overlapRatio(tokenize(jobOrder?.title), tokenize(candidate?.currentJobTitle));

	const inferredYears = inferYearsFromWorkExperience(candidate.candidateWorkExperiences);
	const requiredYears = inferRequiredYears(jobOrder);
	const experienceFit =
		requiredYears > 0 ? Math.max(0, Math.min(1, inferredYears / requiredYears)) : Math.min(1, inferredYears / 8 || 0.4);

	const locationFit = locationScore(jobOrder, candidate);

	const hasExplicitRequiredSkills = requiredSkillIds.length > 0;
	const weightedScore = hasExplicitRequiredSkills
		? requiredSkillCoverage * 0.45 + titleOverlap * 0.2 + keywordOverlap * 0.15 + experienceFit * 0.15 + locationFit * 0.05
		: requiredSkillCoverage * 0.25 + titleOverlap * 0.2 + keywordOverlap * 0.3 + experienceFit * 0.2 + locationFit * 0.05;

	const { reasons, risks } = buildReasons({
		requiredSkillsMatched,
		requiredSkillsMissing,
		experienceYears: inferredYears,
		requiredYears,
		locationFit,
		titleOverlap
	});

	return {
		candidateId: candidate.id,
		candidateName: formatPersonName(candidate.firstName, candidate.lastName, {
			format: 'last-first',
			fallback: 'Candidate'
		}),
		currentJobTitle: candidate.currentJobTitle || '',
		ownerName: candidate.ownerUser ? `${candidate.ownerUser.firstName} ${candidate.ownerUser.lastName}` : '-',
		score: Math.max(0, Math.min(1, weightedScore)),
		scorePercent: toPercent(weightedScore),
		submittedToJobOrder: Array.isArray(candidate.submissions) && candidate.submissions.length > 0,
		reasons,
		risks,
		componentScores: {
			requiredSkillCoverage: toPercent(requiredSkillCoverage),
			titleOverlap: toPercent(titleOverlap),
			keywordOverlap: toPercent(keywordOverlap),
			experienceFit: toPercent(experienceFit),
			locationFit: toPercent(locationFit)
		}
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
		const cacheKey = buildMatchCacheKey({
			jobOrderId: id,
			includeSubmitted,
			limit,
			scope
		});
		const cached = getCachedMatchResponse(cacheKey);
		if (cached) {
			return NextResponse.json(cached);
		}

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
					employmentType: true,
					divisionId: true,
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

		if (jobOrder.status !== 'open') {
			const payload = {
				jobOrderId: id,
				computedAt: new Date().toISOString(),
				requiredSkillNames: [],
				totalCandidatesEvaluated: 0,
				activeHiring: false,
				matchEligibility:
					`Matches are unavailable while this job order is ${String(jobOrder.status).replaceAll('_', ' ')}.`,
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
						select: { title: true, startDate: true, endDate: true, isCurrent: true }
					},
					submissions: {
						where: { jobOrderId: id },
						select: { id: true, status: true }
					}
				},
				orderBy: { updatedAt: 'desc' }
			})
		]);

		const requiredSkillIds = findJobSkillIds(buildJobText(jobOrder), skills);
		const scored = candidates.map((candidate) => scoreCandidate(candidate, jobOrder, skills, requiredSkillIds));
		const sorted = scored
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		const payload = {
			jobOrderId: id,
			computedAt: new Date().toISOString(),
			requiredSkillNames: requiredSkillIds
				.map((skillId) => skills.find((skill) => skill.id === skillId)?.name)
				.filter(Boolean),
			totalCandidatesEvaluated: scored.length,
			matches: sorted
		};
		setCachedMatchResponse(cacheKey, payload);
		return NextResponse.json(payload);
	} catch (error) {
		return handleError(error, 'Failed to calculate candidate matches.');
	}
}

export const GET = withApiLogging('job_orders.id.matches.get', getJob_orders_id_matchesHandler);
