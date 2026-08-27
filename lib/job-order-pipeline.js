import { formatPersonName } from '@/lib/person-name';
import { submissionCreatedByLabel, submissionOriginLabel } from '@/lib/submission-origin';
import { getEffectiveSubmissionStatus, isSubmissionPlacementLocked } from '@/lib/submission-status';

// Turns the submissions returned by `GET /api/job-orders/[id]` into the rows the
// job-order pipeline board renders. Pure so the mapping can be unit-tested.
export function toJobOrderPipelineRow(submission, { clientPortalEnabled = true } = {}) {
	const candidate = submission?.candidate || null;
	const clientFeedback =
		clientPortalEnabled && Array.isArray(submission?.clientFeedback) ? submission.clientFeedback : [];
	return {
		id: submission.id,
		candidateId: candidate?.id ?? submission.candidateId ?? null,
		candidateName: formatPersonName(candidate?.firstName, candidate?.lastName, {
			format: 'last-first',
			fallback: 'Candidate unavailable'
		}),
		currentTitle: String(candidate?.currentJobTitle || '').trim(),
		status: getEffectiveSubmissionStatus(submission),
		locked: isSubmissionPlacementLocked(submission),
		submissionPriority: Number(submission.submissionPriority || 0),
		submittedBy: submissionCreatedByLabel(submission),
		originLabel: submissionOriginLabel(submission),
		candidateSource: String(submission.candidateSource || '').trim(),
		latestClientFeedback: clientFeedback[0] || null,
		clientFeedbackCount: clientFeedback.length,
		createdAt: submission.createdAt || null,
		updatedAt: submission.updatedAt || submission.createdAt || null,
		submission
	};
}

export function buildJobOrderPipelineRows(submissions, options = {}) {
	if (!Array.isArray(submissions)) return [];
	return submissions
		.filter((submission) => submission && submission.id != null)
		.map((submission) => toJobOrderPipelineRow(submission, options))
		.sort((a, b) => {
			if (a.submissionPriority !== b.submissionPriority) return a.submissionPriority - b.submissionPriority;
			const aTime = new Date(a.createdAt || 0).getTime();
			const bTime = new Date(b.createdAt || 0).getTime();
			if (aTime !== bTime) return aTime - bTime;
			return Number(a.id) - Number(b.id);
		});
}
