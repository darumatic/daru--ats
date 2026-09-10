import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Exercises the shared AI transport against a fake fetch: an unset provider
// must still reach OpenAI exactly as before the provider column existed, a
// Gemini setting must reach Google's OpenAI-compatible endpoint, and a
// provider that rejects the strict json_schema block must be retried once in
// plain JSON mode rather than failing the feature.

const { getIntegrationSettings } = vi.hoisted(() => ({
	getIntegrationSettings: vi.fn()
}));

vi.mock('@/lib/system-settings', () => ({ getIntegrationSettings }));

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
	logError,
	logWarn,
	logInfo: vi.fn(),
	logDebug: vi.fn()
}));

const { requestAiChatCompletion, normalizeModelContent } = await import('@/lib/ai-chat-client');

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { answer: { type: 'string' } },
	required: ['answer']
};

const MESSAGES = [{ role: 'user', content: 'hi' }];

function jsonResponse(content) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content } }] })
	};
}

function errorResponse(status, body = '') {
	return {
		ok: false,
		status,
		text: async () => body,
		json: async () => ({})
	};
}

function settings(overrides = {}) {
	return { aiApiKey: 'test-key', aiProvider: 'openai', aiModel: '', ...overrides };
}

function lastCall(index = 0) {
	const [url, options] = global.fetch.mock.calls[index];
	return { url, options, body: JSON.parse(options.body) };
}

describe('requestAiChatCompletion', () => {
	beforeEach(() => {
		global.fetch = vi.fn();
		logError.mockReset();
		logWarn.mockReset();
		getIntegrationSettings.mockResolvedValue(settings());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('calls OpenAI with a strict schema when no provider is stored', async () => {
		getIntegrationSettings.mockResolvedValue({ aiApiKey: 'sk-test', aiProvider: null, aiModel: '' });
		global.fetch.mockResolvedValue(jsonResponse('{"answer":"ok"}'));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schemaName: 'candidate_summary',
			schema: SCHEMA
		});

		const { url, options, body } = lastCall();
		expect(url).toBe('https://api.openai.com/v1/chat/completions');
		expect(options.headers.Authorization).toBe('Bearer sk-test');
		expect(body.model).toBe('gpt-4o-mini');
		expect(body.response_format.type).toBe('json_schema');
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(result).toMatchObject({ ok: true, data: { answer: 'ok' }, providerLabel: 'OpenAI' });
	});

	it('calls the Gemini compatibility endpoint with the Gemini default model', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiProvider: 'gemini', aiApiKey: 'AIza-test' }));
		global.fetch.mockResolvedValue(jsonResponse('{"answer":"ok"}'));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schema: SCHEMA
		});

		const { url, options, body } = lastCall();
		expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
		expect(options.headers.Authorization).toBe('Bearer AIza-test');
		expect(body.model).toBe('gemini-2.5-flash');
		expect(result.ok).toBe(true);
		expect(result.providerLabel).toBe('Google Gemini');
		expect(result.modelName).toBe('gemini-2.5-flash');
	});

	it('prefers an explicitly configured model over the provider default', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiProvider: 'gemini', aiModel: 'gemini-2.5-pro' }));
		global.fetch.mockResolvedValue(jsonResponse('{"answer":"ok"}'));

		const result = await requestAiChatCompletion({ feature: 'x', messages: MESSAGES, schema: SCHEMA });

		expect(lastCall().body.model).toBe('gemini-2.5-pro');
		expect(result.modelName).toBe('gemini-2.5-pro');
	});

	it('retries once in plain JSON mode when the provider rejects the schema block', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiProvider: 'gemini' }));
		global.fetch
			.mockResolvedValueOnce(
				errorResponse(400, 'Invalid JSON payload received. Unknown name "response_format.json_schema.strict"')
			)
			.mockResolvedValueOnce(jsonResponse('{"answer":"recovered"}'));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schema: SCHEMA
		});

		expect(global.fetch).toHaveBeenCalledTimes(2);
		const retry = lastCall(1).body;
		expect(retry.response_format).toEqual({ type: 'json_object' });
		// The schema is restated in the prompt, since json_object carries none.
		expect(retry.messages).toHaveLength(MESSAGES.length + 1);
		expect(retry.messages.at(-1).content).toContain('"answer"');
		expect(result).toMatchObject({ ok: true, data: { answer: 'recovered' } });
	});

	it('does not retry when the failure is unrelated to the schema', async () => {
		global.fetch.mockResolvedValue(errorResponse(401, 'Incorrect API key provided'));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schema: SCHEMA
		});

		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			ok: false,
			provider: 'openai',
			providerLabel: 'OpenAI',
			error: 'OpenAI candidate summary request failed.'
		});
	});

	it('fails without calling the provider when no key is configured', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiApiKey: '' }));

		const result = await requestAiChatCompletion({ feature: 'x', messages: MESSAGES, schema: SCHEMA });

		expect(global.fetch).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		expect(result.error).toBe('AI API key is not configured in Admin > Settings.');
	});

	it('unwraps a fenced JSON reply', async () => {
		global.fetch.mockResolvedValue(jsonResponse('```json\n{"answer":"fenced"}\n```'));

		const result = await requestAiChatCompletion({ feature: 'x', messages: MESSAGES, schema: SCHEMA });

		expect(result).toMatchObject({ ok: true, data: { answer: 'fenced' } });
	});

	it('reports unparseable JSON as an invalid reply', async () => {
		global.fetch.mockResolvedValue(jsonResponse('not json at all'));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schema: SCHEMA
		});

		expect(result).toEqual({
			ok: false,
			provider: 'openai',
			providerLabel: 'OpenAI',
			error: 'OpenAI returned an invalid candidate summary.'
		});
	});

	it('reports an empty reply', async () => {
		global.fetch.mockResolvedValue(jsonResponse('   '));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schema: SCHEMA
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe('OpenAI returned an empty candidate summary.');
	});

	it('sends no response_format and returns raw text when no schema is requested', async () => {
		global.fetch.mockResolvedValue(jsonResponse('<p>Enhanced</p>'));

		const result = await requestAiChatCompletion({
			feature: 'enhancement',
			messages: MESSAGES,
			temperature: 0.35
		});

		const { body } = lastCall();
		expect(body.response_format).toBeUndefined();
		expect(body.temperature).toBe(0.35);
		expect(result).toMatchObject({ ok: true, content: '<p>Enhanced</p>', data: null });
	});

	it('surfaces a transport failure as a provider-labelled error', async () => {
		global.fetch.mockRejectedValue(new Error('network down'));

		const result = await requestAiChatCompletion({
			feature: 'candidate summary',
			messages: MESSAGES,
			schema: SCHEMA
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe('OpenAI candidate summary is unavailable right now.');
		expect(logError).toHaveBeenCalledWith(
			'ai.request.unavailable',
			expect.objectContaining({ provider: 'openai', detail: 'network down' })
		);
	});

	it('returns the provider that answered, so callers can record provenance', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiProvider: 'gemini' }));
		global.fetch.mockResolvedValue(jsonResponse('{"answer":"ok"}'));

		const result = await requestAiChatCompletion({ feature: 'x', messages: MESSAGES, schema: SCHEMA });

		expect(result.provider).toBe('gemini');
		expect(result.providerLabel).toBe('Google Gemini');
	});

	// The resume parser degrades to the built-in parser on failure, so without
	// this log a dead key or a wrong model looks exactly like ordinary output.
	it('logs a failed request with the provider reason the caller never sees', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiProvider: 'gemini', aiModel: 'gemini-9-imaginary' }));
		global.fetch.mockResolvedValue(
			errorResponse(404, '{ "error": { "message": "models/gemini-9-imaginary is not found" } }')
		);

		const result = await requestAiChatCompletion({
			feature: 'resume parsing',
			messages: MESSAGES,
			schema: SCHEMA
		});

		expect(result.ok).toBe(false);
		expect(logError).toHaveBeenCalledTimes(1);
		expect(logError).toHaveBeenCalledWith('ai.request.failed', {
			feature: 'resume parsing',
			provider: 'gemini',
			model: 'gemini-9-imaginary',
			status: 404,
			detail: '{ "error": { "message": "models/gemini-9-imaginary is not found" } }'
		});
	});

	it('keeps the API key out of the logged detail even when the provider echoes it', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiApiKey: 'AIza-secret-value' }));
		global.fetch.mockResolvedValue(errorResponse(400, 'API key AIza-secret-value is invalid'));

		await requestAiChatCompletion({ feature: 'x', messages: MESSAGES, schema: SCHEMA });

		const { detail } = logError.mock.calls[0][1];
		expect(detail).toBe('API key [REDACTED] is invalid');
		expect(detail).not.toContain('AIza-secret-value');
	});

	it('logs the schema rejection it recovers from, rather than hiding the retry', async () => {
		getIntegrationSettings.mockResolvedValue(settings({ aiProvider: 'gemini' }));
		global.fetch
			.mockResolvedValueOnce(errorResponse(400, 'Unknown name "strict"'))
			.mockResolvedValueOnce(jsonResponse('{"answer":"recovered"}'));

		const result = await requestAiChatCompletion({ feature: 'x', messages: MESSAGES, schema: SCHEMA });

		expect(result.ok).toBe(true);
		expect(logWarn).toHaveBeenCalledWith(
			'ai.request.schema_rejected',
			expect.objectContaining({ provider: 'gemini', status: 400, detail: 'Unknown name "strict"' })
		);
		// A recovered request is a warning, never an error.
		expect(logError).not.toHaveBeenCalled();
	});
});

describe('normalizeModelContent', () => {
	it('leaves unfenced content alone and handles empty input', () => {
		expect(normalizeModelContent('{"a":1}')).toBe('{"a":1}');
		expect(normalizeModelContent('')).toBe('');
		expect(normalizeModelContent(null)).toBe('');
	});
});
