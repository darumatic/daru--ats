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

	// OPENAI_RESUME_MODEL names an OpenAI model, so on Gemini it would be sent
	// to Google verbatim and fail every call - and the admin field's hint
	// promises the provider default when it is left blank.
	it('ignores OPENAI_RESUME_MODEL on a provider it cannot name', async () => {
		process.env.OPENAI_RESUME_MODEL = 'gpt-4o-mini';

		const settings = await settingsFor({ aiApiKey: 'AIza-key', aiProvider: 'gemini' });

		expect(settings.aiModel).toBe('gemini-2.5-flash');
		expect(serializeAdminSystemSettings({ aiApiKey: 'AIza-key', aiProvider: 'gemini' }).aiModel).toBe(
			'gemini-2.5-flash'
		);
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

// The reasoning model is deliberately a second, optional model used only by
// candidate scoring. Blank must mean "off" rather than falling back to a
// provider default, or every install would start paying for a reasoning model
// nobody asked for.
describe('reasoning model resolution', () => {
	beforeEach(() => {
		clearSystemSettingsCache();
	});

	afterEach(() => {
		clearSystemSettingsCache();
	});

	it('is empty on a row that has never set one', async () => {
		const settings = await settingsFor({ aiApiKey: 'sk-existing' });

		expect(settings.aiReasoningModel).toBe('');
	});

	it('does not inherit the standard model or the provider default', async () => {
		const settings = await settingsFor({ aiApiKey: 'sk', aiModel: 'gpt-4o', aiProvider: 'openai' });

		expect(settings.aiModel).toBe('gpt-4o');
		expect(settings.aiReasoningModel).toBe('');
	});

	it('carries a configured reasoning model through', async () => {
		const settings = await settingsFor({ aiApiKey: 'sk', aiModel: 'gpt-4o-mini', aiReasoningModel: '  o3  ' });

		expect(settings.aiReasoningModel).toBe('o3');
		expect(settings.aiModel).toBe('gpt-4o-mini');
	});

	it('exposes it to administrators alongside the standard model', () => {
		const serialized = serializeAdminSystemSettings({
			aiApiKey: 'sk',
			aiModel: 'gpt-4o-mini',
			aiReasoningModel: 'o3'
		});

		expect(serialized.aiReasoningModel).toBe('o3');
	});
});
