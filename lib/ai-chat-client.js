import { getIntegrationSettings } from '@/lib/system-settings';
import { getAiProviderProfile, buildChatCompletionsUrl } from '@/lib/ai-providers';

// Gemini's compatibility layer accepts response_format json_schema on live
// requests, but `strict` is undocumented there and unsupported fields are
// either dropped or rejected. When a schema request comes back as a 400 that
// names the response format, retry once in plain JSON mode and let the
// caller's Zod schema stay the real guard.
const SCHEMA_REJECTION_PATTERN = /response_format|json_schema|responseschema|schema|strict/i;

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
 * Returns { ok: true, content, data, modelName, providerLabel } on success —
 * `data` is the parsed JSON object when a schema was requested. On failure it
 * returns { ok: false, error, providerLabel } with a message safe to surface.
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
	const profile = getAiProviderProfile(settings?.aiProvider);
	const providerLabel = profile.label;
	const apiKey = asTrimmedString(settings?.aiApiKey);

	if (!apiKey) {
		return {
			ok: false,
			providerLabel,
			error: 'AI API key is not configured in Admin > Settings.'
		};
	}

	const model = asTrimmedString(settings?.aiModel) || profile.defaultModel;
	const url = buildChatCompletionsUrl(settings?.aiProvider);

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

		if (!response.ok && schema && response.status === 400) {
			const rejection = await response.text().catch(() => '');
			if (SCHEMA_REJECTION_PATTERN.test(rejection)) {
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
			}
		}

		if (!response.ok) {
			return {
				ok: false,
				providerLabel,
				error: `${providerLabel} ${feature} request failed.`
			};
		}

		const payload = await response.json().catch(() => ({}));
		const rawContent = payload?.choices?.[0]?.message?.content || '';
		const content = schema ? normalizeModelContent(rawContent) : rawContent;

		if (!asTrimmedString(String(content))) {
			return {
				ok: false,
				providerLabel,
				error: `${providerLabel} returned an empty ${feature}.`
			};
		}

		if (!schema) {
			return { ok: true, content, data: null, modelName: model, providerLabel };
		}

		try {
			return { ok: true, content, data: JSON.parse(content), modelName: model, providerLabel };
		} catch {
			return {
				ok: false,
				providerLabel,
				error: `${providerLabel} returned an invalid ${feature}.`
			};
		}
	} catch {
		return {
			ok: false,
			providerLabel,
			error: `${providerLabel} ${feature} is unavailable right now.`
		};
	}
}
