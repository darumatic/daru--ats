import { z } from 'zod';
import { requestAiChatCompletion } from '@/lib/ai-chat-client';

const MAX_SOURCE_CHARS = 10000;

const interviewQuestionSetSchema = z.object({
	questionSet: z.string().default('')
});

function asTrimmedString(value) {
	if (typeof value !== 'string') return '';
	return value.trim();
}

function truncateText(value, maxLength = MAX_SOURCE_CHARS) {
	return asTrimmedString(String(value ?? '')).slice(0, maxLength);
}

function buildInterviewSourceText(interview) {
	const candidate = interview?.candidate || {};
	const jobOrder = interview?.jobOrder || {};
	const client = jobOrder?.client || {};

	const skillNames = Array.isArray(candidate?.candidateSkills)
		? candidate.candidateSkills.map((candidateSkill) => candidateSkill?.skill?.name).filter(Boolean)
		: [];
	const workHistory = Array.isArray(candidate?.candidateWorkExperiences)
		? candidate.candidateWorkExperiences
				.map((work) =>
					[
						asTrimmedString(work?.title),
						asTrimmedString(work?.companyName),
						asTrimmedString(work?.location),
						truncateText(work?.description, 220)
					]
						.filter(Boolean)
						.join(' | ')
				)
				.filter(Boolean)
		: [];

	return [
		'Interview Context',
		`Interview Type: ${asTrimmedString(interview?.interviewMode) || '-'}`,
		`Interview Subject: ${asTrimmedString(interview?.subject) || '-'}`,
		`Interviewer: ${asTrimmedString(interview?.interviewer) || '-'}`,
		`Scheduled Start: ${interview?.startsAt ? new Date(interview.startsAt).toISOString() : '-'}`,
		'',
		'Candidate',
		`Name: ${[candidate?.firstName, candidate?.lastName].filter(Boolean).join(' ') || '-'}`,
		`Current Title: ${asTrimmedString(candidate?.currentJobTitle) || '-'}`,
		`Current Employer: ${asTrimmedString(candidate?.currentEmployer) || '-'}`,
		`Resume Summary: ${truncateText(candidate?.summary, 2600) || '-'}`,
		`Other Skills: ${truncateText(candidate?.skillSet, 1200) || '-'}`,
		`Structured Skills: ${skillNames.length > 0 ? skillNames.join(', ') : '-'}`,
		'',
		'Recent Work History',
		workHistory.length > 0 ? workHistory.join('\n') : '-',
		'',
		'Job Order',
		`Title: ${asTrimmedString(jobOrder?.title) || '-'}`,
		`Client: ${asTrimmedString(client?.name) || '-'}`,
		`Employment Type: ${asTrimmedString(jobOrder?.employmentType) || '-'}`,
		`Location: ${[jobOrder?.city, jobOrder?.state, jobOrder?.zipCode].filter(Boolean).join(', ') || asTrimmedString(jobOrder?.location) || '-'}`,
		`Internal Description: ${truncateText(jobOrder?.description, 3200) || '-'}`,
		'',
		'Interview Notes',
		truncateText(interview?.feedback, 1200) || '-'
	].join('\n');
}

function buildSchema() {
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			questionSet: { type: 'string' }
		},
		required: ['questionSet']
	};
}

export async function generateInterviewQuestionSetWithAi(interview) {
	const sourceText = buildInterviewSourceText(interview);
	if (!asTrimmedString(sourceText)) {
		return {
			ok: false,
			error: 'Interview data is too limited to generate questions.'
		};
	}

	const result = await requestAiChatCompletion({
		feature: 'interview question set',
		temperature: 0.35,
		schemaName: 'interview_question_set',
		schema: buildSchema(),
		messages: [
			{
				role: 'system',
				content:
					'You generate concise, useful interview question sets for recruiters and hiring managers. Be factual. Do not invent experience or certifications. Return plain text with short section headings for Role-Specific Questions, Behavioral Questions, Follow-Up Probes, and Risk Checks. Include 3-5 items per section.'
			},
			{
				role: 'user',
				content: [
					'Generate a practical interview question set for this candidate and job order.',
					'',
					sourceText
				].join('\n')
			}
		]
	});

	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	const parsed = interviewQuestionSetSchema.safeParse(result.data);
	if (!parsed.success || !asTrimmedString(parsed.data.questionSet)) {
		return {
			ok: false,
			error: `${result.providerLabel} returned an invalid interview question set.`
		};
	}

	return {
		ok: true,
		questionSet: truncateText(parsed.data.questionSet, 7000),
		modelName: result.modelName
	};
}
