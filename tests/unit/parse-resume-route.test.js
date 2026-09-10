import { describe, it, expect, vi, beforeEach } from 'vitest';

// The parse-resume response reports which parser produced the draft, and that
// label is the only signal that the AI ran at all: an AI failure here is
// deliberately non-fatal, so the built-in parser answers 200 with a warning
// and otherwise looks identical. The label must therefore name the provider
// that actually answered rather than a hardcoded one.

const { getActingUser } = vi.hoisted(() => ({ getActingUser: vi.fn() }));
const { parseResumeToDraftWithAi } = vi.hoisted(() => ({ parseResumeToDraftWithAi: vi.fn() }));

vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser
}));
vi.mock('@/lib/ai-resume-parser', () => ({ parseResumeToDraftWithAi }));
vi.mock('@/lib/mutation-throttle', () => ({ enforceMutationThrottle: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));

const { POST: parseResume } = await import('../../app/api/candidates/parse-resume/route.js');

const RESUME_TEXT =
	'Dana Reed\ndana.reed@example.com\nSite Reliability Engineer at Northwind since 2019.\nSkills: Kubernetes, Terraform.';

function jsonRequest(body) {
	return {
		headers: new Headers({ 'content-type': 'application/json' }),
		json: async () => body
	};
}

function aiDraft() {
	return {
		ok: true,
		provider: 'gemini',
		draft: { firstName: 'Dana', lastName: 'Reed', email: 'dana.reed@example.com' },
		warnings: [],
		parsedSkills: ['Kubernetes'],
		educationRecords: [],
		workExperienceRecords: []
	};
}

describe('POST /api/candidates/parse-resume', () => {
	beforeEach(() => {
		getActingUser.mockResolvedValue({ id: 1, email: 'recruiter@example.com' });
		parseResumeToDraftWithAi.mockReset();
	});

	it('names the provider that parsed the resume', async () => {
		parseResumeToDraftWithAi.mockResolvedValue(aiDraft());

		const response = await parseResume(jsonRequest({ resumeText: RESUME_TEXT }));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.parser).toBe('gemini');
		expect(payload.meta).toEqual({ input: 'text', parser: 'gemini' });
	});

	it('still names OpenAI when OpenAI did the parsing', async () => {
		parseResumeToDraftWithAi.mockResolvedValue({ ...aiDraft(), provider: 'openai' });

		const payload = await (await parseResume(jsonRequest({ resumeText: RESUME_TEXT }))).json();

		expect(payload.parser).toBe('openai');
	});

	it('reports the built-in parser and carries the reason when the AI call fails', async () => {
		parseResumeToDraftWithAi.mockResolvedValue({
			ok: false,
			warning: 'Google Gemini resume parsing request failed. Used built-in resume parser.'
		});

		const response = await parseResume(jsonRequest({ resumeText: RESUME_TEXT }));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.parser).toBe('fallback');
		expect(payload.warnings).toContain(
			'Google Gemini resume parsing request failed. Used built-in resume parser.'
		);
		expect(payload.draft.email).toBe('dana.reed@example.com');
	});

	it('rejects an unauthenticated caller before parsing anything', async () => {
		getActingUser.mockResolvedValue(null);

		const response = await parseResume(jsonRequest({ resumeText: RESUME_TEXT }));

		expect(response.status).toBe(401);
		expect(parseResumeToDraftWithAi).not.toHaveBeenCalled();
	});
});
