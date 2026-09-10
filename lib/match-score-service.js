import { prisma } from '@/lib/prisma';
import { createRecordId } from '@/lib/record-id';
import { buildJobText, findJobSkillIds } from '@/lib/match-scoring';
import { buildCriteriaSetHash, computeWeightedScore, resolveEffectiveCriteria } from '@/lib/match-criteria';
import { evaluateCriteria, mergeCriteriaResults } from '@/lib/match-criteria-evaluators';
import { getMatchCriteriaTemplate } from '@/lib/match-criteria-store';
import { scoreCandidateCriteriaWithAi } from '@/lib/ai-match-score';

// Loading, scoring and persisting one candidate/job pair. Both the single-score
// route and the batch route go through here, so a score written by either is
// built the same way.

function candidateInclude() {
	return {
		candidateSkills: { include: { skill: { select: { id: true, name: true } } } },
		candidateWorkExperiences: {
			orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }, { createdAt: 'desc' }]
		},
		candidateEducations: { orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }] }
	};
}

export async function loadScoringSources({ candidateId, jobOrderId }) {
	const [candidate, jobOrder, skills] = await Promise.all([
		prisma.candidate.findUnique({ where: { id: candidateId }, include: candidateInclude() }),
		prisma.jobOrder.findUnique({ where: { id: jobOrderId }, include: { client: { select: { id: true, name: true } } } }),
		prisma.skill.findMany({ where: { isActive: true }, select: { id: true, name: true } })
	]);

	return { candidate, jobOrder, skills };
}

/**
 * Computes a score for one pair and writes it.
 *
 * The score is always recomputed server-side; nothing about it is taken from the
 * caller. `useAi` decides only whether the model is consulted on top of the
 * deterministic pass - a failed or refused AI call still persists the
 * deterministic score rather than leaving the pair unscored, and reports the
 * reason back so the caller can surface it.
 */
export async function scoreAndPersistPair({ candidateId, jobOrderId, actingUserId, useAi = false, sources = null }) {
	const { candidate, jobOrder, skills } = sources || (await loadScoringSources({ candidateId, jobOrderId }));
	if (!candidate || !jobOrder) {
		return { ok: false, status: 404, error: 'Candidate or job order not found.' };
	}

	const templateCriteria = await getMatchCriteriaTemplate();
	const { criteria } = resolveEffectiveCriteria({ jobOrder, templateCriteria });
	const requiredSkillIds = findJobSkillIds(buildJobText(jobOrder), skills);
	const deterministic = evaluateCriteria({ criteria, candidate, jobOrder, skills, requiredSkillIds });

	const existing = await prisma.candidateJobScore.findUnique({
		where: { candidateId_jobOrderId: { candidateId, jobOrderId } }
	});

	// Judgements already paid for are the starting point, not something a
	// rules-only re-score or a transient provider failure may throw away. They
	// are only replaced by a successful AI call, and mergeCriteriaResults still
	// ignores any whose criterion has since been redefined.
	let aiResults = Array.isArray(existing?.criteriaResults) ? existing.criteriaResults : [];
	let modelName = existing?.modelName || null;
	let aiError = null;

	if (useAi) {
		const generated = await scoreCandidateCriteriaWithAi({
			candidate,
			jobOrder,
			criteria,
			deterministicResults: deterministic
		});
		if (generated.ok) {
			aiResults = generated.results;
			modelName = generated.modelName || null;
		} else {
			aiError = generated.error;
		}
	}

	const { results } = mergeCriteriaResults({
		deterministic,
		criteria,
		overlay: { criteriaResults: aiResults }
	});
	const totals = computeWeightedScore(results);
	const criteriaSetHash = buildCriteriaSetHash(criteria);

	const data = {
		scorePercent: totals.scorePercent,
		coveragePercent: totals.coveragePercent,
		// Only the AI rows are stored. The deterministic half is cheap to
		// recompute and would otherwise go stale silently the moment a candidate
		// record changed.
		criteriaResults: aiResults,
		criteriaSetHash,
		candidateUpdatedAt: candidate.updatedAt,
		jobOrderUpdatedAt: jobOrder.updatedAt,
		modelName,
		generatedByUserId: actingUserId || null
	};

	const saved = existing
		? await prisma.candidateJobScore.update({
				where: { candidateId_jobOrderId: { candidateId, jobOrderId } },
				data
			})
		: await prisma.candidateJobScore.create({
				data: {
					...data,
					recordId: createRecordId('CandidateJobScore'),
					candidateId,
					jobOrderId
				}
			});

	return {
		ok: true,
		created: !existing,
		previous: existing,
		score: saved,
		criteria,
		criteriaResults: results,
		aiError
	};
}

/**
 * Whether a stored score still reflects the records and criteria it was built
 * from. Kept separate from the write path so a read can report it cheaply.
 */
export function describeScoreFreshness({ score, candidate, jobOrder, criteriaSetHash }) {
	if (!score) return { stale: false, criteriaChanged: false };

	const recordsMoved = Boolean(
		(score.candidateUpdatedAt && candidate?.updatedAt && candidate.updatedAt > score.candidateUpdatedAt) ||
			(score.jobOrderUpdatedAt && jobOrder?.updatedAt && jobOrder.updatedAt > score.jobOrderUpdatedAt)
	);
	const criteriaChanged = Boolean(criteriaSetHash && score.criteriaSetHash !== criteriaSetHash);

	return { stale: recordsMoved || criteriaChanged, criteriaChanged };
}
