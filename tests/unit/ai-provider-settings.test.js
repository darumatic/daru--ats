import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Covers how a stored SystemSetting row becomes AI configuration: an
// untouched row (no provider, no model) must resolve exactly as it did before
// the provider column existed, and the model must follow
// setting -> OPENAI_RESUME_MODEL -> provider default.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: { systemSetting: { findFirst: vi.fn() } }
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

const {
	normalizeAiProvider,
	getAiProviderProfile,
	buildChatCompletionsUrl,
	AI_PROVIDER_OPTIONS
} = await import('@/lib/ai-providers');
const { getIntegrationSettings, clearSystemSettingsCache, serializeAdminSystemSettings } =
	await import('@/lib/system-settings');

const ORIGINAL_MODEL_ENV = process.env.OPENAI_RESUME_MODEL;

async function settingsFor(record) {
	prismaMock.systemSetting.findFirst.mockResolvedValue(record);
	clearSystemSettingsCache();
	return getIntegrationSettings({ forceRefresh: true });
}

describe('normalizeAiProvider', () => {
	it('treats anything unrecognised as OpenAI, so existing rows keep working', () => {
		expect(normalizeAiProvider(null)).toBe('openai');
		expect(normalizeAiProvider('')).toBe('openai');
		expect(normalizeAiProvider('anthropic')).toBe('openai');
		expect(normalizeAiProvider(undefined)).toBe('openai');
	});

	it('accepts a known provider regardless of casing or padding', () => {
		expect(normalizeAiProvider('gemini')).toBe('gemini');
		expect(normalizeAiProvider('  GEMINI ')).toBe('gemini');
	});
});

describe('buildChatCompletionsUrl', () => {
	it('maps each provider to its chat-completions endpoint', () => {
		expect(buildChatCompletionsUrl('openai')).toBe('https://api.openai.com/v1/chat/completions');
		expect(buildChatCompletionsUrl('gemini')).toBe(
			'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
		);
	});

	it('offers both providers to the settings UI', () => {
		expect(AI_PROVIDER_OPTIONS.map((option) => option.value)).toEqual(['openai', 'gemini']);
		expect(getAiProviderProfile('gemini').defaultModel).toBe('gemini-2.5-flash');
	});
});

describe('integration settings AI resolution', () => {
	beforeEach(() => {
		delete process.env.OPENAI_RESUME_MODEL;
		clearSystemSettingsCache();
	});

	afterEach(() => {
		if (ORIGINAL_MODEL_ENV === undefined) delete process.env.OPENAI_RESUME_MODEL;
		else process.env.OPENAI_RESUME_MODEL = ORIGINAL_MODEL_ENV;
		clearSystemSettingsCache();
	});

	it('reads a pre-provider row as OpenAI on its default model', async () => {
		const settings = await settingsFor({ aiApiKey: 'sk-existing' });

		expect(settings.aiProvider).toBe('openai');
		expect(settings.aiModel).toBe('gpt-4o-mini');
		expect(settings.aiApiKey).toBe('sk-existing');
	});

	it('falls back to OPENAI_RESUME_MODEL when no model is stored', async () => {
		process.env.OPENAI_RESUME_MODEL = 'gpt-4o';

		const settings = await settingsFor({ aiApiKey: 'sk-existing' });

		expect(settings.aiModel).toBe('gpt-4o');
	});

	it('lets a stored model win over the environment variable', async () => {
		process.env.OPENAI_RESUME_MODEL = 'gpt-4o';

		const settings = await settingsFor({
			aiApiKey: 'AIza-key',
			aiProvider: 'gemini',
			aiModel: 'gemini-2.5-pro'
		});

		expect(settings.aiProvider).toBe('gemini');
		expect(settings.aiModel).toBe('gemini-2.5-pro');
	});

	it('uses the Gemini default model when only the provider is set', async () => {
		const settings = await settingsFor({ aiApiKey: 'AIza-key', aiProvider: 'gemini' });

		expect(settings.aiModel).toBe('gemini-2.5-flash');
	});

	it('reports AI as available to admins whenever a key is stored', () => {
		expect(serializeAdminSystemSettings({ aiApiKey: 'AIza-key', aiProvider: 'gemini' })).toMatchObject({
			aiAvailable: true,
			aiProvider: 'gemini',
			aiApiKey: 'AIza-key'
		});
		expect(serializeAdminSystemSettings({ aiApiKey: '' }).aiAvailable).toBe(false);
	});
});
