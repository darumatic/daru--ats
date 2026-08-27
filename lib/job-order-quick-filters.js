import { JOB_ORDER_STATUS_OPTIONS } from '@/lib/job-order-options';

// Quick-filter chips on the job-order list. `published` means what candidates
// can see right now (career-site flag on AND status open), the status chips
// match the stored status, `all` clears the filter. The last choice is
// remembered per browser; a saved view stores its own.
export const JOB_ORDER_QUICK_FILTER_STORAGE_KEY = 'job-orders-list-quick-filter';
export const DEFAULT_JOB_ORDER_QUICK_FILTER = 'published';
export const ALL_JOB_ORDER_QUICK_FILTER = 'all';

export const JOB_ORDER_QUICK_FILTER_OPTIONS = Object.freeze([
	{ value: 'published', label: 'Published', description: 'Open and published on the careers site' },
	...JOB_ORDER_STATUS_OPTIONS.map((option) => ({
		value: option.value,
		label: option.label,
		description: `Status is ${option.label}`
	})),
	{ value: ALL_JOB_ORDER_QUICK_FILTER, label: 'All', description: 'Every job order' }
]);

export const JOB_ORDER_QUICK_FILTER_VALUES = Object.freeze(
	JOB_ORDER_QUICK_FILTER_OPTIONS.map((option) => option.value)
);

const QUICK_FILTER_VALUE_SET = new Set(JOB_ORDER_QUICK_FILTER_VALUES);
const QUICK_FILTER_LABEL_BY_VALUE = new Map(
	JOB_ORDER_QUICK_FILTER_OPTIONS.map((option) => [option.value, option.label])
);

function cleanValue(value) {
	return String(value ?? '').trim().toLowerCase();
}

export function isJobOrderQuickFilterValue(value) {
	return QUICK_FILTER_VALUE_SET.has(cleanValue(value));
}

export function normalizeJobOrderQuickFilter(value, fallback = DEFAULT_JOB_ORDER_QUICK_FILTER) {
	const key = cleanValue(value);
	return QUICK_FILTER_VALUE_SET.has(key) ? key : fallback;
}

export function formatJobOrderQuickFilterLabel(value) {
	return QUICK_FILTER_LABEL_BY_VALUE.get(normalizeJobOrderQuickFilter(value)) || 'All';
}

export function matchesJobOrderQuickFilter(row, filter) {
	const key = normalizeJobOrderQuickFilter(filter);
	if (key === ALL_JOB_ORDER_QUICK_FILTER) return true;
	const status = cleanValue(row?.status);
	if (key === 'published') return Boolean(row?.publishToCareerSite) && status === 'open';
	return status === key;
}

export function countJobOrderQuickFilterMatches(rows) {
	const counts = Object.fromEntries(JOB_ORDER_QUICK_FILTER_VALUES.map((value) => [value, 0]));
	for (const row of Array.isArray(rows) ? rows : []) {
		for (const value of JOB_ORDER_QUICK_FILTER_VALUES) {
			if (matchesJobOrderQuickFilter(row, value)) counts[value] += 1;
		}
	}
	return counts;
}

// Saved views written before quick filters existed carry no `quickFilter`;
// applying one must not clobber the filter the user is currently on. Views
// that do carry the key (including the system default) win.
export function resolveJobOrderQuickFilterFromViewState(viewState, currentFilter) {
	const stored = viewState && typeof viewState === 'object' ? viewState.quickFilter : undefined;
	if (stored == null || String(stored).trim() === '') {
		return normalizeJobOrderQuickFilter(currentFilter);
	}
	return normalizeJobOrderQuickFilter(stored);
}
