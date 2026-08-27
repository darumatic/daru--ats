import { formatSelectValueLabel } from '@/lib/select-value-label';

// Single source of truth for submission stages, in pipeline order. Forms,
// the job-order pipeline board and reporting all read from this list.
export const SUBMISSION_STATUS_OPTIONS = Object.freeze([
	{ value: 'submitted', label: 'Submitted' },
	{ value: 'under_review', label: 'Under Review' },
	{ value: 'qualified', label: 'Qualified' },
	{ value: 'offered', label: 'Offered' },
	{ value: 'hired', label: 'Hired' },
	{ value: 'placed', label: 'Placed' },
	{ value: 'rejected', label: 'Rejected' }
]);

export const SUBMISSION_STATUS_VALUES = Object.freeze(SUBMISSION_STATUS_OPTIONS.map((option) => option.value));

export const PLACED_SUBMISSION_STATUS = 'placed';

const SUBMISSION_STATUS_LABEL_BY_VALUE = Object.freeze(
	Object.fromEntries(SUBMISSION_STATUS_OPTIONS.map((option) => [option.value, option.label]))
);
const SUBMISSION_STATUS_VALUE_SET = new Set(SUBMISSION_STATUS_VALUES);

function normalizedStatus(value) {
	return String(value || '').trim().toLowerCase();
}

export function getEffectiveSubmissionStatus(submission) {
	if (submission?.offer?.id) return PLACED_SUBMISSION_STATUS;
	return normalizedStatus(submission?.status) || 'submitted';
}

export function isSubmissionPlacementLocked(submission) {
	return Boolean(submission?.offer?.id);
}

export function isSubmissionStatusValue(value) {
	return SUBMISSION_STATUS_VALUE_SET.has(normalizedStatus(value));
}

export function formatSubmissionStatusLabel(value, fallback = '-') {
	const key = normalizedStatus(value);
	if (!key) return fallback;
	return SUBMISSION_STATUS_LABEL_BY_VALUE[key] || formatSelectValueLabel(key, fallback);
}

// Why a submission may not be moved straight to `nextStatus`. Returns null when
// the move is allowed; otherwise `{ reason, message }` so the API route can pick
// the HTTP status and the board can explain the refusal without a request.
//  - `locked`: the submission already has an offer/placement; it is read-only.
//  - `placed-target`: `placed` is only reached through Convert to Placement.
//  - `invalid-status`: not a known stage.
export function getSubmissionStatusMoveBlocker(submission, nextStatus) {
	if (isSubmissionPlacementLocked(submission)) {
		return { reason: 'locked', message: 'Submission is locked after conversion to placement.' };
	}
	const target = normalizedStatus(nextStatus);
	if (!isSubmissionStatusValue(target)) {
		return { reason: 'invalid-status', message: 'Unknown submission status.' };
	}
	if (target === PLACED_SUBMISSION_STATUS) {
		return {
			reason: 'placed-target',
			message: 'Use Convert to Placement on the submission to move it to Placed.'
		};
	}
	return null;
}
