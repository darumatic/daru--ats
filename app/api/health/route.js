import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { getIntegrationSettings, readSystemSettingRecord } from '@/lib/system-settings';
import { getOnboardingState } from '@/lib/onboarding';
import { getObjectStorageConfig } from '@/lib/object-storage';

export const dynamic = 'force-dynamic';

function readEnvFileValues() {
	try {
		return fs
			.readFile(path.resolve(process.cwd(), '.env'), 'utf8')
			.then((content) => {
				const values = {};
				for (const line of content.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith('#')) continue;
					const index = trimmed.indexOf('=');
					if (index < 0) continue;
					const key = trimmed.slice(0, index).trim();
					values[key] = true;
				}
				return values;
			})
			.catch(() => ({}));
	} catch {
		return Promise.resolve({});
	}
}

async function hasDatabaseConnection() {
	const start = Date.now();
	try {
		await prisma.$queryRaw`SELECT 1`;
		return {
			ok: true,
			responseMs: Date.now() - start
		};
	} catch (error) {
		return {
			ok: false,
			error: error?.message || 'database_unavailable'
		};
	}
}

function buildPresenceFlag(value) {
	return Boolean(String(value || '').trim());
}

async function buildIntegrationHealth() {
	try {
		const integrationSettings = await getIntegrationSettings();
		const objectStorage = await getObjectStorageConfig();
		// An unreadable configuration is not a working "local mode" deployment:
		// uploads are refused in that state, so it must not report as configured.
		const objectStorageConfigured = integrationSettings.settingsReadFailed
			? false
			: objectStorage.mode === 'local'
				? true
				: buildPresenceFlag(objectStorage.bucket);
		return {
			ai: buildPresenceFlag(integrationSettings.aiApiKey),
			googleMaps: buildPresenceFlag(integrationSettings.googleMapsApiKey),
			smtp: buildPresenceFlag(integrationSettings.smtpHost)
				&& buildPresenceFlag(integrationSettings.smtpUser),
			aiProvider: integrationSettings.aiProvider || 'default',
			aiModel: integrationSettings.aiModel || 'default',
			careerSiteEnabled: Boolean(integrationSettings.careerSiteEnabled),
			objectStorageMode: objectStorage.mode,
			objectStorageConfigured
		};
	} catch {
		return {
			ai: false,
			googleMaps: false,
			smtp: false,
			aiProvider: 'default',
			aiModel: 'default',
			careerSiteEnabled: false,
			objectStorageMode: 'local',
			objectStorageConfigured: false
		};
	}
}

async function getHealthStatus() {
	// The settings read is probed FRESH on every health check rather than read
	// off the recorded failure state. That state is process-global and sticky
	// until something happens to re-read successfully, so trusting it here would
	// let one transient error hold the endpoint at 503 - and this endpoint is
	// what the deploy gates its rollback on, so a stale 503 would roll back a
	// perfectly good deploy. A live probe reports what is true right now.
	const [db, onboardingState, envVars, integration, settingsRead] = await Promise.all([
		hasDatabaseConnection(),
		getOnboardingState(),
		readEnvFileValues(),
		buildIntegrationHealth(),
		readSystemSettingRecord()
	]);

	// A database answering SELECT 1 is not enough to call the app healthy: it can
	// be up while the settings row is unreadable (schema drift, a pending
	// migration), which silently reverts branding and takes the careers site
	// offline. That has to report unhealthy or a broken deploy stays live.
	const systemSettings = settingsRead.ok
		? { ok: true }
		: { ok: false, error: settingsRead.error?.message || 'system_settings_read_failed' };

	return {
		timestamp: new Date().toISOString(),
		version: process.env.npm_package_version || '0.1.0',
		service: 'Hire Gnome ATS',
		ok: db.ok && onboardingState !== null && systemSettings.ok,
		systemSettings,
		database: {
			...db
		},
		onboarding: {
			needsOnboarding: onboardingState?.needsOnboarding ?? true,
			hasUsers: Boolean(onboardingState?.hasUsers),
			hasSystemSetting: Boolean(onboardingState?.hasSystemSetting)
		},
		config: {
			nodeEnv: process.env.NODE_ENV || 'development',
			authSessionSecretConfigured: buildPresenceFlag(process.env.AUTH_SESSION_SECRET),
			rateLimitSecretConfigured: buildPresenceFlag(process.env.RATE_LIMIT_SECRET),
			envFilePresent: Boolean(envVars?.DATABASE_URL && envVars?.AUTH_SESSION_SECRET),
			integrations: integration
		}
	};
}

export async function GET() {
	const health = await getHealthStatus();
	const statusCode = health.database.ok && health.systemSettings.ok ? 200 : 503;
	return NextResponse.json(health, {
		status: statusCode,
		headers: {
			'Cache-Control': 'no-store'
		}
	});
}
