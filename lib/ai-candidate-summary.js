import { z } from 'zod';
import { requestAiChatCompletion } from '@/lib/ai-chat-client';

const MAX_SECTION_CHARS = 5000;

const candidateSummarySchema = z.object({
	overview: z.string().default(''),
	strengths: z.array(z.string()).default([]),
	concerns: z.array(z.string()).default([]),
	suggestedNextStep: z.string().default('')
});

function asTrimmedString(value) {
	if (typeof value !== 'string') return '';
	return value.trim();
}

function truncateText(value, maxLength = MAX_SECTION_CHARS) {
	return asTrimmedString(String(value ?? '')).slice(0, maxLength);
}

function uniqueStrings(values) {
	const seen = new Set();
	const items = [];

	for (const rawValue of values || []) {
		const value = asTrimmedString(rawValue);
		if (!value) continue;
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(value);
	}

	return items;
}

function buildCandidateSourceText(candidate) {
	const skillNames = uniqueStrings([
		...(Array.isArray(candidate?.candidateSkills)
			? candidate.candidateSkills.map((candidateSkill) => candidateSkill?.skill?.name)
			: []),
		...String(candidate?.skillSet || '').split(/[,;\n|/]+/)
	]);

	const educationLines = Array.isArray(candidate?.candidateEducations)
		? candidate.candidateEducations.map((education) =>
				[
					asTrimmedString(education?.schoolName),
					asTrimmedString(education?.degree),
					asTrimmedString(education?.fieldOfStudy)
				]
					.filter(Boolean)
					.join(' | ')
			)
		: [];

	const workLines = Array.isArray(candidate?.candidateWorkExperiences)
		? candidate.candidateWorkExperiences.map((workExperience) =>
				[
					asTrimmedString(workExperience?.title),
					asTrimmedString(workExperience?.companyName),
					asTrimmedString(workExperience?.location),
					truncateText(workExperience?.description, 280)
				]
					.filter(Boolean)
					.join(' | ')
			)
		: [];

	const recentNoteLines = Array.isArray(candidate?.notes)
		? candidate.notes
				.slice(0, 5)
				.map((note) => truncateText(note?.content, 400))
				.filter(Boolean)
		: [];

	return [
		`Name: ${[candidate?.firstName, candidate?.lastName].filter(Boolean).join(' ') || '-'}`,
		`Email: ${asTrimmedString(candidate?.email) || '-'}`,
		`Mobile: ${asTrimmedString(candidate?.mobile || candidate?.phone) || '-'}`,
		`Status: ${asTrimmedString(candidate?.status) || '-'}`,
		`Source: ${asTrimmedString(candidate?.source) || '-'}`,
		`Current Title: ${asTrimmedString(candidate?.currentJobTitle) || '-'}`,
		`Current Employer: ${asTrimmedString(candidate?.currentEmployer) || '-'}`,
		`Location: ${[candidate?.city, candidate?.state, candidate?.zipCode].filter(Boolean).join(', ') || '-'}`,
		`Website: ${asTrimmedString(candidate?.website) || '-'}`,
		`LinkedIn: ${asTrimmedString(candidate?.linkedinUrl) || '-'}`,
		'',
		'Resume Summary:',
		truncateText(candidate?.summary, MAX_SECTION_CHARS) || 'None provided.',
		'',
		'Skills:',
		skillNames.length > 0 ? skillNames.join(', ') : 'None listed.',
		'',
		'Education:',
		educationLines.length > 0 ? educationLines.join('\n') : 'None listed.',
		'',
		'Work Experience:',
		workLines.length > 0 ? workLines.join('\n') : 'None listed.',
		'',
		'Recent Notes:',
		recentNoteLines.length > 0 ? recentNoteLines.join('\n---\n') : 'No notes.'
	].join('\n');
}

function buildSchema() {
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			overview: { type: 'string' },
			strengths: { type: 'array', items: { type: 'string' } },
			concerns: { type: 'array', items: { type: 'string' } },
			suggestedNextStep: { type: 'string' }
		},
		required: ['overview', 'strengths', 'concerns', 'suggestedNextStep']
	};
}

export async function generateCandidateSummaryWithAi(candidate) {
	const sourceText = buildCandidateSourceText(candidate);
	if (!asTrimmedString(sourceText)) {
		return {
			ok: false,
			error: 'Candidate data is too limited to summarize.'
		};
	}

	const result = await requestAiChatCompletion({
		feature: 'candidate summary',
		temperature: 0.2,
		schemaName: 'candidate_summary',
		schema: buildSchema(),
		messages: [
			{
				role: 'system',
				content:
					'You are assisting recruiters. Produce a concise, factual candidate summary. Do not invent experience. Keep the overview to 2-4 sentences. Strengths and concerns should be short bullets. Suggested next step should be a single practical recruiter action.'
			},
			{
				role: 'user',
				content: [
					'Generate a recruiter-facing candidate summary from the following profile.',
					'',
					sourceText
				].join('\n')
			}
		]
	});

	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	const parsed = candidateSummarySchema.safeParse(result.data);
	if (!parsed.success) {
		return {
			ok: false,
			error: `${result.providerLabel} returned an invalid candidate summary.`
		};
	}

	return {
		ok: true,
		summary: {
			overview: truncateText(parsed.data.overview, 3000),
			strengths: uniqueStrings(parsed.data.strengths).slice(0, 6),
			concerns: uniqueStrings(parsed.data.concerns).slice(0, 6),
			suggestedNextStep: truncateText(parsed.data.suggestedNextStep, 1200)
		},
		modelName: result.modelName
	};
}
