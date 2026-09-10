import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// During the 2026-09-09 outage the storage configuration read as absent rather
// than as unreadable, so every upload silently took the local-disk fallback:
// files never reached the bucket and landed somewhere no backup covers. The
// fallback stays for deployments that genuinely have no object storage, but it
// must refuse to run when the configuration simply could not be read.

const { getIntegrationSettings } = vi.hoisted(() => ({ getIntegrationSettings: vi.fn() }));

vi.mock('@/lib/system-settings', () => ({ getIntegrationSettings }));
vi.mock('@aws-sdk/client-s3', () => ({
	S3Client: class { async send() { return {}; } },
	PutObjectCommand: class {},
	GetObjectCommand: class {},
	DeleteObjectCommand: class {},
	HeadObjectCommand: class {}
}));

const { uploadObjectBuffer } = await import('@/lib/object-storage');

const UNCONFIGURED = {
	settingsReadFailed: false,
	objectStorageProvider: 's3',
	objectStorageRegion: 'us-east-1',
	objectStorageBucket: '',
	objectStorageAccessKeyId: '',
	objectStorageSecretAccessKey: '',
	objectStorageEndpoint: ''
};

// Keep the local-fallback case out of the repo working tree.
const STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ats-storage-'));
const ORIGINAL_ROOT = process.env.LOCAL_STORAGE_ROOT;

describe('uploadObjectBuffer', () => {
	beforeEach(() => {
		getIntegrationSettings.mockReset();
		process.env.LOCAL_STORAGE_ROOT = STORAGE_ROOT;
	});

	afterAll(() => {
		if (ORIGINAL_ROOT === undefined) delete process.env.LOCAL_STORAGE_ROOT;
		else process.env.LOCAL_STORAGE_ROOT = ORIGINAL_ROOT;
		rmSync(STORAGE_ROOT, { recursive: true, force: true });
	});

	it('refuses to write to local disk when the settings could not be read', async () => {
		getIntegrationSettings.mockResolvedValue({ ...UNCONFIGURED, settingsReadFailed: true });

		await expect(
			uploadObjectBuffer({ key: 'candidates/1/resume.pdf', body: Buffer.from('cv'), contentType: 'application/pdf' })
		).rejects.toThrow(/refusing to write to local disk/i);
	});

	it('still falls back to local disk when object storage is genuinely unconfigured', async () => {
		getIntegrationSettings.mockResolvedValue(UNCONFIGURED);

		const result = await uploadObjectBuffer({
			key: 'candidates/1/resume.pdf',
			body: Buffer.from('cv'),
			contentType: 'application/pdf'
		});

		expect(result.storageProvider).toBe('local');
	});
});
