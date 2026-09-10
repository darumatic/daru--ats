import { z } from 'zod';
import { requestAiChatCompletion } from '@/lib/ai-chat-client';
import { getIntegrationSettings } from '@/lib/system-settings';
import { isReasoningModel } from '@/lib/ai-providers';
import { buildCriterionHash } from '@/lib/match-criteria';
import {
	AI_REASONING_REQUEST_TIMEOUT_SECONDS,
	AI_REQUEST_TIMEOUT_SECONDS
} from '@/lib/security-constants';

// Asks the configured model to score one candidate against a job order's
// criteria, one call for all of them.
//
// One call rather than one per criterion: it is cheaper and faster, and it lets
// the model reason across criteria - a candidate at a household-name employer
// *in the job's city* is one judgement, not two.

const MAX_SOURCE_CHARS = 8000;
const MAX_RATIONALE_CHARS = 400;

// The envelope is validated strictly, each row leniently. A model that gets one
// criterion wrong should cost that criterion, not the whole reply - discarding
// four good judgements because a fifth came back malformed would mean paying for
// the call again to get them back.
const aiScoreEnvelopeSchema = z.object({ results: z.array(z.unknown()).default([]) });

const aiScoreRowSchema = z.object({
	key: z.string(),
	score: z.number().finite(),
	assessed: z.boolean(),
	rationale: z.string().default('')
});

function asTrimmedString(value) {
	if (typeof value !== 'string') return '';
	return value.trim();
}

function truncateText(value, maxLength = MAX_SOURCE_CHARS) {
	return asTrimmedString(String(value ?? '')).slice(0, maxLength);
}

function formatTenure(row) {
	const start = row?.startDate ? String(row.startDate).slice(0, 7) : '';
	const end = row?.isCurrent ? 'present' : row?.endDate ? String(row.endDate).slice(0, 7) : '';
	return start || end ? `${start || '?'} to ${end || '?'}` : '';
}

function buildSourceText({ candidate, jobOrder, criteria, deterministicResults }) {
	const workHistory = (Array.isArray(candidate?.candidateWorkExperiences) ? candidate.candidateWorkExperiences : [])
		.map((row) =>
			[
				asTrimmedString(row?.title),
				asTrimmedString(row?.companyName),
				asTrimmedString(row?.location),
				formatTenure(row),
				truncateText(row?.description, 180)
			]
				.filter(Boolean)
				.join(' | ')
		)
		.filter(Boolean);

	const education = (Array.isArray(candidate?.candidateEducations) ? candidate.candidateEducations : [])
		.map((row) =>
			[asTrimmedString(row?.schoolName), asTrimmedString(row?.degree), asTrimmedString(row?.fieldOfStudy)]
				.filter(Boolean)
				.join(' | ')
		)
		.filter(Boolean);

	const skills = (Array.isArray(candidate?.candidateSkills) ? candidate.candidateSkills : [])
		.map((row) => row?.skill?.name)
		.filter(Boolean);

	const alreadyKnown = (Array.isArray(deterministicResults) ? deterministicResults : [])
		.filter((row) => row?.assessed)
		.map((row) => `${row.key}: rules scored ${row.score} (${row.basis || ''})`.trim());

	return [
		'Criteria to score',
		...criteria.map(
			(criterion) =>
				`- ${criterion.key} (${criterion.label}, weight ${criterion.weight}): ${asTrimmedString(criterion.description) || 'no further guidance'}`
		),
		'',
		'What the rules engine already determined',
		alreadyKnown.length > 0 ? alreadyKnown.join('\n') : '-',
		'',
		'Job Order',
		`Title: ${asTrimmedString(jobOrder?.title) || '-'}`,
		`Client: ${asTrimmedString(jobOrder?.client?.name) || '-'}`,
		`Location: ${[jobOrder?.city, jobOrder?.state].filter(Boolean).join(', ') || asTrimmedString(jobOrder?.location) || '-'}`,
		`Employment Type: ${asTrimmedString(jobOrder?.employmentType) || '-'}`,
		`Description: ${truncateText(jobOrder?.description, 3000) || '-'}`,
		'',
		'Candidate',
		`Name: ${[candidate?.firstName, candidate?.lastName].filter(Boolean).join(' ') || '-'}`,
		`Current Title: ${asTrimmedString(candidate?.currentJobTitle) || '-'}`,
		`Current Employer: ${asTrimmedString(candidate?.currentEmployer) || '-'}`,
		`Location: ${[candidate?.city, candidate?.state, candidate?.country].filter(Boolean).join(', ') || '-'}`,
		`Stated Years of Experience: ${Number.isFinite(Number(candidate?.experienceYears)) ? candidate.experienceYears : '-'}`,
		`Skills: ${skills.length > 0 ? skills.join(', ') : '-'}`,
		`Summary: ${truncateText(candidate?.summary, 2000) || '-'}`,
		'',
		'Work History',
		workHistory.length > 0 ? workHistory.join('\n') : '-',
		'',
		'Education',
		education.length > 0 ? education.join('\n') : '-'
	].join('\n');
}

function buildSchema() {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['results'],
		properties: {
			results: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['key', 'score', 'assessed', 'rationale'],
					properties: {
						key: { type: 'string' },
						score: { type: 'integer' },
						assessed: { type: 'boolean' },
						rationale: { type: 'string' }
					}
				}
			}
		}
	};
}

/**
 * Scores one candidate against one job order's criteria.
 *
 * Returns per-criterion rows stamped with the hash of the criterion they judged,
 * so a later change to that criterion's definition invalidates only that row.
 * A key the model invented, or a row it could not produce a usable number for,
 * is dropped rather than allowed into the weighted total.
 */
export async function scoreCandidateCriteriaWithAi({
	candidate,
	jobOrder,
	criteria,
	deterministicResults,
	integrationSettings = null
}) {
	const scorable = (Array.isArray(criteria) ? criteria : []).filter((criterion) => criterion?.aiEnabled !== false);
	if (scorable.length === 0) {
		return { ok: false, error: 'No criteria on this job order are enabled for AI scoring.' };
	}

	const settings = integrationSettings || (await getIntegrationSettings());
	const reasoningModel = asTrimmedString(settings?.aiReasoningModel);
	const model = reasoningModel || null;
	const timeoutSeconds = isReasoningModel(reasoningModel)
		? AI_REASONING_REQUEST_TIMEOUT_SECONDS
		: AI_REQUEST_TIMEOUT_SECONDS;

	const result = await requestAiChatCompletion({
		feature: 'candidate scoring',
		temperature: 0.1,
		schemaName: 'candidate_criteria_scores',
		schema: buildSchema(),
		model,
		timeoutMs: timeoutSeconds * 1000,
		integrationSettings: settings,
		messages: [
			{
				role: 'system',
				content: [
					'You score a candidate against a recruiter’s named criteria.',
					'Return one entry per criterion key you were given, and no others.',
					'score is 0-100. Set assessed to false when the material genuinely does not support a judgement, and do not guess a number in that case - an honest gap is more useful than an invented score.',
					'Judge only from the material provided. Do not infer employers, schools, seniority or years that are not stated.',
					'Keep each rationale to one short sentence citing what you used.'
				].join(' ')
			},
			{
				role: 'user',
				content: buildSourceText({ candidate, jobOrder, criteria: scorable, deterministicResults })
			}
		]
	});

	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	const envelope = aiScoreEnvelopeSchema.safeParse(result.data);
	if (!envelope.success) {
		return { ok: false, error: `${result.providerLabel} returned an invalid candidate score.` };
	}

	const criterionByKey = new Map(scorable.map((criterion) => [criterion.key, criterion]));
	const results = envelope.data.results
		.map((rawRow) => {
			const parsedRow = aiScoreRowSchema.safeParse(rawRow);
			// An unassessed row is allowed to carry no usable score, so it is
			// recovered from the raw shape rather than dropped with the rest.
			if (!parsedRow.success) {
				const key = typeof rawRow?.key === 'string' ? rawRow.key : '';
				const criterion = criterionByKey.get(key);
				if (!criterion || rawRow?.assessed !== false) return null;
				return {
					key,
					criterionHash: buildCriterionHash(criterion),
					score: null,
					assessed: false,
					rationale: truncateText(rawRow?.rationale, MAX_RATIONALE_CHARS)
				};
			}

			const row = parsedRow.data;
			const criterion = criterionByKey.get(row.key);
			// A key we did not ask about must never reach the weighted total.
			if (!criterion) return null;

			return {
				key: row.key,
				criterionHash: buildCriterionHash(criterion),
				score: row.assessed ? Math.max(0, Math.min(100, Math.round(row.score))) : null,
				assessed: row.assessed,
				rationale: truncateText(row.rationale, MAX_RATIONALE_CHARS)
			};
		})
		.filter(Boolean);

	if (results.length === 0) {
		return { ok: false, error: `${result.providerLabel} scored none of the requested criteria.` };
	}

	return { ok: true, results, modelName: result.modelName };
}
