'use client';

import { Plus, Trash2 } from 'lucide-react';
import {
	DEGREE_LEVEL_OPTIONS,
	MATCH_CRITERIA_MAX,
	MATCH_EVALUATOR_OPTIONS,
	criteriaWeightShares
} from '@/lib/match-criteria';

// Controlled editor for a criteria set, shared by the admin template page and
// the per-job-order specialisation so the two cannot drift apart.
//
// Weights are relative: the derived percentage is shown beside each row so
// "Location 20" visibly means "20%", but the editor never forces the total to
// 100. Requiring that would turn adding a criterion into an edit of every other
// row for no gain, since the engine normalises anyway.

function slugify(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 40);
}

function optionsForEvaluator(evaluatorKey) {
	if (evaluatorKey === 'location') return { maxDistanceMiles: 50 };
	if (evaluatorKey === 'big_company') return { referenceValues: [] };
	if (evaluatorKey === 'university') return { referenceValues: [], degreeLevels: [] };
	return {};
}

function parseReferenceList(value) {
	return String(value || '')
		.split(/[\n,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export default function MatchCriteriaEditor({ value, onChange, disabled = false }) {
	const criteria = Array.isArray(value) ? value : [];
	const shares = criteriaWeightShares(criteria);
	const totalWeight = criteria.reduce((sum, criterion) => sum + (Number(criterion?.weight) || 0), 0);

	function update(index, patch) {
		onChange(criteria.map((criterion, i) => (i === index ? { ...criterion, ...patch } : criterion)));
	}

	function updateEvaluator(index, evaluatorKey) {
		// Options belong to an evaluator, so switching evaluator resets them
		// rather than carrying across settings that no longer mean anything.
		update(index, { evaluatorKey, options: optionsForEvaluator(evaluatorKey) });
	}

	return (
		<div className="match-criteria-editor">
			{criteria.length === 0 ? (
				<p className="panel-subtext">No criteria yet. Add one to start scoring candidates.</p>
			) : null}

			{criteria.map((criterion, index) => {
				const evaluator = MATCH_EVALUATOR_OPTIONS.find((option) => option.value === criterion.evaluatorKey);
				const share = shares[index]?.percent ?? 0;
				const needsReferenceList = criterion.evaluatorKey === 'big_company' || criterion.evaluatorKey === 'university';
				const referenceValues = Array.isArray(criterion.options?.referenceValues)
					? criterion.options.referenceValues
					: [];

				return (
					<div className="match-criteria-row" key={criterion.id || criterion.key || index}>
						<div className="match-criteria-row-main">
							<input
								className="match-criteria-label"
								value={criterion.label || ''}
								placeholder="Criterion name"
								disabled={disabled}
								onChange={(event) => {
									const label = event.target.value;
									// The key is the stable identity a stored score refers to, so
									// it only tracks the label until someone has named it.
									const key = criterion.keyLocked ? criterion.key : slugify(label) || criterion.key;
									update(index, { label, key });
								}}
							/>
							<select
								className="match-criteria-evaluator"
								value={criterion.evaluatorKey || ''}
								disabled={disabled}
								onChange={(event) => updateEvaluator(index, event.target.value)}
							>
								{MATCH_EVALUATOR_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
							<div className="match-criteria-weight">
								<input
									type="number"
									min="1"
									max="100"
									value={criterion.weight ?? ''}
									disabled={disabled}
									onChange={(event) => update(index, { weight: Number.parseInt(event.target.value, 10) || 0 })}
								/>
								<span className="match-criteria-share">{share}%</span>
							</div>
							<button
								type="button"
								className="icon-button icon-button-danger"
								title="Remove criterion"
								disabled={disabled}
								onClick={() => onChange(criteria.filter((_unused, i) => i !== index))}
							>
								<Trash2 size={14} />
							</button>
						</div>

						{evaluator ? <p className="panel-subtext match-criteria-hint">{evaluator.hint}</p> : null}

						{needsReferenceList ? (
							<label className="match-criteria-reference">
								<span>
									{criterion.evaluatorKey === 'big_company' ? 'Employers that count' : 'Schools that count'}
								</span>
								<textarea
									rows={2}
									value={referenceValues.join('\n')}
									placeholder="One per line. Leave empty to let AI judge this criterion."
									disabled={disabled}
									onChange={(event) =>
										update(index, {
											options: { ...criterion.options, referenceValues: parseReferenceList(event.target.value) }
										})
									}
								/>
								{referenceValues.length === 0 ? (
									<span className="panel-subtext">
										Empty, so this is reported as not assessed unless you run an AI score.
									</span>
								) : null}
							</label>
						) : null}

						{criterion.evaluatorKey === 'university' ? (
							<div className="match-criteria-degrees">
								{DEGREE_LEVEL_OPTIONS.map((option) => {
									const selected = Array.isArray(criterion.options?.degreeLevels)
										? criterion.options.degreeLevels
										: [];
									return (
										<label key={option.value}>
											<input
												type="checkbox"
												checked={selected.includes(option.value)}
												disabled={disabled}
												onChange={(event) =>
													update(index, {
														options: {
															...criterion.options,
															degreeLevels: event.target.checked
																? [...selected, option.value]
																: selected.filter((entry) => entry !== option.value)
														}
													})
												}
											/>
											{option.label}
										</label>
									);
								})}
							</div>
						) : null}

						{criterion.evaluatorKey === 'location' ? (
							<label className="match-criteria-radius">
								<span>Scored against a radius of</span>
								<input
									type="number"
									min="1"
									value={criterion.options?.maxDistanceMiles ?? 50}
									disabled={disabled}
									onChange={(event) =>
										update(index, {
											options: {
												...criterion.options,
												maxDistanceMiles: Number.parseInt(event.target.value, 10) || 50
											}
										})
									}
								/>
								<span>miles</span>
							</label>
						) : null}
					</div>
				);
			})}

			<div className="match-criteria-footer">
				<button
					type="button"
					className="button button-secondary button-sm"
					disabled={disabled || criteria.length >= MATCH_CRITERIA_MAX}
					onClick={() =>
						onChange([
							...criteria,
							{
								id: crypto.randomUUID(),
								key: `criterion_${criteria.length + 1}`,
								label: '',
								description: '',
								evaluatorKey: 'jd_criteria_match',
								weight: 20,
								aiEnabled: true,
								options: {}
							}
						])
					}
				>
					<Plus size={14} />
					Add Criterion
				</button>
				<span className="panel-subtext">
					Total weight {totalWeight}. Weights are relative, so they do not need to add up to 100.
				</span>
			</div>
		</div>
	);
}
