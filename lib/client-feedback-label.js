import { formatSelectValueLabel } from '@/lib/select-value-label';

const CLIENT_FEEDBACK_ACTION_LABELS = Object.freeze({
	comment: 'Feedback',
	request_interview: 'Requested Interview',
	pass: 'Passed',
	need_more_info: 'Needs More Info'
});

export function formatClientFeedbackLabel(actionType, fallback = 'Client Update') {
	const normalized = String(actionType || '').trim().toLowerCase();
	if (!normalized) return fallback;
	return CLIENT_FEEDBACK_ACTION_LABELS[normalized] || formatSelectValueLabel(normalized, fallback);
}
