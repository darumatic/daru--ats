'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import AdminGate from '@/app/components/admin-gate';
import MatchCriteriaEditor from '@/app/components/match-criteria-editor';
import SaveActionButton from '@/app/components/save-action-button';
import { useToast } from '@/app/components/toast-provider';

// The template is small and edited as a whole, so this is one page with one
// save rather than the row-per-page shape the custom-fields admin uses. The
// per-row API is still what it writes through: the save diffs the edited set
// against what was loaded and issues the creates, updates and removals.

function sameCriterion(a, b) {
	return (
		a.key === b.key &&
		a.label === b.label &&
		(a.description || '') === (b.description || '') &&
		a.evaluatorKey === b.evaluatorKey &&
		Number(a.weight) === Number(b.weight) &&
		a.aiEnabled === b.aiEnabled &&
		JSON.stringify(a.options || {}) === JSON.stringify(b.options || {})
	);
}

export default function MatchCriteriaAdminPage() {
	const toast = useToast();
	const [loaded, setLoaded] = useState([]);
	const [criteria, setCriteria] = useState([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');

	async function load() {
		setLoading(true);
		setError('');
		try {
			const res = await fetch('/api/admin/match-criteria', { cache: 'no-store' });
			const data = await res.json().catch(() => []);
			if (!res.ok) {
				setError(data?.error || 'Failed to load match criteria.');
				return;
			}
			// keyLocked marks a criterion that already exists: its key is the
			// identity stored scores refer to, so renaming the label must not
			// silently repoint it at a different criterion.
			const rows = (Array.isArray(data) ? data : []).map((row) => ({ ...row, keyLocked: true }));
			setLoaded(rows);
			setCriteria(rows);
		} catch {
			setError('Failed to load match criteria.');
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		load();
	}, []);

	async function onSave() {
		setSaving(true);
		setError('');
		try {
			const removed = loaded.filter((row) => !criteria.some((edited) => edited.id === row.id));
			const added = criteria.filter((row) => !row.id);
			const changed = criteria.filter((row) => {
				if (!row.id) return false;
				const original = loaded.find((entry) => entry.id === row.id);
				return original && !sameCriterion(original, row);
			});

			const requests = [
				...removed.map((row) => fetch(`/api/admin/match-criteria/${row.id}`, { method: 'DELETE' })),
				...changed.map((row) =>
					fetch(`/api/admin/match-criteria/${row.id}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							key: row.key,
							label: row.label,
							description: row.description || '',
							evaluatorKey: row.evaluatorKey,
							weight: row.weight,
							aiEnabled: row.aiEnabled,
							options: row.options
						})
					})
				),
				...added.map((row) =>
					fetch('/api/admin/match-criteria', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							key: row.key,
							label: row.label,
							description: row.description || '',
							evaluatorKey: row.evaluatorKey,
							weight: row.weight,
							aiEnabled: row.aiEnabled,
							options: row.options
						})
					})
				)
			];

			const responses = await Promise.all(requests);
			const failed = responses.filter((res) => !res.ok);
			if (failed.length > 0) {
				const detail = await failed[0].json().catch(() => ({}));
				setError(detail?.error || 'Some criteria could not be saved. Nothing else was rolled back.');
				toast.error('Some criteria could not be saved.');
			} else {
				toast.success('Match criteria saved.');
			}
			await load();
		} finally {
			setSaving(false);
		}
	}

	const dirty = JSON.stringify(criteria) !== JSON.stringify(loaded);

	return (
		<AdminGate>
			<div className="module-page">
				<header className="module-header">
					<div>
						<h2>Match Criteria</h2>
						<p className="panel-subtext">
							The weighted criteria every candidate match is scored against. Job orders inherit this set
							unless they have specialised their own.
						</p>
					</div>
					<Link className="button button-secondary" href="/admin">
						Back to Admin
					</Link>
				</header>

				<article className="panel panel-spacious">
					{error ? <p className="form-error">{error}</p> : null}
					{loading ? (
						<p className="panel-subtext">Loading criteria…</p>
					) : (
						<>
							<p className="panel-subtext">
								A criterion whose evaluator cannot judge a candidate is reported as <strong>not assessed</strong>{' '}
								and left out of the weighted average rather than scored zero, so every match also reports how
								much of the template it covered. <em>Big Company</em> and <em>University</em> need a reference
								list before they can be scored without AI.
							</p>
							<MatchCriteriaEditor value={criteria} onChange={setCriteria} disabled={saving} />
							<div className="form-actions">
								<SaveActionButton
									type="button"
									label="Save Criteria"
									onClick={onSave}
									disabled={!dirty || saving}
									saving={saving}
								/>
								{dirty ? <span className="panel-subtext">Unsaved changes</span> : null}
							</div>
						</>
					)}
				</article>
			</div>
		</AdminGate>
	);
}
