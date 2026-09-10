import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser, getEntityScope } from '@/lib/access-control';
import { parseRouteId, ValidationError } from '@/lib/request-validation';
import { CANDIDATE_MATCH_RATE_LIMIT_MAX_REQUESTS, CANDIDATE_MATCH_RATE_LIMIT_WINDOW_SECONDS } from '@/lib/security-constants';
import { consumeRequestThrottle } from '@/lib/request-throttle';

import { withApiLogging } from '@/lib/api-logging';
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

function scoreJobOrder(candidate, jobOrder, allSkills, requiredSkillIds) {
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

	const openings = Number(jobOrder?.openings || 0);

	return {
		jobOrderId: jobOrder.id,
		jobOrderTitle: jobOrder.title || '',
		clientName: jobOrder.client?.name || '',
		contactName: jobOrder.contact
			? `${jobOrder.contact.firstName} ${jobOrder.contact.lastName}`.trim()
			: '',
		ownerName: jobOrder.ownerUser
			? `${jobOrder.ownerUser.firstName} ${jobOrder.ownerUser.lastName}`.trim()
			: '-',
		location: jobOrder.location || '',
		score: Math.max(0, Math.min(1, weightedScore)),
		scorePercent: toPercent(weightedScore),
		openings: openings > 0 ? openings : null,
		submissionCount: Number(jobOrder?._count?.submissions || 0),
		activeHiring: true,
		submittedToJobOrder: Array.isArray(jobOrder.submissions) && jobOrder.submissions.length > 0,
		reasons,
		risks
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

async function getCandidates_id_matchesHandler(req, { params }) {
	try {
		const awaitedParams = await params;
		const id = parseRouteId(awaitedParams);
		const throttle = await consumeRequestThrottle({
			req,
			routeKey: `candidates.${id}.matches`,
			maxRequests: CANDIDATE_MATCH_RATE_LIMIT_MAX_REQUESTS,
			windowSeconds: CANDIDATE_MATCH_RATE_LIMIT_WINDOW_SECONDS
		});
		if (!throttle.allowed) {
			return NextResponse.json(
				{ error: 'Too many job match checks from this network. Please try again shortly.' },
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

		const candidate = await prisma.candidate.findFirst({
			where: addScopeToWhere({ id }, scope),
			select: {
				id: true,
				currentJobTitle: true,
				currentEmployer: true,
				summary: true,
				skillSet: true,
				city: true,
				state: true,
				divisionId: true,
				candidateSkills: { include: { skill: { select: { id: true, name: true } } } },
				candidateWorkExperiences: {
					select: { title: true, startDate: true, endDate: true, isCurrent: true }
				}
			}
		});

		if (!candidate) {
			return NextResponse.json({ error: 'Candidate not found.' }, { status: 404 });
		}

		const [skills, jobOrders] = await Promise.all([
			prisma.skill.findMany({
				where: { isActive: true },
				select: { id: true, name: true }
			}),
			prisma.jobOrder.findMany({
				where: addScopeToWhere(
					{
						status: 'open',
						divisionId: candidate.divisionId || undefined,
						...(includeSubmitted
							? {}
							: {
									submissions: {
										none: {
											candidateId: id
										}
									}
								})
					},
					scope
				),
				include: {
					client: { select: { id: true, name: true } },
					contact: { select: { id: true, firstName: true, lastName: true } },
					ownerUser: { select: { id: true, firstName: true, lastName: true } },
					_count: { select: { submissions: true } },
					submissions: {
						where: { candidateId: id },
						select: { id: true }
					}
				},
				orderBy: { updatedAt: 'desc' }
			})
		]);

		const scored = jobOrders.map((jobOrder) => {
			const requiredSkillIds = findJobSkillIds(buildJobText(jobOrder), skills);
			return scoreJobOrder(candidate, jobOrder, skills, requiredSkillIds);
		});

		const sorted = scored
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		return NextResponse.json({
			candidateId: id,
			computedAt: new Date().toISOString(),
			totalJobOrdersEvaluated: scored.length,
			activeHiringJobOrders: scored.length,
			matchEligibility:
				scored.length === 0
					? 'Matches are unavailable because there are no open active job orders for this candidate right now.'
					: '',
			matches: sorted
		});
	} catch (error) {
		return handleError(error, 'Failed to calculate job order matches.');
	}
}

export const GET = withApiLogging('candidates.id.matches.get', getCandidates_id_matchesHandler);
