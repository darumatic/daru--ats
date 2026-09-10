'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LoaderCircle, Sparkles, X } from 'lucide-react';
import LoadingIndicator from '@/app/components/loading-indicator';

// Shows how a match score was arrived at, criterion by criterion.
//
// Unlike the explanation modal this does NOT auto-generate on open: scoring
// with AI costs money, and the user chose on-demand. It opens on the
// deterministic breakdown the list already computed and offers to score.

function scoreLabel(row) {
	if (!row?.assessed || !Number.isFinite(Number(row?.score))) return 'n/a';
	return `${Math.round(Number(row.score))}%`;
}

export default function MatchScoreBreakdownModal({
	open,
	onClose,
	candidateId,
	jobOrderId,
	candidateName,
	jobOrderTitle,
	scorePercent,
	coveragePercent,
	criteriaResults,
	aiAvailable = false,
	onScored
}) {
	const [rows, setRows] = useState(criteriaResults || []);
	const [totals, setTotals] = useState({ scorePercent, coveragePercent });
	const [scoring, setScoring] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');

	useEffect(() => {
		setRows(criteriaResults || []);
		setTotals({ scorePercent, coveragePercent });
		setError('');
		setNotice('');
	}, [criteriaResults, scorePercent, coveragePercent, open]);

	const onScoreWithAi = useCallback(async () => {
		setScoring(true);
		setError('');
		setNotice('');
		try {
			const res = await fetch('/api/match-scores', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ candidateId, jobOrderId })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				setError(data?.error || 'Failed to score this candidate.');
				return;
			}
			setRows(data.criteriaResults || []);
			setTotals({
				scorePercent: data.score?.scorePercent ?? null,
				coveragePercent: data.score?.coveragePercent ?? 0
			});
			// A failed AI call still leaves a deterministic score, so this is a
			// notice rather than an error - but it must be visible, or a broken
			// key looks exactly like a working rules-only score.
			if (data.aiError) setNotice(data.aiError);
			if (typeof onScored === 'function') onScored(data);
		} catch {
			setError('Failed to score this candidate.');
		} finally {
			setScoring(false);
		}
	}, [candidateId, jobOrderId, onScored]);

	if (!open) return null;

	const assessedCount = rows.filter((row) => row?.assessed).length;

	return (
		<div className="confirm-overlay" onClick={onClose}>
			<div
				className="confirm-dialog report-detail-modal match-explanation-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="match-score-modal-title"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="report-detail-modal-head">
					<div>
						<h3 id="match-score-modal-title" className="confirm-title">
							Score Breakdown
						</h3>
						<p className="panel-subtext">
							<Link href={`/candidates/${candidateId}`}>{candidateName || 'Candidate'}</Link> |{' '}
							<Link href={`/job-orders/${jobOrderId}`}>{jobOrderTitle || 'Job Order'}</Link>
						</p>
					</div>
					<div className="match-explanation-toolbar">
						<button
							type="button"
							className="row-action-icon submission-write-up-action"
							onClick={onScoreWithAi}
							disabled={!aiAvailable || scoring}
							title={aiAvailable ? 'Score with AI' : 'Add an AI key in Admin > System Settings to score with AI'}
							aria-label="Score with AI"
						>
							{scoring ? (
								<LoaderCircle aria-hidden="true" className="row-action-icon-spinner" />
							) : (
								<Sparkles aria-hidden="true" />
							)}
						</button>
						<button
							type="button"
							className="btn-secondary btn-link-icon report-detail-modal-close"
							onClick={onClose}
							aria-label="Close score breakdown"
							title="Close"
						>
							<X aria-hidden="true" className="btn-refresh-icon-svg" />
						</button>
					</div>
				</div>

				<div className="report-detail-modal-body">
					<div className="match-score-summary">
						<span className="chip">
							{Number.isFinite(Number(totals.scorePercent))
								? `Score ${Math.round(Number(totals.scorePercent))}%`
								: 'Not scored'}
						</span>
						<span className="match-score-coverage">
							{assessedCount} of {rows.length} criteria assessed ({totals.coveragePercent ?? 0}% of the weighting)
						</span>
					</div>

					{error ? <p className="panel-subtext error">{error}</p> : null}
					{notice ? <p className="panel-subtext error">{notice}</p> : null}
					{scoring ? <LoadingIndicator className="list-loading-indicator" label="Scoring candidate" /> : null}

					<div className="match-score-rows">
						{rows.length === 0 ? <p className="panel-subtext">No criteria are configured.</p> : null}
						{rows.map((row) => (
							<div
								key={row.key}
								className={row.assessed ? 'match-score-row' : 'match-score-row match-score-row-unassessed'}
							>
								<span>
									{row.label || row.key}
									<span className="match-score-coverage"> · weight {row.weight}</span>
									{row.source === 'ai' ? <span className="chip"> AI</span> : null}
								</span>
								<strong>{scoreLabel(row)}</strong>
								<span className="match-score-meter">
									<span
										className="match-score-meter-fill"
										style={{ width: row.assessed ? `${Math.max(0, Math.min(100, Number(row.score) || 0))}%` : '0%' }}
									/>
								</span>
								{row.basis ? <p className="match-score-basis">{row.basis}</p> : null}
							</div>
						))}
					</div>

					<p className="panel-subtext">
						A criterion shown as <strong>n/a</strong> could not be assessed and is excluded from the score
						entirely, rather than counted as zero.
					</p>
				</div>
			</div>
		</div>
	);
}
