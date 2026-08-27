'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowUpRight, BriefcaseBusiness, Lock, RefreshCcw } from 'lucide-react';
import KanbanBoard from '@/app/components/kanban-board';
import LoadingIndicator from '@/app/components/loading-indicator';
import { useToast } from '@/app/components/toast-provider';
import { useConfirmDialog } from '@/app/components/confirm-dialog';
import { toBooleanFlag } from '@/lib/boolean-flag';
import { formatClientFeedbackLabel } from '@/lib/client-feedback-label';
import { formatDateTimeAt } from '@/lib/date-format';
import { displayClientName } from '@/lib/default-client';
import { buildJobOrderPipelineRows } from '@/lib/job-order-pipeline';
import { saveRecordNavigationContext, withRecordNavigationQuery } from '@/lib/record-navigation-context';
import {
	formatSubmissionStatusLabel,
	getSubmissionStatusMoveBlocker,
	SUBMISSION_STATUS_OPTIONS
} from '@/lib/submission-status';

const REJECTED_STATUS = 'rejected';

// Loads the job order (with its submissions) and the client-portal flag that
// decides whether client feedback is shown on cards. Never throws.
async function fetchPipelineBoard(jobOrderId) {
	const result = { jobOrder: null, error: '', clientPortalEnabled: true };
	try {
		const [jobRes, settingsRes] = await Promise.all([
			fetch(`/api/job-orders/${jobOrderId}`, { cache: 'no-store' }),
			fetch('/api/system-settings', { cache: 'no-store' })
		]);
		const settingsData = await settingsRes.json().catch(() => ({}));
		result.clientPortalEnabled = toBooleanFlag(settingsData?.clientPortalEnabled, true);
		if (!jobRes.ok) {
			result.error = 'Job order not found.';
			return result;
		}
		result.jobOrder = await jobRes.json();
	} catch {
		result.error = 'Failed to load the pipeline board.';
	}
	return result;
}

export default function JobOrderPipelinePage() {
	const params = useParams();
	const id = params?.id;
	const toast = useToast();
	const { requestConfirm } = useConfirmDialog();
	const [jobOrder, setJobOrder] = useState(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState('');
	const [clientPortalEnabled, setClientPortalEnabled] = useState(true);
	const [movingRowIds, setMovingRowIds] = useState(new Set());

	const applyBoardResult = useCallback((result) => {
		setClientPortalEnabled(result.clientPortalEnabled);
		setJobOrder(result.jobOrder);
		setError(result.error);
	}, []);

	useEffect(() => {
		if (!id) return undefined;
		let cancelled = false;
		fetchPipelineBoard(id).then((result) => {
			if (cancelled) return;
			applyBoardResult(result);
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [applyBoardResult, id]);

	async function onRefresh() {
		setRefreshing(true);
		try {
			applyBoardResult(await fetchPipelineBoard(id));
		} finally {
			setRefreshing(false);
		}
	}

	const rows = useMemo(
		() => buildJobOrderPipelineRows(jobOrder?.submissions, { clientPortalEnabled }),
		[clientPortalEnabled, jobOrder?.submissions]
	);
	const clientName = jobOrder ? displayClientName(jobOrder.client) : '';
	const boardPath = `/job-orders/${id}/pipeline`;

	function patchSubmission(submissionId, patch) {
		setJobOrder((current) => {
			if (!current || !Array.isArray(current.submissions)) return current;
			return {
				...current,
				submissions: current.submissions.map((submission) =>
					String(submission.id) === String(submissionId) ? { ...submission, ...patch } : submission
				)
			};
		});
	}

	function setRowMoving(rowId, moving) {
		setMovingRowIds((current) => {
			const next = new Set(current);
			if (moving) {
				next.add(String(rowId));
			} else {
				next.delete(String(rowId));
			}
			return next;
		});
	}

	function persistCandidateNavigationContext() {
		saveRecordNavigationContext('candidate', {
			ids: rows.map((row) => row.candidateId).filter(Boolean),
			label: `${jobOrder?.title || 'Job Order'} Pipeline`,
			listPath: boardPath
		});
	}

	function persistSubmissionNavigationContext() {
		saveRecordNavigationContext('submission', {
			ids: rows.map((row) => row.id),
			label: `${jobOrder?.title || 'Job Order'} Pipeline`,
			listPath: boardPath
		});
	}

	async function onMoveSubmission(rowId, nextStatus) {
		const target = rows.find((row) => String(row.id) === String(rowId));
		if (!target) return;
		if (target.status === nextStatus) return;

		const blocker = getSubmissionStatusMoveBlocker(target.submission, nextStatus);
		if (blocker) {
			toast.error(blocker.message);
			return;
		}

		const nextLabel = formatSubmissionStatusLabel(nextStatus);
		if (nextStatus === REJECTED_STATUS) {
			const confirmed = await requestConfirm({
				title: 'Reject Submission',
				message: `Move ${target.candidateName} to ${nextLabel}?`,
				confirmLabel: 'Reject',
				cancelLabel: 'Cancel',
				isDanger: true
			});
			if (!confirmed) return;
		}

		const previous = { status: target.submission.status, updatedAt: target.submission.updatedAt };
		const optimisticTimestamp = new Date().toISOString();
		setRowMoving(rowId, true);
		patchSubmission(rowId, { status: nextStatus, updatedAt: optimisticTimestamp });

		try {
			const res = await fetch(`/api/submissions/${rowId}/status`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: nextStatus })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				patchSubmission(rowId, previous);
				toast.error(data.error || 'Failed to move submission.');
				return;
			}
			patchSubmission(rowId, {
				status: data.status || nextStatus,
				updatedAt: data.updatedAt || optimisticTimestamp
			});
			toast.success(`Moved ${target.candidateName} to ${nextLabel}.`);
		} catch {
			patchSubmission(rowId, previous);
			toast.error('Failed to move submission.');
		} finally {
			setRowMoving(rowId, false);
		}
	}

	if (loading) {
		return (
			<section className="module-page job-order-pipeline-page">
				<LoadingIndicator className="page-loading-indicator" label="Loading pipeline board" />
			</section>
		);
	}

	if (error || !jobOrder) {
		return (
			<section className="module-page job-order-pipeline-page">
				<article className="panel panel-spacious">
					<h2>Pipeline Board</h2>
					<p>{error || 'Pipeline board unavailable.'}</p>
					<div className="form-actions">
						<Link href={`/job-orders/${id}`} className="btn-secondary">
							Back To Job Order
						</Link>
					</div>
				</article>
			</section>
		);
	}

	return (
		<section className="module-page job-order-pipeline-page">
			<header className="module-header">
				<div>
					<Link href={`/job-orders/${id}`} className="module-back-link" aria-label="Back to Job Order">
						&larr; Back
					</Link>
					<h2>Pipeline Board</h2>
					<p>
						{jobOrder.title}
						{clientName ? ` | ${clientName}` : ''} | {rows.length} {rows.length === 1 ? 'submission' : 'submissions'}
					</p>
				</div>
				<div className="module-header-actions">
					<Link
						href={`/job-orders/${id}`}
						className="btn-secondary btn-link-icon"
						title="Open Job Order"
						aria-label="Open Job Order"
					>
						<BriefcaseBusiness aria-hidden="true" className="btn-refresh-icon-svg" />
					</Link>
					<button
						type="button"
						className="btn-secondary btn-link-icon"
						onClick={onRefresh}
						disabled={refreshing}
						aria-label={refreshing ? 'Refreshing pipeline board' : 'Refresh pipeline board'}
						title={refreshing ? 'Refreshing pipeline board' : 'Refresh pipeline board'}
					>
						<RefreshCcw
							aria-hidden="true"
							className={refreshing ? 'btn-refresh-icon-svg row-action-icon-spinner' : 'btn-refresh-icon-svg'}
						/>
					</button>
				</div>
			</header>

			<article className="panel">
				<p className="panel-subtext">
					Drag a card to change its stage. Cards with a placement are locked; use <strong>Convert to Placement</strong>{' '}
					on the submission to reach <strong>Placed</strong>.
				</p>
				<KanbanBoard
					columns={SUBMISSION_STATUS_OPTIONS}
					rows={rows}
					getRowId={(row) => row.id}
					getRowColumn={(row) => row.status}
					isRowDraggable={(row) => !row.locked}
					movingRowIds={movingRowIds}
					emptyLabel="No submissions."
					onMove={onMoveSubmission}
					renderCard={(row) => (
						<div className="kanban-card-body">
							<div className="kanban-card-head">
								{row.candidateId ? (
									<Link
										href={withRecordNavigationQuery(`/candidates/${row.candidateId}`)}
										className="kanban-card-link"
										draggable={false}
										onClick={persistCandidateNavigationContext}
									>
										{row.candidateName}
									</Link>
								) : (
									<span className="kanban-card-link">{row.candidateName}</span>
								)}
								<Link
									href={withRecordNavigationQuery(`/submissions/${row.id}`)}
									className="row-action-icon submission-open-link"
									draggable={false}
									onClick={persistSubmissionNavigationContext}
									title="Open submission detail"
									aria-label={`Open submission detail for ${row.candidateName}`}
								>
									<ArrowUpRight aria-hidden="true" />
								</Link>
							</div>
							{row.currentTitle ? <p className="kanban-card-meta">{row.currentTitle}</p> : null}
							<p className="kanban-card-meta">
								By {row.submittedBy} · {row.originLabel}
							</p>
							{row.candidateSource ? (
								<div className="kanban-card-chips">
									<span className="chip">{row.candidateSource}</span>
								</div>
							) : null}
							{row.latestClientFeedback ? (
								<p className="kanban-card-meta kanban-card-feedback">
									Client: {formatClientFeedbackLabel(row.latestClientFeedback.actionType)}
									{row.latestClientFeedback.clientNameSnapshot
										? ` by ${row.latestClientFeedback.clientNameSnapshot}`
										: ''}
									{row.clientFeedbackCount > 1 ? ` (+${row.clientFeedbackCount - 1} more)` : ''}
								</p>
							) : null}
							{row.locked ? (
								<p className="kanban-card-meta kanban-card-locked">
									<Lock aria-hidden="true" /> Placement created
								</p>
							) : null}
							<p className="kanban-card-time">Updated {formatDateTimeAt(row.updatedAt)}</p>
						</div>
					)}
				/>
			</article>
		</section>
	);
}
