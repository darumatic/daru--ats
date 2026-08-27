import { describe, it, expect } from 'vitest';
import { buildJobOrderPipelineRows, toJobOrderPipelineRow } from '@/lib/job-order-pipeline';

// Maps the submissions embedded in GET /api/job-orders/[id] into the cards the
// job-order pipeline board renders: effective stage, placement lock, client
// feedback visibility and recruiter priority order.

function submission(overrides = {}) {
	return {
		id: 1,
		status: 'submitted',
		submissionPriority: 1,
		candidateSource: 'LinkedIn',
		notes: null,
		createdAt: '2026-08-01T09:00:00.000Z',
		updatedAt: '2026-08-02T09:00:00.000Z',
		candidate: { id: 70, firstName: 'Ada', lastName: 'Lovelace', currentJobTitle: 'Engineer' },
		createdByUser: { id: 4, firstName: 'Rae', lastName: 'Recruiter' },
		offer: null,
		clientFeedback: [],
		...overrides
	};
}

describe('toJobOrderPipelineRow', () => {
	it('builds a card row with Last, First name, stage, origin and timestamps', () => {
		const input = submission();
		const row = toJobOrderPipelineRow(input);

		expect(row).toMatchObject({
			id: 1,
			candidateId: 70,
			candidateName: 'Lovelace, Ada',
			currentTitle: 'Engineer',
			status: 'submitted',
			locked: false,
			submissionPriority: 1,
			submittedBy: 'Rae Recruiter',
			originLabel: 'Recruiter',
			candidateSource: 'LinkedIn',
			latestClientFeedback: null,
			clientFeedbackCount: 0,
			updatedAt: '2026-08-02T09:00:00.000Z'
		});
		expect(row.submission).toBe(input);
	});

	it('places and locks a submission that has an offer, whatever its stored status', () => {
		const row = toJobOrderPipelineRow(submission({ status: 'hired', offer: { id: 9 } }));
		expect(row.status).toBe('placed');
		expect(row.locked).toBe(true);
	});

	it('labels career-site responses as Web and copes with a missing candidate', () => {
		const row = toJobOrderPipelineRow(
			submission({ createdByUser: null, notes: '[WEB_RESPONSE] Career Site', candidate: null, candidateId: 71 })
		);
		expect(row.candidateName).toBe('Candidate unavailable');
		expect(row.candidateId).toBe(71);
		expect(row.submittedBy).toBe('Web Response');
		expect(row.originLabel).toBe('Web');
	});

	it('surfaces the latest client feedback only while the client portal is enabled', () => {
		const feedback = [
			{ id: 2, actionType: 'pass', clientNameSnapshot: 'Kim', createdAt: '2026-08-03T00:00:00.000Z' },
			{ id: 1, actionType: 'comment', clientNameSnapshot: 'Kim', createdAt: '2026-08-02T00:00:00.000Z' }
		];
		const shown = toJobOrderPipelineRow(submission({ clientFeedback: feedback }));
		expect(shown.latestClientFeedback?.actionType).toBe('pass');
		expect(shown.clientFeedbackCount).toBe(2);

		const hidden = toJobOrderPipelineRow(submission({ clientFeedback: feedback }), { clientPortalEnabled: false });
		expect(hidden.latestClientFeedback).toBeNull();
		expect(hidden.clientFeedbackCount).toBe(0);
	});
});

describe('buildJobOrderPipelineRows', () => {
	it('orders cards by recruiter priority, then submitted date, then id', () => {
		const rows = buildJobOrderPipelineRows([
			submission({ id: 3, submissionPriority: 2, createdAt: '2026-08-01T00:00:00.000Z' }),
			submission({ id: 2, submissionPriority: 0, createdAt: '2026-08-05T00:00:00.000Z' }),
			submission({ id: 1, submissionPriority: 0, createdAt: '2026-08-05T00:00:00.000Z' }),
			submission({ id: 4, submissionPriority: 1, createdAt: '2026-08-09T00:00:00.000Z' })
		]);
		expect(rows.map((row) => row.id)).toEqual([1, 2, 4, 3]);
	});

	it('returns an empty board for missing or malformed input', () => {
		expect(buildJobOrderPipelineRows(undefined)).toEqual([]);
		expect(buildJobOrderPipelineRows([null, {}, submission({ id: 5 })]).map((row) => row.id)).toEqual([5]);
	});
});
