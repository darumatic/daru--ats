import { prisma } from '@/lib/prisma';
import { DEFAULT_THEME_KEY, normalizeThemeKey } from '@/lib/theme-options';
import { getIntegrationOperationFlags } from '@/lib/integration-operations';
import { AI_PROVIDER_OPENAI, normalizeAiProvider, getAiProviderProfile } from '@/lib/ai-providers';

export const DEFAULT_SITE_NAME = 'Darumatic ATS';
export const DEFAULT_SITE_LOGO_URL = '/branding/hire-gnome.png';
export const DEFAULT_API_ERROR_LOG_RETENTION_DAYS = 90;
export const DEFAULT_CAREER_HERO_TITLE = 'Find your next placement opportunity.';
export const DEFAULT_CAREER_HERO_BODY =
	'Explore active roles across healthcare, technology, and professional services. Apply directly through the listing in under two minutes.';

const INTEGRATION_SETTINGS_CACHE_TTL_MS = 30_000;
const NEXT_PHASE_PRODUCTION_BUILD = 'phase-production-build';

let integrationSettingsCache = null;
let integrationSettingsCacheAt = 0;
let integrationSettingsPromise = null;

function asTrimmedString(value) {
	if (typeof value !== 'string') return '';
	return value.trim();
}

function toBoolean(value, fallback = false) {
	if (typeof value !== 'string') return fallback;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
}

function toNullablePort(value) {
	const parsed = Number.parseInt(String(value ?? '').trim(), 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

function toBooleanFlag(value, fallback = false) {
	return typeof value === 'boolean' ? value : fallback;
}

// Model precedence: the admin setting, then OPENAI_RESUME_MODEL (kept so
// existing deployments that set it keep their model), then the provider's own
// default. The environment fallback names an OpenAI model, so it applies only
// while the provider is OpenAI - otherwise a box that still carries the old
// variable would send an OpenAI model name to Gemini every time the admin
// model field was left blank, and the field's own hint would be a lie.
function resolveAiModel(setting) {
	const provider = normalizeAiProvider(setting?.aiProvider);
	const configuredModel = asTrimmedString(setting?.aiModel);
	if (configuredModel) return configuredModel;

	if (provider === AI_PROVIDER_OPENAI) {
		const environmentModel = asTrimmedString(process.env.OPENAI_RESUME_MODEL);
		if (environmentModel) return environmentModel;
	}

	return getAiProviderProfile(provider).defaultModel;
}

export function serializeSystemBranding(setting) {
	const siteName = String(setting?.siteName || '').trim() || DEFAULT_SITE_NAME;
	const hasCustomLogo = Boolean(setting?.logoStorageKey);
	const aiAvailable = Boolean(asTrimmedString(setting?.aiApiKey));
	const logoVersion = setting?.updatedAt ? new Date(setting.updatedAt).getTime() : Date.now();
	const logoUrl = hasCustomLogo
		? `/api/system-settings/logo?v=${logoVersion}`
		: DEFAULT_SITE_LOGO_URL;

	return {
		siteName,
		siteTitle: siteName,
		logoUrl,
		themeKey: normalizeThemeKey(setting?.themeKey || DEFAULT_THEME_KEY),
		careerSiteEnabled: toBooleanFlag(setting?.careerSiteEnabled, false),
		clientPortalEnabled: toBooleanFlag(setting?.clientPortalEnabled, true),
		careerHeroTitle: asTrimmedString(setting?.careerHeroTitle) || DEFAULT_CAREER_HERO_TITLE,
		careerHeroBody: asTrimmedString(setting?.careerHeroBody) || DEFAULT_CAREER_HERO_BODY,
		aiAvailable,
		hasCustomLogo,
		updatedAt: setting?.updatedAt || null
	};
}

export function serializeAdminSystemSettings(setting) {
	const siteName = asTrimmedString(setting?.siteName) || DEFAULT_SITE_NAME;
	const aiAvailable = Boolean(asTrimmedString(setting?.aiApiKey));
	const integrationFlags = getIntegrationOperationFlags();
	const bullhornUsername = asTrimmedString(setting?.bullhornUsername);
	const bullhornPassword = asTrimmedString(setting?.bullhornPassword);
	const bullhornClientId = asTrimmedString(setting?.bullhornClientId);
	const bullhornClientSecret = asTrimmedString(setting?.bullhornClientSecret);
	return {
		careerSiteEnabled: toBooleanFlag(setting?.careerSiteEnabled, false),
		clientPortalEnabled: toBooleanFlag(setting?.clientPortalEnabled, true),
		careerHeroTitle: asTrimmedString(setting?.careerHeroTitle) || DEFAULT_CAREER_HERO_TITLE,
		careerHeroBody: asTrimmedString(setting?.careerHeroBody) || DEFAULT_CAREER_HERO_BODY,
		aiAvailable,
		apiErrorLogRetentionDays:
			Number.isInteger(setting?.apiErrorLogRetentionDays) && setting.apiErrorLogRetentionDays > 0
				? setting.apiErrorLogRetentionDays
				: DEFAULT_API_ERROR_LOG_RETENTION_DAYS,
		googleMapsApiKey: asTrimmedString(setting?.googleMapsApiKey),
		aiApiKey: asTrimmedString(setting?.aiApiKey),
		smtpHost: asTrimmedString(setting?.smtpHost),
		smtpPort: toNullablePort(setting?.smtpPort),
		smtpSecure: Boolean(setting?.smtpSecure),
		smtpUser: asTrimmedString(setting?.smtpUser),
		smtpPass: asTrimmedString(setting?.smtpPass),
		smtpFromName: asTrimmedString(setting?.smtpFromName) || siteName,
		smtpFromEmail: asTrimmedString(setting?.smtpFromEmail),
		bullhornUsername,
		bullhornPassword,
		bullhornClientId,
		bullhornClientSecret,
		bullhornCredentialsConfigured: Boolean(
			bullhornUsername
			&& bullhornPassword
			&& bullhornClientId
			&& bullhornClientSecret
		),
		objectStorageProvider: asTrimmedString(setting?.objectStorageProvider) || 's3',
		objectStorageRegion: asTrimmedString(setting?.objectStorageRegion) || 'us-east-1',
		objectStorageBucket: asTrimmedString(setting?.objectStorageBucket),
		objectStorageEndpoint: asTrimmedString(setting?.objectStorageEndpoint),
		objectStorageForcePathStyle:
			typeof setting?.objectStorageForcePathStyle === 'boolean'
				? setting.objectStorageForcePathStyle
				: true,
		objectStorageAccessKeyId: asTrimmedString(setting?.objectStorageAccessKeyId),
		objectStorageSecretAccessKey: asTrimmedString(setting?.objectStorageSecretAccessKey),
		emailTestMode: toBoolean(process.env.EMAIL_TEST_MODE, false),
		emailTestRecipient: asTrimmedString(process.env.EMAIL_TEST_RECIPIENT).toLowerCase(),
		aiProvider: normalizeAiProvider(setting?.aiProvider),
		aiModel: resolveAiModel(setting),
		bullhornOperationsEnabled: integrationFlags.bullhornOperationsEnabled,
		zohoRecruitOperationsEnabled: integrationFlags.zohoRecruitOperationsEnabled
	};
}

function normalizeIntegrationSettings(setting) {
	const siteName = asTrimmedString(setting?.siteName) || DEFAULT_SITE_NAME;

	return {
		settingsReadFailed: false,
		careerSiteEnabled: toBooleanFlag(setting?.careerSiteEnabled, false),
		clientPortalEnabled: toBooleanFlag(setting?.clientPortalEnabled, true),
		apiErrorLogRetentionDays:
			Number.isInteger(setting?.apiErrorLogRetentionDays) && setting.apiErrorLogRetentionDays > 0
				? setting.apiErrorLogRetentionDays
				: DEFAULT_API_ERROR_LOG_RETENTION_DAYS,
		googleMapsApiKey: asTrimmedString(setting?.googleMapsApiKey),
		aiApiKey: asTrimmedString(setting?.aiApiKey),
		aiProvider: normalizeAiProvider(setting?.aiProvider),
		aiModel: resolveAiModel(setting),
		smtpHost: asTrimmedString(setting?.smtpHost),
		smtpPort: toNullablePort(setting?.smtpPort),
		smtpSecure: Boolean(setting?.smtpSecure),
		smtpUser: asTrimmedString(setting?.smtpUser),
		smtpPass: asTrimmedString(setting?.smtpPass),
		smtpFromName: asTrimmedString(setting?.smtpFromName) || siteName,
		smtpFromEmail: asTrimmedString(setting?.smtpFromEmail),
		bullhornUsername: asTrimmedString(setting?.bullhornUsername),
		bullhornPassword: asTrimmedString(setting?.bullhornPassword),
		bullhornClientId: asTrimmedString(setting?.bullhornClientId),
		bullhornClientSecret: asTrimmedString(setting?.bullhornClientSecret),
		objectStorageProvider: asTrimmedString(setting?.objectStorageProvider) || 's3',
		objectStorageRegion: asTrimmedString(setting?.objectStorageRegion) || 'us-east-1',
		objectStorageBucket: asTrimmedString(setting?.objectStorageBucket),
		objectStorageEndpoint: asTrimmedString(setting?.objectStorageEndpoint),
		objectStorageForcePathStyle:
			typeof setting?.objectStorageForcePathStyle === 'boolean'
				? setting.objectStorageForcePathStyle
				: true,
		objectStorageAccessKeyId: asTrimmedString(setting?.objectStorageAccessKeyId),
		objectStorageSecretAccessKey: asTrimmedString(setting?.objectStorageSecretAccessKey),
		emailTestMode: toBoolean(process.env.EMAIL_TEST_MODE, false),
		emailTestRecipient: asTrimmedString(process.env.EMAIL_TEST_RECIPIENT).toLowerCase()
	};
}

function shouldSkipSystemSettingsDbRead() {
	if (process.env.SKIP_SYSTEM_SETTINGS_DB_DURING_BUILD === 'false') {
		return false;
	}

	return process.env.NEXT_PHASE === NEXT_PHASE_PRODUCTION_BUILD;
}

// A failed read is NOT the same as "there is no settings row yet", and
// collapsing the two is how a pending migration once became silent default
// branding with the public careers site switched off. The failure is recorded
// here and surfaced through /api/health, which is the deploy's rollback
// contract, so a deploy that breaks this read is rolled back instead of shipped.
let lastReadFailure = null;
let lastReadFailureLoggedAt = 0;
const READ_FAILURE_LOG_INTERVAL_MS = 60_000;

export function getSystemSettingsReadFailure() {
	return lastReadFailure;
}

export function clearSystemSettingsReadFailure() {
	lastReadFailure = null;
}

/**
 * Reads the settings row, distinguishing "no row" from "the read failed".
 * Returns { ok, setting, error } — ok:false means the row could not be read and
 * callers must NOT treat the absent values as real configuration.
 */
export async function readSystemSettingRecord() {
	if (shouldSkipSystemSettingsDbRead()) {
		return { ok: true, setting: null, error: null };
	}

	try {
		const setting = await prisma.systemSetting.findFirst({
			orderBy: {
				id: 'asc'
			}
		});
		lastReadFailure = null;
		lastReadFailureLoggedAt = 0;
		return { ok: true, setting, error: null };
	} catch (error) {
		const message = error?.message || 'system_settings_read_failed';
		// Never silent - but a sustained fault is read by every settings consumer,
		// so log the first occurrence and then at most once a minute rather than a
		// stack trace per request.
		const now = Date.now();
		if (lastReadFailure?.message !== message || now - lastReadFailureLoggedAt >= READ_FAILURE_LOG_INTERVAL_MS) {
			console.error('[system-settings] failed to read the SystemSetting record:', error);
			lastReadFailureLoggedAt = now;
		}
		lastReadFailure = { at: new Date().toISOString(), message };
		return { ok: false, setting: null, error };
	}
}

export async function getSystemSettingRecord() {
	const { setting } = await readSystemSettingRecord();
	return setting;
}

export async function getSystemBranding() {
	const setting = await getSystemSettingRecord();
	return serializeSystemBranding(setting);
}

export function clearSystemSettingsCache() {
	integrationSettingsCache = null;
	integrationSettingsCacheAt = 0;
	integrationSettingsPromise = null;
}

export async function getIntegrationSettings({ forceRefresh = false } = {}) {
	const now = Date.now();
	if (!forceRefresh && integrationSettingsCache && now - integrationSettingsCacheAt < INTEGRATION_SETTINGS_CACHE_TTL_MS) {
		return integrationSettingsCache;
	}

	if (!forceRefresh && integrationSettingsPromise) {
		return integrationSettingsPromise;
	}

	integrationSettingsPromise = (async () => {
		const { ok, setting } = await readSystemSettingRecord();
		const normalized = normalizeIntegrationSettings(setting);
		normalized.settingsReadFailed = !ok;
		// Only cache a real read. Caching a failure would serve defaults for the
		// full TTL and hide the fault from the very next caller.
		if (ok) {
			integrationSettingsCache = normalized;
			integrationSettingsCacheAt = Date.now();
		}
		return normalized;
	})().finally(() => {
		integrationSettingsPromise = null;
	});

	return integrationSettingsPromise;
}
