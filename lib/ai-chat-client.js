import { getIntegrationSettings } from '@/lib/system-settings';
import { logError, logWarn } from '@/lib/logger';
import {
	getAiProviderProfile,
	normalizeAiProvider,
	buildChatCompletionsUrl
} from '@/lib/ai-providers';

// Gemini's compatibility layer accepts response_format json_schema including
// `strict` (verified live against gemini-flash-latest), but Google documents
// the layer as beta and drops or rejects fields it does not support, so this
// stays a safety net rather than a dead branch. When a schema request comes
// back as a 400 that names the response format, retry once in plain JSON mode
// and let the caller's Zod schema stay the real guard.
const SCHEMA_REJECTION_PATTERN = /response_format|json_schema|responseschema|schema|strict/i;
const FAILURE_DETAIL_MAX_LENGTH = 300;

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

function buildRequestBody({ model, temperature, messages, schemaName, schema, strictSchema }) {
	const body = { model, temperature, messages };
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

async function postChatCompletion({ url, apiKey, body }) {
	return fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
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
	integrationSettings = null
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

	const model = asTrimmedString(settings?.aiModel) || profile.defaultModel;
	const url = buildChatCompletionsUrl(provider);
	const logContext = { feature, provider, model };

	try {
		let response = await postChatCompletion({
			url,
			apiKey,
			body: buildRequestBody({
				model,
				temperature,
				messages,
				schemaName,
				schema,
				strictSchema: Boolean(schema)
			})
		});
		let failureBody = response.ok ? '' : await response.text().catch(() => '');

		if (!response.ok && schema && response.status === 400 && SCHEMA_REJECTION_PATTERN.test(failureBody)) {
			logWarn('ai.request.schema_rejected', {
				...logContext,
				status: response.status,
				detail: toFailureDetail(failureBody, apiKey)
			});
			response = await postChatCompletion({
				url,
				apiKey,
				body: buildRequestBody({
					model,
					temperature,
					messages,
					schemaName,
					schema,
					strictSchema: false
				})
			});
			failureBody = response.ok ? '' : await response.text().catch(() => '');
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
			return { ok: true, content, data: null, modelName: model, provider, providerLabel };
		}

		try {
			return {
				ok: true,
				content,
				data: JSON.parse(content),
				modelName: model,
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
