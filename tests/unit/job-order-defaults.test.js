import { describe, it, expect } from 'vitest';
import {
	resolveDefaultJobOrderOwnerId,
	resolveJobOrderAssignmentUpdate,
	resolveJobOrderTargetDivisionId
} from '../../lib/job-order-defaults.js';

const admin = { id: 1, role: 'ADMINISTRATOR', divisionId: 4 };
const adminWithoutDivision = { id: 2, role: 'ADMINISTRATOR', divisionId: null };
const recruiter = { id: 3, role: 'RECRUITER', divisionId: 7 };

describe('resolveJobOrderTargetDivisionId', () => {
	it('lets an administrator post a division explicitly', () => {
		expect(resolveJobOrderTargetDivisionId({ actingUser: admin, divisionIdInput: '9' })).toBe(9);
	});

	it('falls back to the administrator\'s own division', () => {
		expect(resolveJobOrderTargetDivisionId({ actingUser: admin, divisionIdInput: '' })).toBe(4);
	});

	it('returns null for an administrator without any division (caller uses the Unassigned division)', () => {
		expect(resolveJobOrderTargetDivisionId({ actingUser: adminWithoutDivision, divisionIdInput: null })).toBeNull();
	});

	it('pins non-administrators to their own division even when another one is posted', () => {
		expect(resolveJobOrderTargetDivisionId({ actingUser: recruiter, divisionIdInput: '9' })).toBe(7);
	});

	it('returns null without an acting user', () => {
		expect(resolveJobOrderTargetDivisionId({ actingUser: null, divisionIdInput: '9' })).toBeNull();
	});
});

describe('resolveDefaultJobOrderOwnerId', () => {
	it('defaults the owner to the creator when they sit in the job\'s division', () => {
		expect(resolveDefaultJobOrderOwnerId({ actingUser: recruiter, divisionId: 7 })).toBe(3);
		expect(resolveDefaultJobOrderOwnerId({ actingUser: recruiter, divisionId: '7' })).toBe(3);
	});

	it('leaves the owner blank when the creator is in another division', () => {
		expect(resolveDefaultJobOrderOwnerId({ actingUser: recruiter, divisionId: 8 })).toBeNull();
	});

	it('leaves the owner blank when the creator has no division or no division is known', () => {
		expect(resolveDefaultJobOrderOwnerId({ actingUser: adminWithoutDivision, divisionId: 4 })).toBeNull();
		expect(resolveDefaultJobOrderOwnerId({ actingUser: admin, divisionId: null })).toBeNull();
		expect(resolveDefaultJobOrderOwnerId({ actingUser: null, divisionId: 4 })).toBeNull();
	});
});

describe('resolveJobOrderAssignmentUpdate', () => {
	const existing = { clientId: 10, contactId: 20, ownerId: 30, divisionId: 40 };

	it('keeps the stored client, contact, owner and division when nothing is posted', () => {
		const result = resolveJobOrderAssignmentUpdate({ clientId: null, contactId: null, ownerId: null }, existing);
		expect(result).toEqual({ clientId: 10, contactId: 20, ownerId: 30, divisionId: 40, changed: false });
	});

	it('treats re-posting the stored ids as unchanged', () => {
		const result = resolveJobOrderAssignmentUpdate({ clientId: '10', contactId: 20, ownerId: '30' }, existing);
		expect(result.changed).toBe(false);
	});

	it('preserves a null stored contact/owner/division instead of inventing values', () => {
		const legacy = { clientId: 10, contactId: null, ownerId: null, divisionId: null };
		const result = resolveJobOrderAssignmentUpdate({}, legacy);
		expect(result).toEqual({ clientId: 10, contactId: null, ownerId: null, divisionId: null, changed: false });
	});

	it('flags a changed assignment so the route re-validates it', () => {
		expect(resolveJobOrderAssignmentUpdate({ clientId: 11 }, existing)).toMatchObject({ clientId: 11, changed: true });
		expect(resolveJobOrderAssignmentUpdate({ contactId: 21 }, existing)).toMatchObject({ contactId: 21, changed: true });
		expect(resolveJobOrderAssignmentUpdate({ ownerId: 31 }, existing)).toMatchObject({ ownerId: 31, changed: true });
	});
});
