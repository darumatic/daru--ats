import { describe, it, expect } from 'vitest';
import {
	countJobOrderQuickFilterMatches,
	DEFAULT_JOB_ORDER_QUICK_FILTER,
	formatJobOrderQuickFilterLabel,
	JOB_ORDER_QUICK_FILTER_VALUES,
	matchesJobOrderQuickFilter,
	normalizeJobOrderQuickFilter,
	resolveJobOrderQuickFilterFromViewState
} from '@/lib/job-order-quick-filters';

// The job-order list's quick-filter chips: Published (live on the careers
// site), one chip per status, and All. Published is the default; the last
// choice is remembered and saved views may carry their own.

const rows = [
	{ id: 1, status: 'open', publishToCareerSite: true },
	{ id: 2, status: 'open', publishToCareerSite: false },
	{ id: 3, status: 'on_hold', publishToCareerSite: true },
	{ id: 4, status: 'closed', publishToCareerSite: true },
	{ id: 5, status: 'Closed', publishToCareerSite: false }
];

describe('job-order quick filters', () => {
	it('offers Published, the three statuses and All, defaulting to Published', () => {
		expect(JOB_ORDER_QUICK_FILTER_VALUES).toEqual(['published', 'open', 'on_hold', 'closed', 'all']);
		expect(DEFAULT_JOB_ORDER_QUICK_FILTER).toBe('published');
		expect(normalizeJobOrderQuickFilter(undefined)).toBe('published');
		expect(normalizeJobOrderQuickFilter(' ON_HOLD ')).toBe('on_hold');
		expect(normalizeJobOrderQuickFilter('bogus', 'all')).toBe('all');
		expect(formatJobOrderQuickFilterLabel('on_hold')).toBe('On Hold');
	});

	it('treats Published as career-site flag on AND status open', () => {
		expect(rows.filter((row) => matchesJobOrderQuickFilter(row, 'published')).map((row) => row.id)).toEqual([1]);
	});

	it('matches status chips case-insensitively and lets All through', () => {
		expect(rows.filter((row) => matchesJobOrderQuickFilter(row, 'open')).map((row) => row.id)).toEqual([1, 2]);
		expect(rows.filter((row) => matchesJobOrderQuickFilter(row, 'closed')).map((row) => row.id)).toEqual([4, 5]);
		expect(rows.filter((row) => matchesJobOrderQuickFilter(row, 'all')).length).toBe(rows.length);
	});

	it('counts matches per chip for the badge', () => {
		expect(countJobOrderQuickFilterMatches(rows)).toEqual({ published: 1, open: 2, on_hold: 1, closed: 2, all: 5 });
		expect(countJobOrderQuickFilterMatches(null).all).toBe(0);
	});

	it('keeps the current filter when a legacy saved view has none, otherwise uses the view', () => {
		expect(resolveJobOrderQuickFilterFromViewState({ query: 'x' }, 'closed')).toBe('closed');
		expect(resolveJobOrderQuickFilterFromViewState({ quickFilter: '' }, 'closed')).toBe('closed');
		expect(resolveJobOrderQuickFilterFromViewState({ quickFilter: 'all' }, 'closed')).toBe('all');
		expect(resolveJobOrderQuickFilterFromViewState({ quickFilter: 'nope' }, 'closed')).toBe('published');
		expect(resolveJobOrderQuickFilterFromViewState(null, undefined)).toBe('published');
	});
});
