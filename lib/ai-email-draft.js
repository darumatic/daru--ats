import { z } from 'zod';
import { requestAiChatCompletion } from '@/lib/ai-chat-client';

const MAX_SECTION_CHARS = 5000;

const emailDraftSchema = z.object({
	subject: z.string().default(''),
	body: z.string().default('')
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
	for (const rawValue of values) {
		const value = asTrimmedString(rawValue);
		if (!value) continue;
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(value);
	}
	return items;
}

function buildSchema() {
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			subject: { type: 'string' },
			body: { type: 'string' }
		},
		required: ['subject', 'body']
	};
}

function buildCandidateSourceText(candidate) {
	const skillNames = uniqueStrings([
		...(Array.isArray(candidate?.candidateSkills)
			? candidate.candidateSkills.map((candidateSkill) => candidateSkill?.skill?.name)
			: []),
		...String(candidate?.skillSet || '').split(/[,;\n|/]+/)
	]);

	const recentNoteLines = Array.isArray(candidate?.notes)
		? candidate.notes
				.slice(0, 5)
				.map((note) => truncateText(note?.content, 300))
				.filter(Boolean)
		: [];

	return [
		`Entity Type: Candidate`,
		`Name: ${[candidate?.firstName, candidate?.lastName].filter(Boolean).join(' ') || '-'}`,
		`Email: ${asTrimmedString(candidate?.email) || '-'}`,
		`Status: ${asTrimmedString(candidate?.status) || '-'}`,
		`Source: ${asTrimmedString(candidate?.source) || '-'}`,
		`Current Title: ${asTrimmedString(candidate?.currentJobTitle) || '-'}`,
		`Current Employer: ${asTrimmedString(candidate?.currentEmployer) || '-'}`,
		`Location: ${[candidate?.city, candidate?.state].filter(Boolean).join(', ') || '-'}`,
		'',
		'Summary:',
		truncateText(candidate?.summary, 2200) || 'None provided.',
		'',
		'Skills:',
		skillNames.length > 0 ? skillNames.join(', ') : 'None listed.',
		'',
		'Recent Notes:',
		recentNoteLines.length > 0 ? recentNoteLines.join('\n---\n') : 'No notes.'
	].join('\n');
}

function buildContactSourceText(contact) {
	const recentNoteLines = Array.isArray(contact?.notes)
		? contact.notes
				.slice(0, 5)
				.map((note) => truncateText(note?.content, 300))
				.filter(Boolean)
		: [];

	return [
		`Entity Type: Contact`,
		`Name: ${[contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || '-'}`,
		`Email: ${asTrimmedString(contact?.email) || '-'}`,
		`Phone: ${asTrimmedString(contact?.phone) || '-'}`,
		`Title: ${asTrimmedString(contact?.title) || '-'}`,
		`Department: ${asTrimmedString(contact?.department) || '-'}`,
		`Client: ${asTrimmedString(contact?.client?.name) || '-'}`,
		`Source: ${asTrimmedString(contact?.source) || '-'}`,
		'',
		'Recent Notes:',
		recentNoteLines.length > 0 ? recentNoteLines.join('\n---\n') : 'No notes.'
	].join('\n');
}

export async function generateEmailDraftWithAi({
	entityType,
	entity,
	purpose,
	tone,
	instructions
}) {
	const sourceText =
		entityType === 'candidate' ? buildCandidateSourceText(entity) : buildContactSourceText(entity);
	if (!asTrimmedString(sourceText)) {
		return {
			ok: false,
			error: 'Record data is too limited to draft an email.'
		};
	}

	const result = await requestAiChatCompletion({
		feature: 'email draft',
		temperature: 0.35,
		schemaName: 'email_draft',
		schema: buildSchema(),
		messages: [
			{
				role: 'system',
				content:
					'You draft concise professional recruiting emails. Return a JSON object with subject and body only. Do not invent facts. Keep emails practical, polished, and ready to send. Body should be plain text with short paragraphs and no markdown.'
			},
			{
				role: 'user',
				content: [
					`Draft a ${tone} recruiting email for this ${entityType}.`,
					`Purpose: ${purpose}.`,
					instructions ? `Extra instructions: ${truncateText(instructions, 1200)}` : '',
					'',
					sourceText
				]
					.filter(Boolean)
					.join('\n')
			}
		]
	});

	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	const parsed = emailDraftSchema.safeParse(result.data);
	if (!parsed.success) {
		return {
			ok: false,
			error: `${result.providerLabel} returned an invalid email draft.`
		};
	}

	return {
		ok: true,
		draft: {
			subject: truncateText(parsed.data.subject, 240),
			body: truncateText(parsed.data.body, 5000)
		},
		modelName: result.modelName
	};
}
