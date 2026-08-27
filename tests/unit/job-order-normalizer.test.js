import { describe, it, expect } from 'vitest';
import { normalizeJobOrderData } from '../../lib/normalizers.js';

// The normalizer used to do `Number(data.contactId)`, which turned a missing
// hiring manager into NaN and made Prisma throw. Assignment ids must be null
// when absent and integers when present.

const BASE = { title: 'Role', zipCode: '2000', status: 'open' };

describe('normalizeJobOrderData — assignment ids', () => {
	it('yields null (never NaN) for omitted client, contact and owner ids', () => {
		const normalized = normalizeJobOrderData(BASE);
		expect(normalized.clientId).toBeNull();
		expect(normalized.contactId).toBeNull();
		expect(normalized.ownerId).toBeNull();
		expect(normalized.divisionId).toBeNull();
	});

	it('yields null for empty-string ids', () => {
		const normalized = normalizeJobOrderData({ ...BASE, clientId: '', contactId: '', ownerId: '' });
		expect(normalized.clientId).toBeNull();
		expect(normalized.contactId).toBeNull();
		expect(normalized.ownerId).toBeNull();
	});

	it('keeps integer ids when they are provided', () => {
		const normalized = normalizeJobOrderData({ ...BASE, clientId: '7', contactId: 8, ownerId: '9' });
		expect(normalized.clientId).toBe(7);
		expect(normalized.contactId).toBe(8);
		expect(normalized.ownerId).toBe(9);
	});
});
