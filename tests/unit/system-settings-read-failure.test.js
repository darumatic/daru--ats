import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression cover for the 2026-09-09 outage: a migration that had not been
// applied made every full read of the SystemSetting row throw, a bare catch
// swallowed it, and the app served hardcoded defaults - reverting branding and
// switching the public careers site off - while /api/health still reported 200.
// The read must now distinguish "no row" from "the read failed", must never be
// silent, and must not be cached.

const { prismaMock } = vi.hoisted(() => ({
	prismaMock: { systemSetting: { findFirst: vi.fn(), count: vi.fn() } }
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

const {
	readSystemSettingRecord,
	getSystemSettingRecord,
	getSystemSettingsReadFailure,
	clearSystemSettingsReadFailure,
	clearSystemSettingsCache,
	getIntegrationSettings,
	serializeSystemBranding
} = await import('@/lib/system-settings');

// The shape Prisma raises when the generated client selects a column the
// database does not have - exactly what a pending migration produces.
function missingColumnError() {
	const error = new Error(
		'The column `SystemSetting.aiProvider` does not exist in the current database.'
	);
	error.code = 'P2022';
	return error;
}

const STORED_ROW = {
	id: 1,
	siteName: 'Darumatic ATS',
	themeKey: 'sunset',
	careerSiteEnabled: true,
	logoStorageKey: 'branding/logo.png',
	smtpHost: 'smtp.example.com',
	updatedAt: new Date('2026-06-24T04:30:36.910Z')
};

describe('readSystemSettingRecord', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		prismaMock.systemSetting.findFirst.mockReset();
		clearSystemSettingsReadFailure();
		clearSystemSettingsCache();
	});

	afterEach(() => {
		clearSystemSettingsReadFailure();
		clearSystemSettingsCache();
	});

	it('separates a failed read from an absent row', async () => {
		prismaMock.systemSetting.findFirst.mockResolvedValue(null);
		await expect(readSystemSettingRecord()).resolves.toEqual({
			ok: true,
			setting: null,
			error: null
		});
		expect(getSystemSettingsReadFailure()).toBeNull();

		prismaMock.systemSetting.findFirst.mockRejectedValue(missingColumnError());
		const failed = await readSystemSettingRecord();
		expect(failed.ok).toBe(false);
		expect(failed.setting).toBeNull();
		expect(getSystemSettingsReadFailure()?.message).toContain('SystemSetting.aiProvider');
	});

	it('never swallows the failure silently', async () => {
		prismaMock.systemSetting.findFirst.mockRejectedValue(missingColumnError());

		await readSystemSettingRecord();

		expect(console.error).toHaveBeenCalled();
		expect(String(console.error.mock.calls[0][0])).toContain('system-settings');
	});

	it('clears the recorded failure once the read recovers', async () => {
		prismaMock.systemSetting.findFirst.mockRejectedValue(missingColumnError());
		await readSystemSettingRecord();
		expect(getSystemSettingsReadFailure()).not.toBeNull();

		prismaMock.systemSetting.findFirst.mockResolvedValue(STORED_ROW);
		const recovered = await readSystemSettingRecord();

		expect(recovered.ok).toBe(true);
		expect(recovered.setting).toBe(STORED_ROW);
		expect(getSystemSettingsReadFailure()).toBeNull();
	});

	it('keeps getSystemSettingRecord non-throwing for read-only callers', async () => {
		prismaMock.systemSetting.findFirst.mockRejectedValue(missingColumnError());

		await expect(getSystemSettingRecord()).resolves.toBeNull();
		expect(getSystemSettingsReadFailure()).not.toBeNull();
	});
});

describe('integration settings caching', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		prismaMock.systemSetting.findFirst.mockReset();
		clearSystemSettingsReadFailure();
		clearSystemSettingsCache();
	});

	it('flags a failed read and does NOT cache it, so the next caller retries', async () => {
		prismaMock.systemSetting.findFirst.mockRejectedValue(missingColumnError());

		const first = await getIntegrationSettings();
		const second = await getIntegrationSettings();

		expect(first.settingsReadFailed).toBe(true);
		expect(second.settingsReadFailed).toBe(true);
		// Caching the failure would serve defaults for the whole 30s TTL.
		expect(prismaMock.systemSetting.findFirst).toHaveBeenCalledTimes(2);
	});

	it('caches a successful read as before', async () => {
		prismaMock.systemSetting.findFirst.mockResolvedValue(STORED_ROW);

		const first = await getIntegrationSettings();
		await getIntegrationSettings();

		expect(first.settingsReadFailed).toBe(false);
		expect(prismaMock.systemSetting.findFirst).toHaveBeenCalledTimes(1);
	});
});

describe('branding fallback', () => {
	it('still degrades to defaults, which is why the failure must be reported elsewhere', () => {
		// This is the behaviour that hid the outage: defaults are indistinguishable
		// from a real record except for updatedAt, so /api/health carries the signal.
		const branding = serializeSystemBranding(null);

		expect(branding.careerSiteEnabled).toBe(false);
		expect(branding.updatedAt).toBeNull();
		expect(branding.hasCustomLogo).toBe(false);
	});
});
