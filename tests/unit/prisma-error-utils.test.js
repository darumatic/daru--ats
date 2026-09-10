import { describe, it, expect } from 'vitest';
import { isMissingTableError } from '../../scripts/prisma-error-utils.cjs';

// demo-reset takes its settings snapshot immediately before
// `prisma migrate reset --force`. Treating a non-fatal-looking error as "no
// table yet" therefore returns an empty snapshot and destroys the real settings.
// The predicate used to match ANY message containing "SystemSetting", which
// includes Prisma's missing-COLUMN error during schema drift.
describe('isMissingTableError', () => {
	it('accepts only a genuinely missing table', () => {
		expect(isMissingTableError({ code: 'P2021', message: 'The table does not exist' })).toBe(true);
	});

	it('rejects a missing-column error, which must abort the reset instead', () => {
		const drift = {
			code: 'P2022',
			message: 'The column `SystemSetting.aiProvider` does not exist in the current database.'
		};
		expect(isMissingTableError(drift)).toBe(false);
	});

	it('rejects connection errors and null', () => {
		expect(isMissingTableError({ code: 'P1001', message: "Can't reach database server" })).toBe(false);
		expect(isMissingTableError(null)).toBe(false);
		expect(isMissingTableError(undefined)).toBe(false);
	});
});
