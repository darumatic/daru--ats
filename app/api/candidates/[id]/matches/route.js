import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AccessControlError, addScopeToWhere, getActingUser, getEntityScope } from '@/lib/access-control';
import { parseRouteId, ValidationError } from '@/lib/request-validation';
import { CANDIDATE_MATCH_RATE_LIMIT_MAX_REQUESTS, CANDIDATE_MATCH_RATE_LIMIT_WINDOW_SECONDS } from '@/lib/security-constants';
import { consumeRequestThrottle } from '@/lib/request-throttle';

import { withApiLogging } from '@/lib/api-logging';
import { buildJobText, findJobSkillIds, toBooleanParam, toMatchLimit } from '@/lib/match-scoring';
import { resolveEffectiveCriteria, sortMatches } from '@/lib/match-criteria';
import { scoreCandidateForJobOrder } from '@/lib/match-criteria-evaluators';
import { getMatchCriteriaTemplate, loadScoreOverlaysForCandidate } from '@/lib/match-criteria-store';

// Each job order resolves its own criteria, so a candidate's list can honestly
// mix jobs scored against the template with jobs that specialised their own set.
function buildMatchRow({ candidate, jobOrder, templateCriteria, skills, overlay }) {
	const { criteria } = resolveEffectiveCriteria({ jobOrder, templateCriteria });
	const requiredSkillIds = findJobSkillIds(buildJobText(jobOrder), skills);
	const scored = scoreCandidateForJobOrder({
		candidate,
		jobOrder,
		criteria,
		skills,
		requiredSkillIds,
		overlay
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
		openings: openings > 0 ? openings : null,
		submissionCount: Number(jobOrder?._count?.submissions || 0),
		activeHiring: true,
		submittedToJobOrder: Array.isArray(jobOrder.submissions) && jobOrder.submissions.length > 0,
		criteria: criteria.map((criterion) => ({
			key: criterion.key,
			label: criterion.label,
			description: criterion.description || '',
			weight: criterion.weight,
			evaluatorKey: criterion.evaluatorKey,
			options: criterion.options || {}
		})),
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
				experienceYears: true,
				addressLatitude: true,
				addressLongitude: true,
				divisionId: true,
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

		const templateCriteria = await getMatchCriteriaTemplate();
		const overlays = await loadScoreOverlaysForCandidate({
			candidateId: id,
			jobOrderIds: jobOrders.map((jobOrder) => jobOrder.id)
		});
		const scored = jobOrders.map((jobOrder) =>
			buildMatchRow({
				candidate,
				jobOrder,
				templateCriteria,
				skills,
				overlay: overlays.get(jobOrder.id) || null
			})
		);

		const sorted = sortMatches(scored).slice(0, limit);

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
