import { describe, it, expect } from 'vitest';
import { jobOrderSchema } from '../../lib/validators.js';

// Division, Owner, Client and Hiring Manager are hidden from the job-order
// forms, so the shared create/update schema must accept payloads without them
// (the API fills in defaults) while still rejecting garbage ids.

const MINIMAL_JOB_ORDER = {
	title: 'Backend Engineer',
	zipCode: '2000',
	status: 'open'
};

describe('jobOrderSchema — assignment fields are optional', () => {
	it('accepts a payload with no owner, division, client or contact', () => {
		const result = jobOrderSchema.safeParse(MINIMAL_JOB_ORDER);
		expect(result.success).toBe(true);
		expect(result.data.ownerId).toBeUndefined();
		expect(result.data.clientId).toBeUndefined();
		expect(result.data.contactId).toBeUndefined();
	});

	it.each([['empty strings', ''], ['nulls', null]])('accepts %s for the assignment ids', (_label, value) => {
		const result = jobOrderSchema.safeParse({
			...MINIMAL_JOB_ORDER,
			ownerId: value,
			divisionId: value,
			clientId: value,
			contactId: value
		});
		expect(result.success).toBe(true);
	});

	it('still coerces valid ids when they are posted (prefill from a client/contact record)', () => {
		const result = jobOrderSchema.safeParse({ ...MINIMAL_JOB_ORDER, clientId: '12', contactId: '34', ownerId: 5 });
		expect(result.success).toBe(true);
		expect(result.data.clientId).toBe(12);
		expect(result.data.contactId).toBe(34);
		expect(result.data.ownerId).toBe(5);
	});

	it.each([
		['zero', 0],
		['negative', -3],
		['non-numeric', 'abc'],
		['fractional', 1.5]
	])('still rejects a %s clientId', (_label, value) => {
		expect(jobOrderSchema.safeParse({ ...MINIMAL_JOB_ORDER, clientId: value }).success).toBe(false);
	});

	it('still requires title and zip code', () => {
		expect(jobOrderSchema.safeParse({ ...MINIMAL_JOB_ORDER, title: '' }).success).toBe(false);
		expect(jobOrderSchema.safeParse({ ...MINIMAL_JOB_ORDER, zipCode: '' }).success).toBe(false);
	});
});
