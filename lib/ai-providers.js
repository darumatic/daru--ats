// Provider catalogue for the AI features. Dependency-free on purpose: the
// admin settings page (a client component) imports it for the provider select,
// so it must not pull in Prisma or anything server-only.
//
// Every provider is reached through the OpenAI chat-completions wire format —
// Google publishes an OpenAI-compatible endpoint — so a provider is a base URL
// and a default model rather than a separate client.
export const AI_PROVIDER_OPENAI = 'openai';
export const AI_PROVIDER_GEMINI = 'gemini';

export const AI_PROVIDER_PROFILES = {
	[AI_PROVIDER_OPENAI]: {
		value: AI_PROVIDER_OPENAI,
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		defaultModel: 'gpt-4o-mini',
		apiKeyHint: 'Create a key at platform.openai.com.'
	},
	[AI_PROVIDER_GEMINI]: {
		value: AI_PROVIDER_GEMINI,
		label: 'Google Gemini',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		defaultModel: 'gemini-2.5-flash',
		apiKeyHint: 'Create a key at aistudio.google.com/apikey.'
	}
};

export const AI_PROVIDER_OPTIONS = Object.values(AI_PROVIDER_PROFILES).map((profile) => ({
	value: profile.value,
	label: profile.label,
	defaultModel: profile.defaultModel,
	apiKeyHint: profile.apiKeyHint
}));

// An unset provider means OpenAI, which is how every record behaved before the
// provider column existed.
export function normalizeAiProvider(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return AI_PROVIDER_PROFILES[normalized] ? normalized : AI_PROVIDER_OPENAI;
}

export function getAiProviderProfile(value) {
	return AI_PROVIDER_PROFILES[normalizeAiProvider(value)];
}

export function buildChatCompletionsUrl(provider) {
	return `${getAiProviderProfile(provider).baseUrl}/chat/completions`;
}

// Reasoning models reject any temperature other than their default, so the
// chat client has to leave the field out entirely for them. This is the fast
// path, not the guarantee: the list of model names will go stale the week a new
// one ships, which is why the client also retries without temperature when a
// provider rejects it by name.
const REASONING_MODEL_PATTERNS = [
	/^o\d/i,
	/^gpt-5/i,
	/(^|[-_])(thinking|reasoning)([-_]|$)/i
];

export function isReasoningModel(modelName) {
	const normalized = String(modelName ?? '').trim();
	if (!normalized) return false;
	return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}
