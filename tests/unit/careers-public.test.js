import { describe, it, expect } from 'vitest';
import { normalizeListJob, normalizeDetailJob, stripHtmlToText, toTeaser } from '../../lib/careers-public.js';

const BASE_JOB = {
	id: 1,
	title: 'Senior Engineer',
	location: 'Sydney NSW',
	city: 'Sydney',
	state: 'NSW',
	zipCode: '2000',
	employmentType: 'Permanent',
	currency: 'AUD',
	salaryMin: 120000,
	salaryMax: 150000,
	publicDescription: '<p>Great role.</p>',
	applicationQuestions: [],
	publishedAt: new Date('2026-01-01T00:00:00Z'),
	openedAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-06-01T00:00:00Z'),
	recordId: 'JOB-XXXXXXXX',
	client: { name: 'Acme Corp', industry: 'Tech', website: 'https://acme.com' },
	contact: { firstName: 'Jane', lastName: 'Smith', title: 'Hiring Manager' },
	_count: { submissions: 42 }
};

describe('normalizeListJob — sensitive field stripping (LOW-1 regression)', () => {
	const result = normalizeListJob(BASE_JOB);

	it('does not expose responseCount', () => {
		expect(result).not.toHaveProperty('responseCount');
	});

	it('does not expose salaryMin', () => {
		expect(result).not.toHaveProperty('salaryMin');
	});

	it('does not expose salaryMax', () => {
		expect(result).not.toHaveProperty('salaryMax');
	});

	it('does not expose recordId', () => {
		expect(result).not.toHaveProperty('recordId');
	});

	it('does not expose updatedAt', () => {
		expect(result).not.toHaveProperty('updatedAt');
	});

	it('does not expose publicDescription (listing only needs teaser)', () => {
		expect(result).not.toHaveProperty('publicDescription');
	});

	it('does not expose applicationQuestions', () => {
		expect(result).not.toHaveProperty('applicationQuestions');
	});

	it('includes safe public fields', () => {
		expect(result.id).toBe(1);
		expect(result.title).toBe('Senior Engineer');
		expect(result.employmentType).toBe('Permanent');
		expect(result.teaser).toBeTruthy();
		expect(result.client.name).toBe('Acme Corp');
	});
});

describe('normalizeDetailJob — sensitive field stripping (LOW-1 regression)', () => {
	const result = normalizeDetailJob(BASE_JOB);

	it('does not expose responseCount', () => {
		expect(result).not.toHaveProperty('responseCount');
	});

	it('does not expose salaryMin', () => {
		expect(result).not.toHaveProperty('salaryMin');
	});

	it('does not expose salaryMax', () => {
		expect(result).not.toHaveProperty('salaryMax');
	});

	it('does not expose recordId', () => {
		expect(result).not.toHaveProperty('recordId');
	});

	it('does not expose contact (hiring manager name)', () => {
		expect(result).not.toHaveProperty('contact');
	});

	it('includes applicationQuestions', () => {
		expect(result).toHaveProperty('applicationQuestions');
		expect(Array.isArray(result.applicationQuestions)).toBe(true);
	});

	it('includes sanitized publicDescription', () => {
		expect(result.publicDescription).toContain('Great role');
	});

	it('sanitizes XSS in publicDescription at render time (HIGH-1 regression)', () => {
		const xssJob = { ...BASE_JOB, publicDescription: '<p>Safe</p><img src=x onerror="evil()">' };
		const xssResult = normalizeDetailJob(xssJob);
		expect(xssResult.publicDescription).not.toContain('onerror');
		expect(xssResult.publicDescription).toContain('Safe');
	});
});

describe('stripHtmlToText', () => {
	it('strips all HTML tags', () => {
		expect(stripHtmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
	});

	it('returns empty string for empty input', () => {
		expect(stripHtmlToText('')).toBe('');
	});

	it('handles null gracefully', () => {
		expect(stripHtmlToText(null)).toBe('');
	});
});

describe('toTeaser', () => {
	it('returns plain text under the max length', () => {
		const result = toTeaser('<p>Short text.</p>');
		expect(result).toBe('Short text.');
	});

	it('truncates long text with ellipsis', () => {
		const long = '<p>' + 'A'.repeat(300) + '</p>';
		const result = toTeaser(long);
		expect(result.length).toBeLessThanOrEqual(220);
		expect(result.endsWith('…')).toBe(true);
	});

	it('returns empty string for empty input', () => {
		expect(toTeaser('')).toBe('');
	});
});

describe('placeholder "Unassigned" client never reaches the public careers site', () => {
	const placeholderJob = { ...BASE_JOB, client: { name: 'Unassigned', industry: null, website: null } };

	it('normalizeListJob reports no client', () => {
		expect(normalizeListJob(placeholderJob).client).toBeNull();
	});

	it('normalizeDetailJob reports no client', () => {
		expect(normalizeDetailJob(placeholderJob).client).toBeNull();
	});

	it('real clients are still exposed with their public fields only', () => {
		expect(normalizeDetailJob(BASE_JOB).client).toEqual({ name: 'Acme Corp', industry: 'Tech', website: 'https://acme.com' });
		expect(normalizeListJob(BASE_JOB).client).toEqual({ name: 'Acme Corp', industry: 'Tech' });
	});
});
