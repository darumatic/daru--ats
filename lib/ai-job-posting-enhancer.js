import { hasMeaningfulRichTextContent, sanitizeRichTextHtml, stripRichTextToPlainText } from '@/lib/rich-text';
import { requestAiChatCompletion } from '@/lib/ai-chat-client';

const MAX_SOURCE_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 6_000;

function asTrimmedString(value) {
	if (typeof value !== 'string') return '';
	return value.trim();
}

function toShortText(value, maxLength) {
	return asTrimmedString(String(value ?? '')).slice(0, maxLength);
}

function normalizeOutputHtml(value) {
	const raw = String(value ?? '').trim();
	if (!raw) return '';

	const fencedMatch = raw.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
	return fencedMatch ? fencedMatch[1].trim() : raw;
}

export async function enhancePublicJobPostingWithAi(input) {
	const sourceHtml = String(input?.publicDescription || '');
	if (!hasMeaningfulRichTextContent(sourceHtml)) {
		return {
			ok: false,
			error: 'Public description is required before AI enhancement.'
		};
	}

	const title = toShortText(input?.title, 200);
	const employmentType = toShortText(input?.employmentType, 120);
	const location = toShortText(input?.location, 200);
	const internalDescription = toShortText(
		stripRichTextToPlainText(input?.description || ''),
		MAX_CONTEXT_CHARS
	);
	const sourceDescription = toShortText(
		stripRichTextToPlainText(sourceHtml),
		MAX_SOURCE_CHARS
	);
	const salaryMin = asTrimmedString(input?.salaryMin);
	const salaryMax = asTrimmedString(input?.salaryMax);
	const currency = asTrimmedString(input?.currency) || 'USD';

	const contextLines = [
		`Job Title: ${title || '-'}`,
		`Employment Type: ${employmentType || '-'}`,
		`Location: ${location || '-'}`,
		`Salary Range: ${salaryMin || '-'} to ${salaryMax || '-'} ${currency}`
	];
	const internalContext = internalDescription
		? `Internal context (do not expose confidential details):\n${internalDescription}`
		: 'Internal context: none';

	const result = await requestAiChatCompletion({
		feature: 'enhancement',
		temperature: 0.35,
		messages: [
			{
				role: 'system',
				content:
					'You improve job postings for readability and conversion while staying truthful. Return only HTML fragment content suitable for a rich text editor. Use only these tags: p, ul, ol, li, strong, em, a, br. Do not use markdown. Do not add placeholders or fabricated requirements.'
			},
			{
				role: 'user',
				content: [
					'Enhance this public job posting. Keep facts intact, improve clarity, and keep a professional tone.',
					'',
					...contextLines,
					'',
					internalContext,
					'',
					'Current public description:',
					sourceDescription
				].join('\n')
			}
		]
	});

	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	const sanitized = sanitizeRichTextHtml(normalizeOutputHtml(result.content));
	if (!sanitized || !hasMeaningfulRichTextContent(sanitized)) {
		return {
			ok: false,
			error: `${result.providerLabel} returned an empty enhancement.`
		};
	}

	return {
		ok: true,
		enhancedHtml: sanitized
	};
}
