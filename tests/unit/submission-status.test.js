import { describe, it, expect } from 'vitest';
import {
	formatSubmissionStatusLabel,
	getEffectiveSubmissionStatus,
	getSubmissionStatusMoveBlocker,
	isSubmissionStatusValue,
	SUBMISSION_STATUS_OPTIONS,
	SUBMISSION_STATUS_VALUES
} from '@/lib/submission-status';

// The shared submission stage list feeds the submission forms, the job-order
// pipeline board columns and reporting, so its order and labels are contract.

describe('submission status options', () => {
	it('lists the stages in pipeline order with Rejected last', () => {
		expect(SUBMISSION_STATUS_VALUES).toEqual([
			'submitted',
			'under_review',
			'qualified',
			'offered',
			'hired',
			'placed',
			'rejected'
		]);
		expect(SUBMISSION_STATUS_OPTIONS.map((option) => option.label)).toEqual([
			'Submitted',
			'Under Review',
			'Qualified',
			'Offered',
			'Hired',
			'Placed',
			'Rejected'
		]);
	});

	it('labels known stages, title-cases unknown ones and falls back when empty', () => {
		expect(formatSubmissionStatusLabel('under_review')).toBe('Under Review');
		expect(formatSubmissionStatusLabel(' Placed ')).toBe('Placed');
		expect(formatSubmissionStatusLabel('client_interview')).toBe('Client Interview');
		expect(formatSubmissionStatusLabel('')).toBe('-');
		expect(formatSubmissionStatusLabel(null, 'Unknown')).toBe('Unknown');
	});

	it('recognises stage values case-insensitively', () => {
		expect(isSubmissionStatusValue('Qualified')).toBe(true);
		expect(isSubmissionStatusValue('interviewing')).toBe(false);
	});
});

describe('getEffectiveSubmissionStatus', () => {
	it('reports placed whenever an offer exists, regardless of the stored status', () => {
		expect(getEffectiveSubmissionStatus({ status: 'hired', offer: { id: 9 } })).toBe('placed');
		expect(getEffectiveSubmissionStatus({ status: 'Under_Review', offer: null })).toBe('under_review');
		expect(getEffectiveSubmissionStatus({})).toBe('submitted');
	});
});

describe('getSubmissionStatusMoveBlocker', () => {
	it('allows a normal stage move', () => {
		expect(getSubmissionStatusMoveBlocker({ status: 'submitted', offer: null }, 'qualified')).toBeNull();
		expect(getSubmissionStatusMoveBlocker({ status: 'qualified' }, 'rejected')).toBeNull();
	});

	it('locks a submission that already has a placement', () => {
		const blocker = getSubmissionStatusMoveBlocker({ status: 'placed', offer: { id: 3 } }, 'qualified');
		expect(blocker?.reason).toBe('locked');
	});

	it('refuses placed as a target so placements only come from Convert to Placement', () => {
		const blocker = getSubmissionStatusMoveBlocker({ status: 'hired', offer: null }, 'placed');
		expect(blocker?.reason).toBe('placed-target');
		expect(blocker?.message).toMatch(/Convert to Placement/);
	});

	it('refuses unknown stages', () => {
		expect(getSubmissionStatusMoveBlocker({ status: 'submitted' }, 'interviewing')?.reason).toBe('invalid-status');
	});
});
