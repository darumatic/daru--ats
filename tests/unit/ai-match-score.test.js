import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins what the AI is and is not allowed to do to a score.
//
// A model can return a criterion nobody asked about, a score outside 0-100, or
// a row it cannot actually justify. None of those may reach the weighted total,
// and a partially bad reply must not throw away the rows that were fine.

vi.mock('@/lib/ai-chat-client', () => ({ requestAiChatCompletion: vi.fn() }));
vi.mock('@/lib/system-settings', () => ({ getIntegrationSettings: vi.fn() }));

import { requestAiChatCompletion } from '@/lib/ai-chat-client';
import { getIntegrationSettings } from '@/lib/system-settings';
import { scoreCandidateCriteriaWithAi } from '@/lib/ai-match-score';
import { buildCriterionHash } from '@/lib/match-criteria';

const criteria = [
	{ key: 'big_company', label: 'Big Company', description: '', evaluatorKey: 'big_company', weight: 15, aiEnabled: true, options: { referenceValues: [] } },
	{ key: 'university', label: 'University', description: '', evaluatorKey: 'university', weight: 10, aiEnabled: true, options: { referenceValues: [], degreeLevels: [] } }
];

const candidate = {
	firstName: 'Robin',
	lastName: 'Blake',
	currentEmployer: 'Globex',
	candidateWorkExperiences: [{ companyName: 'Globex', title: 'Engineer', startDate: '2018-01-01', isCurrent: true }],
	candidateEducations: [{ schoolName: 'University of Sydney', degree: 'BSc' }],
	candidateSkills: [{ skill: { name: 'React' } }]
};

const jobOrder = { title: 'Senior Engineer', description: 'Build things.', client: { name: 'Acme' } };

function aiReply(results) {
	return { ok: true, data: { results }, modelName: 'o3', providerLabel: 'OpenAI' };
}

beforeEach(() => {
	requestAiChatCompletion.mockReset();
	getIntegrationSettings.mockReset();
	getIntegrationSettings.mockResolvedValue({ aiApiKey: 'sk-test', aiProvider: 'openai', aiModel: 'gpt-4o-mini' });
});

describe('scoreCandidateCriteriaWithAi', () => {
	it('stamps each judgement with the hash of the criterion it judged', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiReply([{ key: 'big_company', score: 80, assessed: true, rationale: 'Globex is large.' }])
		);

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.ok).toBe(true);
		expect(result.results[0]).toEqual({
			key: 'big_company',
			criterionHash: buildCriterionHash(criteria[0]),
			score: 80,
			assessed: true,
			rationale: 'Globex is large.'
		});
	});

	it('drops a criterion key nobody asked about', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiReply([
				{ key: 'big_company', score: 80, assessed: true, rationale: 'ok' },
				{ key: 'vibes', score: 100, assessed: true, rationale: 'invented' }
			])
		);

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.results.map((row) => row.key)).toEqual(['big_company']);
	});

	it('clamps a score outside 0-100', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiReply([
				{ key: 'big_company', score: 900, assessed: true, rationale: '' },
				{ key: 'university', score: -40, assessed: true, rationale: '' }
			])
		);

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.results.map((row) => row.score)).toEqual([100, 0]);
	});

	it('keeps the usable rows when one is malformed', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiReply([
				{ key: 'big_company', score: 70, assessed: true, rationale: 'ok' },
				{ key: 'university', score: Number.NaN, assessed: true, rationale: 'broken' }
			])
		);

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.ok).toBe(true);
		expect(result.results.map((row) => row.key)).toEqual(['big_company']);
	});

	it('carries an honest refusal through as unassessed rather than dropping it', async () => {
		requestAiChatCompletion.mockResolvedValue(
			aiReply([{ key: 'university', score: 0, assessed: false, rationale: 'No education on file.' }])
		);

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.results[0]).toMatchObject({ key: 'university', assessed: false, score: null });
	});

	it('fails when the model scored none of the requested criteria', async () => {
		requestAiChatCompletion.mockResolvedValue(aiReply([{ key: 'vibes', score: 50, assessed: true, rationale: '' }]));

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.ok).toBe(false);
		expect(result.error).toContain('scored none of the requested criteria');
	});

	it('passes a provider failure straight back', async () => {
		requestAiChatCompletion.mockResolvedValue({ ok: false, error: 'OpenAI candidate scoring request failed.' });

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result).toEqual({ ok: false, error: 'OpenAI candidate scoring request failed.' });
	});

	it('reports an unusable reply shape rather than trusting it', async () => {
		requestAiChatCompletion.mockResolvedValue({ ok: true, data: { results: 'not an array' }, providerLabel: 'OpenAI' });

		const result = await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		expect(result.ok).toBe(false);
		expect(result.error).toContain('invalid candidate score');
	});

	it('skips criteria the admin turned off for AI', async () => {
		requestAiChatCompletion.mockResolvedValue(aiReply([{ key: 'big_company', score: 60, assessed: true, rationale: '' }]));

		await scoreCandidateCriteriaWithAi({
			candidate,
			jobOrder,
			criteria: [criteria[0], { ...criteria[1], aiEnabled: false }],
			deterministicResults: []
		});

		const prompt = requestAiChatCompletion.mock.calls[0][0].messages[1].content;
		expect(prompt).toContain('big_company');
		expect(prompt).not.toContain('- university');
	});

	it('refuses without calling the provider when no criterion is AI-enabled', async () => {
		const result = await scoreCandidateCriteriaWithAi({
			candidate,
			jobOrder,
			criteria: criteria.map((row) => ({ ...row, aiEnabled: false })),
			deterministicResults: []
		});

		expect(result.ok).toBe(false);
		expect(requestAiChatCompletion).not.toHaveBeenCalled();
	});
});

describe('reasoning model selection', () => {
	it('uses the reasoning model and its longer budget when one is configured', async () => {
		getIntegrationSettings.mockResolvedValue({ aiApiKey: 'sk', aiProvider: 'openai', aiModel: 'gpt-4o-mini', aiReasoningModel: 'o3' });
		requestAiChatCompletion.mockResolvedValue(aiReply([{ key: 'big_company', score: 60, assessed: true, rationale: '' }]));

		await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		const call = requestAiChatCompletion.mock.calls[0][0];
		expect(call.model).toBe('o3');
		expect(call.timeoutMs).toBe(180_000);
	});

	it('leaves the model to the standard setting when the reasoning model is blank', async () => {
		getIntegrationSettings.mockResolvedValue({ aiApiKey: 'sk', aiProvider: 'openai', aiModel: 'gpt-4o-mini', aiReasoningModel: '' });
		requestAiChatCompletion.mockResolvedValue(aiReply([{ key: 'big_company', score: 60, assessed: true, rationale: '' }]));

		await scoreCandidateCriteriaWithAi({ candidate, jobOrder, criteria, deterministicResults: [] });

		const call = requestAiChatCompletion.mock.calls[0][0];
		expect(call.model).toBeNull();
		expect(call.timeoutMs).toBe(60_000);
	});

	it('tells the model what the rules engine already worked out', async () => {
		requestAiChatCompletion.mockResolvedValue(aiReply([{ key: 'big_company', score: 60, assessed: true, rationale: '' }]));

		await scoreCandidateCriteriaWithAi({
			candidate,
			jobOrder,
			criteria,
			deterministicResults: [
				{ key: 'location', score: 92, assessed: true, basis: '4 miles from the job location.' },
				{ key: 'big_company', score: null, assessed: false, basis: 'no list' }
			]
		});

		const prompt = requestAiChatCompletion.mock.calls[0][0].messages[1].content;
		expect(prompt).toContain('location: rules scored 92');
		expect(prompt).not.toContain('big_company: rules scored');
	});
});
