import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { candidateSchema } from '../../lib/validators.js';
import { normalizeCandidateData } from '../../lib/candidate-data.js';

// Division, Owner, Current Job Title and Current Employer are optional on the
// candidate forms: a recruiter capturing a lead often has none of them yet, and
// the API still resolves ownership from the acting user. The columns are
// nullable in Prisma, so a blank must reach the database as NULL.

function read(relativePath) {
	return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function fieldBlocks(source, label) {
	const pattern = new RegExp(`<FormField\\b[^>]*label="${label}"[^>]*>[\\s\\S]*?</FormField>`, 'g');
	return source.match(pattern) || [];
}

const createForm = read('app/candidates/new/page.js');
const editForm = read('app/candidates/[id]/page.js');

const OPTIONAL_LABELS = ['Division', 'Owner', 'Current Job Title', 'Current Employer'];

const MINIMAL_CANDIDATE = {
	firstName: 'Ada',
	lastName: 'Lovelace',
	email: 'ada@example.com',
	mobile: '0400000000',
	status: 'new',
	source: 'referral'
};

describe('candidateSchema — division, owner and current role are optional', () => {
	it('accepts a payload with none of them', () => {
		const result = candidateSchema.safeParse(MINIMAL_CANDIDATE);
		expect(result.success).toBe(true);
		expect(result.data.ownerId).toBeUndefined();
		expect(result.data.divisionId).toBeUndefined();
		expect(result.data.currentJobTitle).toBeUndefined();
		expect(result.data.currentEmployer).toBeUndefined();
	});

	it('accepts empty strings for all four fields, which is what the forms post', () => {
		const result = candidateSchema.safeParse({
			...MINIMAL_CANDIDATE,
			ownerId: '',
			divisionId: '',
			currentJobTitle: '',
			currentEmployer: ''
		});
		expect(result.success).toBe(true);
	});

	it('accepts nulls for the division and owner ids', () => {
		const result = candidateSchema.safeParse({
			...MINIMAL_CANDIDATE,
			ownerId: null,
			divisionId: null
		});
		expect(result.success).toBe(true);
	});

	it('still coerces the values when they are supplied', () => {
		const result = candidateSchema.safeParse({
			...MINIMAL_CANDIDATE,
			ownerId: '7',
			divisionId: '3',
			currentJobTitle: 'Analyst',
			currentEmployer: 'Acme'
		});
		expect(result.success).toBe(true);
		expect(result.data.ownerId).toBe(7);
		expect(result.data.divisionId).toBe(3);
		expect(result.data.currentJobTitle).toBe('Analyst');
		expect(result.data.currentEmployer).toBe('Acme');
	});

	it.each([['zero', 0], ['negative', -4], ['garbage', 'abc']])(
		'still rejects a %s owner id',
		(_label, value) => {
			const result = candidateSchema.safeParse({ ...MINIMAL_CANDIDATE, ownerId: value });
			expect(result.success).toBe(false);
		}
	);

	it.each(['firstName', 'lastName', 'email', 'mobile', 'status', 'source'])(
		'still requires %s',
		(field) => {
			const result = candidateSchema.safeParse({ ...MINIMAL_CANDIDATE, [field]: '' });
			expect(result.success).toBe(false);
		}
	);
});

describe('normalizeCandidateData — blanks reach the database as NULL', () => {
	it('nulls out the four optional fields when they are blank', () => {
		const normalized = normalizeCandidateData({
			...MINIMAL_CANDIDATE,
			ownerId: '',
			divisionId: '',
			currentJobTitle: '',
			currentEmployer: ''
		});
		expect(normalized.ownerId).toBeNull();
		expect(normalized.divisionId).toBeNull();
		expect(normalized.currentJobTitle).toBeNull();
		expect(normalized.currentEmployer).toBeNull();
	});
});

describe('candidate forms do not mark the four fields required', () => {
	it.each(OPTIONAL_LABELS)('create form renders "%s" without a required marker', (label) => {
		const blocks = fieldBlocks(createForm, label);
		expect(blocks.length).toBeGreaterThan(0);
		blocks.forEach((block) => expect(block).not.toMatch(/\brequired\b(?!=)/));
	});

	it.each(OPTIONAL_LABELS)('edit form renders "%s" without a required marker', (label) => {
		const blocks = fieldBlocks(editForm, label);
		expect(blocks.length).toBeGreaterThan(0);
		blocks.forEach((block) => expect(block).not.toMatch(/\brequired\b(?!=)/));
	});

	// Proves the guard above can actually see a marker when one is present.
	it.each([
		['create', createForm],
		['edit', editForm]
	])('%s form still marks First Name required', (_name, source) => {
		const blocks = fieldBlocks(source, 'First Name');
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks[0]).toMatch(/\brequired\b(?!=)/);
	});

	it.each([
		['create', createForm, 'form'],
		['edit', editForm, 'editForm']
	])('%s form save gate ignores the four fields', (_name, source, formVar) => {
		['ownerId', 'divisionId', 'currentJobTitle', 'currentEmployer'].forEach((field) => {
			expect(source).not.toContain(`${formVar}.${field}.trim() &&`);
		});
	});
});
