import { getIntegrationSettings } from '@/lib/system-settings';
import { logError, logWarn } from '@/lib/logger';
import {
	getAiProviderProfile,
	isReasoningModel,
	normalizeAiProvider,
	buildChatCompletionsUrl
} from '@/lib/ai-providers';
import { AI_REQUEST_TIMEOUT_SECONDS } from '@/lib/security-constants';

// Gemini's compatibility layer accepts response_format json_schema including
// `strict` (verified live against gemini-flash-latest), but Google documents
// the layer as beta and drops or rejects fields it does not support, so this
// stays a safety net rather than a dead branch. When a schema request comes
// back as a 400 that names the response format, retry once in plain JSON mode
// and let the caller's Zod schema stay the real guard.
const SCHEMA_REJECTION_PATTERN = /response_format|json_schema|responseschema|schema|strict/i;
// Reasoning models reject a temperature they did not choose. isReasoningModel
// catches the ones we know by name; this catches the ones we do not, which is
// the case that actually matters as new models ship.
const TEMPERATURE_REJECTION_PATTERN = /temperature|unsupported[_ ]value/i;
const FAILURE_DETAIL_MAX_LENGTH = 300;
// Two independent downgrades - drop the temperature, drop the strict schema -
// each applied at most once, so three attempts is the ceiling.
const MAX_ATTEMPTS = 3;

function asTrimmedString(value) {
	if (typeof value !== 'string') return '';
	return value.trim();
}

// Models are asked for JSON but often answer in a fenced block.
export function normalizeModelContent(value) {
	const raw = String(value ?? '').trim();
	if (!raw) return '';
	const fencedMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fencedMatch ? fencedMatch[1].trim() : raw;
}

// What the provider said, trimmed to one loggable line. The key is stripped by
// value rather than by field name: this is a raw body, so the logger's
// field-name redaction cannot see into it.
function toFailureDetail(body, apiKey) {
	const collapsed = String(body ?? '').replace(/\s+/g, ' ').trim();
	const redacted = apiKey ? collapsed.split(apiKey).join('[REDACTED]') : collapsed;
	return redacted.slice(0, FAILURE_DETAIL_MAX_LENGTH);
}

function buildRequestBody({
	model,
	temperature,
	messages,
	schemaName,
	schema,
	strictSchema,
	includeTemperature
}) {
	const body = includeTemperature ? { model, temperature, messages } : { model, messages };
	if (!schema) return body;

	if (strictSchema) {
		body.response_format = {
			type: 'json_schema',
			json_schema: { name: schemaName, strict: true, schema }
		};
		return body;
	}

	// Plain JSON mode carries no schema of its own, so restate the shape in the
	// prompt — otherwise the model is only told "return JSON".
	body.response_format = { type: 'json_object' };
	body.messages = [
		...messages,
		{
			role: 'user',
			content: `Return only a JSON object matching this schema: ${JSON.stringify(schema)}`
		}
	];
	return body;
}

// There was no timeout here at all, so a provider that accepted the connection
// and then went quiet held the request until the platform killed it. The abort
// surfaces through the caller's catch as ai.request.timeout.
async function postChatCompletion({ url, apiKey, body, timeoutMs }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Runs one chat completion against the configured provider.
 *
 * Returns { ok: true, content, data, modelName, provider, providerLabel } on
 * success — `data` is the parsed JSON object when a schema was requested. On
 * failure it returns { ok: false, error, provider, providerLabel } with a
 * message safe to surface. Every failure is also logged server-side with the
 * provider's own reason: callers such as the resume parser degrade to a
 * non-AI path on failure, so without this a broken key or model looks like
 * ordinary output.
 */
export async function requestAiChatCompletion({
	feature,
	messages,
	temperature = 0.2,
	schemaName,
	schema = null,
	integrationSettings = null,
	model = null,
	omitTemperature = false,
	timeoutMs = AI_REQUEST_TIMEOUT_SECONDS * 1000
}) {
	const settings = integrationSettings || (await getIntegrationSettings());
	const provider = normalizeAiProvider(settings?.aiProvider);
	const profile = getAiProviderProfile(provider);
	const providerLabel = profile.label;
	const apiKey = asTrimmedString(settings?.aiApiKey);

	if (!apiKey) {
		return {
			ok: false,
			provider,
			providerLabel,
			error: 'AI API key is not configured in Admin > Settings.'
		};
	}

	// A caller-supplied model wins, which is how candidate scoring reaches for
	// the reasoning model without changing what every other feature uses.
	const resolvedModel = asTrimmedString(model) || asTrimmedString(settings?.aiModel) || profile.defaultModel;
	const url = buildChatCompletionsUrl(provider);
	const logContext = { feature, provider, model: resolvedModel };

	// One retry ladder rather than nested pairs: each downgrade is attempted at
	// most once, and a failure that is neither is returned as-is instead of
	// being retried blindly.
	let dropTemperature = Boolean(omitTemperature) || isReasoningModel(resolvedModel);
	let dropStrictSchema = false;
	let response = null;
	let failureBody = '';

	try {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			response = await postChatCompletion({
				url,
				apiKey,
				timeoutMs,
				body: buildRequestBody({
					model: resolvedModel,
					temperature,
					messages,
					schemaName,
					schema,
					strictSchema: Boolean(schema) && !dropStrictSchema,
					includeTemperature: !dropTemperature
				})
			});

			if (response.ok) {
				failureBody = '';
				break;
			}
			failureBody = await response.text().catch(() => '');

			if (response.status === 400 && !dropTemperature && TEMPERATURE_REJECTION_PATTERN.test(failureBody)) {
				logWarn('ai.request.temperature_rejected', {
					...logContext,
					status: response.status,
					detail: toFailureDetail(failureBody, apiKey)
				});
				dropTemperature = true;
				continue;
			}

			if (
				response.status === 400 &&
				schema &&
				!dropStrictSchema &&
				SCHEMA_REJECTION_PATTERN.test(failureBody)
			) {
				logWarn('ai.request.schema_rejected', {
					...logContext,
					status: response.status,
					detail: toFailureDetail(failureBody, apiKey)
				});
				dropStrictSchema = true;
				continue;
			}

			break;
		}

		if (!response.ok) {
			logError('ai.request.failed', {
				...logContext,
				status: response.status,
				detail: toFailureDetail(failureBody, apiKey)
			});
			return {
				ok: false,
				provider,
				providerLabel,
				error: `${providerLabel} ${feature} request failed.`
			};
		}

		const payload = await response.json().catch(() => ({}));
		const rawContent = payload?.choices?.[0]?.message?.content || '';
		const content = schema ? normalizeModelContent(rawContent) : rawContent;

		if (!asTrimmedString(String(content))) {
			logError('ai.response.empty', logContext);
			return {
				ok: false,
				provider,
				providerLabel,
				error: `${providerLabel} returned an empty ${feature}.`
			};
		}

		if (!schema) {
			return { ok: true, content, data: null, modelName: resolvedModel, provider, providerLabel };
		}

		try {
			return {
				ok: true,
				content,
				data: JSON.parse(content),
				modelName: resolvedModel,
				provider,
				providerLabel
			};
		} catch {
			logError('ai.response.invalid_json', {
				...logContext,
				detail: toFailureDetail(content, apiKey)
			});
			return {
				ok: false,
				provider,
				providerLabel,
				error: `${providerLabel} returned an invalid ${feature}.`
			};
		}
	} catch (error) {
		if (error?.name === 'AbortError') {
			logError('ai.request.timeout', { ...logContext, timeoutMs });
			return {
				ok: false,
				provider,
				providerLabel,
				error: `${providerLabel} ${feature} timed out after ${Math.round(timeoutMs / 1000)}s.`
			};
		}
		logError('ai.request.unavailable', {
			...logContext,
			detail: toFailureDetail(error?.message, apiKey)
		});
		return {
			ok: false,
			provider,
			providerLabel,
			error: `${providerLabel} ${feature} is unavailable right now.`
		};
	}
}
