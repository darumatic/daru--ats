import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pins the three additions candidate scoring needed from the shared AI client:
// a per-call model, the ability to leave temperature out for models that reject
// it, and a request timeout - there was none at all, so a provider that went
// quiet held the request until the platform killed it.
//
// The load-bearing assertion is the last one: a caller passing none of the new
// options must send exactly the body it sent before.

vi.mock('@/lib/system-settings', () => ({ getIntegrationSettings: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));

import { getIntegrationSettings } from '@/lib/system-settings';
import { logError, logWarn } from '@/lib/logger';
import { requestAiChatCompletion } from '@/lib/ai-chat-client';
import { isReasoningModel } from '@/lib/ai-providers';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

function okResponse(content = '{"ok":true}') {
	return {
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content } }] })
	};
}

function errorResponse(status, body) {
	return { ok: false, status, text: async () => body };
}

function sentBody(callIndex = 0) {
	return JSON.parse(globalThis.fetch.mock.calls[callIndex][1].body);
}

beforeEach(() => {
	getIntegrationSettings.mockReset();
	getIntegrationSettings.mockResolvedValue({ aiApiKey: 'sk-test', aiProvider: 'openai', aiModel: 'gpt-4o-mini' });
	logError.mockReset();
	logWarn.mockReset();
	globalThis.fetch = vi.fn();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('isReasoningModel', () => {
	it('recognises the model families that reject a chosen temperature', () => {
		expect(isReasoningModel('o3')).toBe(true);
		expect(isReasoningModel('o4-mini')).toBe(true);
		expect(isReasoningModel('gpt-5-mini')).toBe(true);
		expect(isReasoningModel('gemini-2.5-flash-thinking')).toBe(true);
	});

	it('leaves ordinary models alone', () => {
		expect(isReasoningModel('gpt-4o-mini')).toBe(false);
		expect(isReasoningModel('gemini-2.5-flash')).toBe(false);
		expect(isReasoningModel('')).toBe(false);
		expect(isReasoningModel(null)).toBe(false);
	});
});

describe('per-call model override', () => {
	it('uses the caller’s model over the stored one', async () => {
		globalThis.fetch.mockResolvedValue(okResponse());

		const result = await requestAiChatCompletion({
			feature: 'candidate scoring',
			messages: [{ role: 'user', content: 'hi' }],
			model: 'o3'
		});

		expect(sentBody().model).toBe('o3');
		expect(result.modelName).toBe('o3');
	});

	it('falls back to the stored model when the caller names none', async () => {
		globalThis.fetch.mockResolvedValue(okResponse());

		await requestAiChatCompletion({ feature: 'x', messages: [{ role: 'user', content: 'hi' }], model: '  ' });

		expect(sentBody().model).toBe('gpt-4o-mini');
	});
});

describe('temperature handling', () => {
	it('omits temperature for a model known to reject it', async () => {
		globalThis.fetch.mockResolvedValue(okResponse());

		await requestAiChatCompletion({
			feature: 'candidate scoring',
			messages: [{ role: 'user', content: 'hi' }],
			model: 'gpt-5-mini'
		});

		expect(sentBody()).not.toHaveProperty('temperature');
	});

	it('omits temperature when the caller asks it to', async () => {
		globalThis.fetch.mockResolvedValue(okResponse());

		await requestAiChatCompletion({
			feature: 'x',
			messages: [{ role: 'user', content: 'hi' }],
			omitTemperature: true
		});

		expect(sentBody()).not.toHaveProperty('temperature');
	});

	it('retries once without temperature when a provider rejects it by name', async () => {
		globalThis.fetch
			.mockResolvedValueOnce(
				errorResponse(400, '{"error":{"message":"Unsupported value: temperature does not support 0.2"}}')
			)
			.mockResolvedValueOnce(okResponse());

		const result = await requestAiChatCompletion({
			feature: 'candidate scoring',
			messages: [{ role: 'user', content: 'hi' }],
			model: 'brand-new-model'
		});

		expect(result.ok).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(sentBody(0)).toHaveProperty('temperature');
		expect(sentBody(1)).not.toHaveProperty('temperature');
		expect(logWarn).toHaveBeenCalledWith('ai.request.temperature_rejected', expect.any(Object));
	});

	it('does not retry the temperature downgrade twice', async () => {
		globalThis.fetch.mockResolvedValue(
			errorResponse(400, '{"error":{"message":"Unsupported value: temperature"}}')
		);

		const result = await requestAiChatCompletion({
			feature: 'x',
			messages: [{ role: 'user', content: 'hi' }],
			model: 'brand-new-model'
		});

		expect(result.ok).toBe(false);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('can downgrade the temperature and the schema in the same request', async () => {
		globalThis.fetch
			.mockResolvedValueOnce(errorResponse(400, '{"error":{"message":"Unsupported value: temperature"}}'))
			.mockResolvedValueOnce(errorResponse(400, '{"error":{"message":"response_format json_schema is not supported"}}'))
			.mockResolvedValueOnce(okResponse());

		const result = await requestAiChatCompletion({
			feature: 'x',
			messages: [{ role: 'user', content: 'hi' }],
			schema: SCHEMA,
			schemaName: 'probe',
			model: 'brand-new-model'
		});

		expect(result.ok).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
		expect(sentBody(2)).not.toHaveProperty('temperature');
		expect(sentBody(2).response_format).toEqual({ type: 'json_object' });
	});
});

describe('request timeout', () => {
	it('reports an aborted request as a timeout rather than a dead provider', async () => {
		globalThis.fetch.mockImplementation(() => {
			const error = new Error('The operation was aborted.');
			error.name = 'AbortError';
			return Promise.reject(error);
		});

		const result = await requestAiChatCompletion({
			feature: 'candidate scoring',
			messages: [{ role: 'user', content: 'hi' }],
			timeoutMs: 5000
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain('timed out after 5s');
		expect(logError).toHaveBeenCalledWith('ai.request.timeout', expect.objectContaining({ timeoutMs: 5000 }));
	});

	it('passes an abort signal on every attempt', async () => {
		globalThis.fetch.mockResolvedValue(okResponse());

		await requestAiChatCompletion({ feature: 'x', messages: [{ role: 'user', content: 'hi' }] });

		expect(globalThis.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
	});
});

describe('backwards compatibility', () => {
	it('sends the same body as before when a caller passes none of the new options', async () => {
		globalThis.fetch.mockResolvedValue(okResponse());

		await requestAiChatCompletion({
			feature: 'match explanation',
			temperature: 0.25,
			schemaName: 'match_explanation',
			schema: SCHEMA,
			messages: [{ role: 'user', content: 'hi' }]
		});

		expect(sentBody()).toEqual({
			model: 'gpt-4o-mini',
			temperature: 0.25,
			messages: [{ role: 'user', content: 'hi' }],
			response_format: {
				type: 'json_schema',
				json_schema: { name: 'match_explanation', strict: true, schema: SCHEMA }
			}
		});
	});
});
