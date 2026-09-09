import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the wiring between the feature libraries and the shared AI client:
// each feature must ask for its own schema, validate what comes back, and
// report failures using the configured provider's name. The resume parser is
// the deliberate exception — its failures are warnings, because the caller
// still gets a draft from the built-in parser.

const { requestAiChatCompletion } = vi.hoisted(() => ({
	requestAiChatCompletion: vi.fn()
}));

vi.mock('@/lib/ai-chat-client', () => ({ requestAiChatCompletion }));

const { generateCandidateSummaryWithAi } = await import('@/lib/ai-candidate-summary');
const { enhancePublicJobPostingWithAi } = await import('@/lib/ai-job-posting-enhancer');
const { parseResumeToDraftWithAi } = await import('@/lib/ai-resume-parser');

const CANDIDATE = {
	firstName: 'Dana',
	lastName: 'Reed',
	currentJobTitle: 'Site Reliability Engineer',
	currentEmployer: 'Northwind',
	skillSet: 'Kubernetes, Terraform',
	summary: 'Ten years running production infrastructure.'
};

function aiSuccess(data, overrides = {}) {
	return {
		ok: true,
		data,
		content: JSON.stringify(data),
		modelName: 'gemini-2.5-flash',
		providerLabel: 'Google Gemini',
		...overrides
	};
}

describe('candidate summary', () => {
	beforeEach(() => {
		requestAiChatCompletion.mockReset();
	});

	it('requests its own schema and returns the model that answered', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiSuccess({
				overview: 'Experienced SRE.',
				strengths: ['Kubernetes', 'Kubernetes', 'Terraform'],
				concerns: [],
				suggestedNextStep: 'Book a screening call.'
			})
		);

		const result = await generateCandidateSummaryWithAi(CANDIDATE);

		const request = requestAiChatCompletion.mock.calls[0][0];
		expect(request.feature).toBe('candidate summary');
		expect(request.schemaName).toBe('candidate_summary');
		expect(request.schema).toMatchObject({ type: 'object' });
		expect(result.ok).toBe(true);
		expect(result.modelName).toBe('gemini-2.5-flash');
		// Duplicate strengths are collapsed before they reach the UI.
		expect(result.summary.strengths).toEqual(['Kubernetes', 'Terraform']);
	});

	it('passes a client failure straight through', async () => {
		requestAiChatCompletion.mockResolvedValue({
			ok: false,
			providerLabel: 'Google Gemini',
			error: 'Google Gemini candidate summary request failed.'
		});

		const result = await generateCandidateSummaryWithAi(CANDIDATE);

		expect(result).toEqual({ ok: false, error: 'Google Gemini candidate summary request failed.' });
	});

	it('names the configured provider when the reply fails validation', async () => {
		requestAiChatCompletion.mockResolvedValue(aiSuccess({ overview: 42 }));

		const result = await generateCandidateSummaryWithAi(CANDIDATE);

		expect(result).toEqual({
			ok: false,
			error: 'Google Gemini returned an invalid candidate summary.'
		});
	});
});

describe('job posting enhancer', () => {
	beforeEach(() => {
		requestAiChatCompletion.mockReset();
	});

	it('asks for free-form HTML with no schema and sanitizes the reply', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiSuccess(null, { content: '<p>Great role</p><script>alert(1)</script>' })
		);

		const result = await enhancePublicJobPostingWithAi({
			title: 'SRE',
			publicDescription: '<p>We need an SRE.</p>'
		});

		const request = requestAiChatCompletion.mock.calls[0][0];
		expect(request.schema).toBeUndefined();
		expect(result.ok).toBe(true);
		expect(result.enhancedHtml).toContain('Great role');
		expect(result.enhancedHtml).not.toContain('<script>');
	});

	it('refuses before calling the provider when there is nothing to enhance', async () => {
		const result = await enhancePublicJobPostingWithAi({ publicDescription: '   ' });

		expect(requestAiChatCompletion).not.toHaveBeenCalled();
		expect(result).toEqual({
			ok: false,
			error: 'Public description is required before AI enhancement.'
		});
	});
});

describe('resume parser', () => {
	beforeEach(() => {
		requestAiChatCompletion.mockReset();
	});

	it('degrades to the built-in parser with a warning instead of failing', async () => {
		requestAiChatCompletion.mockResolvedValue({
			ok: false,
			providerLabel: 'Google Gemini',
			error: 'AI API key is not configured in Admin > Settings.'
		});

		const result = await parseResumeToDraftWithAi('Dana Reed, SRE');

		expect(result.ok).toBe(false);
		expect(result.warning).toBe(
			'AI API key is not configured in Admin > Settings. Used built-in resume parser.'
		);
	});

	it('warns rather than throwing when the reply does not match the schema', async () => {
		requestAiChatCompletion.mockResolvedValue(aiSuccess({ draft: 'not an object' }));

		const result = await parseResumeToDraftWithAi('Dana Reed, SRE');

		expect(result.ok).toBe(false);
		expect(result.warning).toBe(
			'Google Gemini resume parsing returned an invalid draft. Used built-in resume parser.'
		);
	});

	it('returns a normalized draft when the reply is valid', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiSuccess({
				draft: { firstName: 'Dana', lastName: 'Reed', email: 'dana@example.com' },
				skills: ['Kubernetes'],
				warnings: ['Phone number missing']
			})
		);

		const result = await parseResumeToDraftWithAi('Dana Reed, SRE');

		expect(result.ok).toBe(true);
		expect(result.draft).toMatchObject({ firstName: 'Dana', lastName: 'Reed' });
		expect(result.warnings).toEqual(['Phone number missing']);
	});
});
