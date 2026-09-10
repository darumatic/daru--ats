import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two guards that would have contained the 2026-09-09 outage:
//   1. /api/health must report unhealthy when the settings row cannot be read,
//      because the production autodeploy gates its rollback on that endpoint.
//   2. PATCH /api/system-settings must refuse to write when the read failed -
//      the admin form posts every field, so saving against a failed read would
//      put blanks over real credentials and branding, permanently.

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getIntegrationSettings: vi.fn(),
		getSystemSettingsReadFailure: vi.fn(),
		readSystemSettingRecord: vi.fn(),
		getOnboardingState: vi.fn(),
		getObjectStorageConfig: vi.fn(),
		queryRaw: vi.fn(),
		getActingUser: vi.fn(),
		enforceMutationThrottle: vi.fn(),
		settingCreate: vi.fn(),
		settingUpdate: vi.fn()
	}
}));

vi.mock('@/lib/prisma', () => ({
	prisma: {
		$queryRaw: mocks.queryRaw,
		systemSetting: { create: mocks.settingCreate, update: mocks.settingUpdate }
	}
}));
vi.mock('@/lib/audit-log', () => ({ logCreate: vi.fn(), logUpdate: vi.fn() }));
vi.mock('@/lib/onboarding', () => ({ getOnboardingState: mocks.getOnboardingState }));
vi.mock('@/lib/object-storage', () => ({
	getObjectStorageConfig: mocks.getObjectStorageConfig,
	uploadObjectBuffer: vi.fn(),
	deleteObject: vi.fn(),
	buildSystemLogoStorageKey: vi.fn()
}));
vi.mock('@/lib/system-settings', () => ({
	getIntegrationSettings: mocks.getIntegrationSettings,
	getSystemSettingsReadFailure: mocks.getSystemSettingsReadFailure,
	readSystemSettingRecord: mocks.readSystemSettingRecord,
	getSystemSettingRecord: vi.fn(),
	clearSystemSettingsCache: vi.fn(),
	serializeAdminSystemSettings: vi.fn(() => ({})),
	serializeSystemBranding: vi.fn(() => ({})),
	DEFAULT_SITE_NAME: 'Darumatic ATS',
	DEFAULT_API_ERROR_LOG_RETENTION_DAYS: 90
}));
vi.mock('@/lib/access-control', async (importOriginal) => ({
	...(await importOriginal()),
	getActingUser: mocks.getActingUser
}));
vi.mock('@/lib/mutation-throttle', () => ({ enforceMutationThrottle: mocks.enforceMutationThrottle }));
vi.mock('@/lib/api-logging', () => ({ withApiLogging: (_route, handler) => handler }));

const { GET } = await import('@/app/api/health/route');
const { PATCH } = await import('@/app/api/system-settings/route');

const READ_FAILURE = {
	at: '2026-09-09T10:15:00.000Z',
	message: 'The column `SystemSetting.aiProvider` does not exist in the current database.'
};

describe('GET /api/health', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.queryRaw.mockResolvedValue([{ 1: 1 }]);
		mocks.getOnboardingState.mockResolvedValue({ needsOnboarding: false, hasUsers: true, hasSystemSetting: true });
		mocks.getObjectStorageConfig.mockResolvedValue({ mode: 'local', bucket: '' });
		mocks.getIntegrationSettings.mockResolvedValue({});
	});

	it('returns 503 when the settings row cannot be read, even though the database answers', async () => {
		mocks.readSystemSettingRecord.mockResolvedValue({
			ok: false,
			setting: null,
			error: new Error(READ_FAILURE.message)
		});

		const response = await GET();
		const body = await response.json();

		// This is the exact state that shipped: DB up, settings unreadable.
		expect(body.database.ok).toBe(true);
		expect(response.status).toBe(503);
		expect(body.ok).toBe(false);
		expect(body.systemSettings.ok).toBe(false);
		expect(body.systemSettings.error).toContain('SystemSetting.aiProvider');
	});

	it('returns 200 when the settings row reads cleanly', async () => {
		mocks.readSystemSettingRecord.mockResolvedValue({ ok: true, setting: {}, error: null });

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.systemSettings).toEqual({ ok: true });
	});

	it('recovers immediately after a transient failure instead of latching at 503', async () => {
		// The recorded failure state is process-global and sticky, so health must
		// probe live - otherwise one transient error would hold the endpoint at 503
		// and roll back a perfectly good deploy.
		mocks.readSystemSettingRecord.mockResolvedValueOnce({
			ok: false,
			setting: null,
			error: new Error('read timeout')
		});
		expect((await GET()).status).toBe(503);

		mocks.readSystemSettingRecord.mockResolvedValue({ ok: true, setting: {}, error: null });
		expect((await GET()).status).toBe(200);
	});
});

describe('PATCH /api/system-settings', () => {
	function patchRequest() {
		return new Request('http://localhost/api/system-settings', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ siteName: 'Darumatic ATS', smtpHost: '', aiApiKey: '' })
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.enforceMutationThrottle.mockResolvedValue(null);
		mocks.getActingUser.mockResolvedValue({ id: 1, role: 'ADMINISTRATOR' });
		mocks.settingCreate.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
		mocks.settingUpdate.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
	});

	it('refuses to save when the settings read failed, rather than writing blanks over stored values', async () => {
		mocks.readSystemSettingRecord.mockResolvedValue({ ok: false, setting: null, error: new Error('boom') });

		const response = await PATCH(patchRequest());
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body.error).toMatch(/could not be read/i);
	});

	it('does not block a save when there is genuinely no settings row yet', async () => {
		mocks.readSystemSettingRecord.mockResolvedValue({ ok: true, setting: null, error: null });

		const response = await PATCH(patchRequest());

		// Onboarding must still be able to create the first row.
		expect(response.status).not.toBe(503);
		expect(mocks.settingCreate).toHaveBeenCalled();
	});
});
