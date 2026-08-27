'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AddressTypeaheadInput from '@/app/components/address-typeahead-input';
import FormField from '@/app/components/form-field';
import CustomFieldsSection, { areRequiredCustomFieldsComplete } from '@/app/components/custom-fields-section';
import RichTextEditor from '@/app/components/rich-text-editor';
import SaveActionButton from '@/app/components/save-action-button';
import NewRecordGuide from '@/app/components/new-record-guide';
import { useToast } from '@/app/components/toast-provider';
import useUnsavedChangesGuard from '@/app/hooks/use-unsaved-changes-guard';
import { JOB_ORDER_EMPLOYMENT_TYPES } from '@/lib/job-order-options';
import { hasMeaningfulRichTextContent } from '@/lib/rich-text';
import { formatCurrencyInput, parseCurrencyInput } from '@/lib/currency-input';
import { toBooleanFlag } from '@/lib/boolean-flag';

const JOB_ORDER_CURRENCIES = ['USD', 'CAD', 'AUD'];

const initialForm = {
	title: '',
	description: '',
	publicDescription: '',
	location: '',
	locationPlaceId: '',
	locationLatitude: '',
	locationLongitude: '',
	city: '',
	state: '',
	zipCode: '',
	status: 'open',
	employmentType: '',
	openings: '1',
	currency: 'USD',
	salaryMin: '',
	salaryMax: '',
	publishToCareerSite: false,
	clientId: '',
	contactId: '',
	customFields: {}
};

function toSalaryPayloadValue(value) {
	const parsed = parseCurrencyInput(value);
	return parsed == null ? '' : parsed;
}

function normalizeZipValue(value) {
	const rawValue = String(value || '').trim();
	if (!rawValue) return '';
	const match = rawValue.match(/\d{5}/);
	return match ? match[0] : rawValue;
}

function toJobOrderPayload(formValue) {
	const currency = JOB_ORDER_CURRENCIES.includes(formValue.currency) ? formValue.currency : 'USD';
	return {
		...formValue,
		currency,
		salaryMin: toSalaryPayloadValue(formValue.salaryMin),
		salaryMax: toSalaryPayloadValue(formValue.salaryMax)
	};
}

function NewJobOrdersPageContent() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const prefillClientId = searchParams.get('clientId');
	const prefillContactId = searchParams.get('contactId');
	const parsedPrefillClientId = Number(prefillClientId);
	const parsedPrefillContactId = Number(prefillContactId);
	const presetClientId =
		Number.isInteger(parsedPrefillClientId) && parsedPrefillClientId > 0
			? String(parsedPrefillClientId)
			: '';
	const presetContactId =
		Number.isInteger(parsedPrefillContactId) && parsedPrefillContactId > 0
			? String(parsedPrefillContactId)
			: '';
	// Client/contact are no longer form fields; a job started from a client or
	// contact record still carries that relationship in the payload.
	const contactLocked = Boolean(presetClientId && presetContactId);
	const [careerSiteEnabled, setCareerSiteEnabled] = useState(false);
	const [form, setForm] = useState(initialForm);
	const [customFieldDefinitions, setCustomFieldDefinitions] = useState([]);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const toast = useToast();
	const { markAsClean } = useUnsavedChangesGuard(form);

	useEffect(() => {
		let cancelled = false;

		async function loadSystemSettings() {
			const settingsRes = await fetch('/api/system-settings', { cache: 'no-store' });
			const settingsData = await settingsRes.json().catch(() => ({}));
			if (cancelled) return;
			setCareerSiteEnabled(toBooleanFlag(settingsData?.careerSiteEnabled, false));
		}

		loadSystemSettings();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const nextForm = {
			...initialForm,
			clientId: presetClientId,
			contactId: contactLocked ? presetContactId : ''
		};
		setForm((current) => {
			const isSameForm = Object.keys(nextForm).every((key) => current[key] === nextForm[key]);
			if (isSameForm) return current;
			markAsClean(nextForm);
			return nextForm;
		});
		setError('');
	}, [contactLocked, presetClientId, presetContactId, markAsClean]);

	useEffect(() => {
		if (error) {
			toast.error(error);
		}
	}, [error, toast]);

	useEffect(() => {
		if (!careerSiteEnabled && form.publishToCareerSite) {
			setForm((current) => ({ ...current, publishToCareerSite: false }));
			return;
		}
		if (!hasMeaningfulRichTextContent(form.publicDescription) && form.publishToCareerSite) {
			setForm((current) => ({ ...current, publishToCareerSite: false }));
		}
	}, [careerSiteEnabled, form.publicDescription, form.publishToCareerSite]);

	const requiresPublicDescription = careerSiteEnabled && form.publishToCareerSite;
	const hasPublicDescription = hasMeaningfulRichTextContent(form.publicDescription);
	const canPublishToCareerSite = careerSiteEnabled && hasPublicDescription;
	const salaryMinValue = parseCurrencyInput(form.salaryMin);
	const salaryMaxValue = parseCurrencyInput(form.salaryMax);
	const hasSalaryRangeError =
		salaryMinValue != null && salaryMaxValue != null && salaryMinValue > salaryMaxValue;
	const showSalaryRangeStatus = salaryMinValue != null || salaryMaxValue != null;
	const customFieldsComplete = areRequiredCustomFieldsComplete(
		customFieldDefinitions,
		form.customFields
	);
	const canSave =
		form.title.trim().length > 0 &&
		Boolean(form.status) &&
		Boolean(form.zipCode.trim()) &&
		!hasSalaryRangeError &&
		customFieldsComplete &&
		(!requiresPublicDescription || hasPublicDescription) &&
		!saving;

	async function onManualSubmit(e) {
		e.preventDefault();
		setError('');
		if (!form.status) {
			setError('Status is required.');
			return;
		}
		if (!form.zipCode.trim()) {
			setError('Zip code is required.');
			return;
		}
		if (hasSalaryRangeError) {
			setError('Salary Min cannot be greater than Salary Max.');
			return;
		}
		if (requiresPublicDescription && !hasPublicDescription) {
			setError('Public description is required when posting to the career site.');
			return;
		}
		setSaving(true);

		try {
			const payload = toJobOrderPayload({
				...form,
				publishToCareerSite: careerSiteEnabled ? form.publishToCareerSite : false
			});
			const res = await fetch('/api/job-orders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				setError(data.error || 'Failed to save job order.');
				return;
			}

			const jobOrder = await res.json();
			router.push(`/job-orders/${jobOrder.id}`);
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="module-page">
			<header className="module-header">
				<div>
					<Link href="/job-orders" className="module-back-link" aria-label="Back to List">&larr; Back</Link>
					<h2>New Job Order</h2>
					<p>Create job orders manually.</p>
				</div>
			</header>

			<div className="new-record-layout">
			<article className="panel panel-narrow">
				<div className="method-content">
					<h3>Add Job Order</h3>
					<form onSubmit={onManualSubmit}>
						<FormField label="Title" required>
							<input
								placeholder="Job order title"
								value={form.title}
								onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
								required
							/>
						</FormField>
						<FormField label="Internal Description">
							<textarea
								value={form.description}
								onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
							/>
						</FormField>
						<div className="form-grid-2">
							<FormField label="Location">
								<AddressTypeaheadInput
									value={form.location}
									onChange={(nextValue) =>
										setForm((f) => ({
											...f,
											location: nextValue
										}))
									}
									onPlaceDetailsChange={(details) =>
										setForm((f) => ({
											...f,
											locationPlaceId: details?.placeId || '',
											locationLatitude: details?.latitude ?? '',
											locationLongitude: details?.longitude ?? '',
											city: details?.city ?? f.city,
											state: details?.state ?? f.state,
											zipCode: details?.postalCode ? normalizeZipValue(details.postalCode) : f.zipCode
										}))
									}
									placeholder="Search address or enter manually"
									label="Location"
								/>
							</FormField>
							<FormField label="Employment Type">
								<select
									value={form.employmentType}
									onChange={(e) => setForm((f) => ({ ...f, employmentType: e.target.value }))}
								>
									<option value="">Select employment type</option>
									{JOB_ORDER_EMPLOYMENT_TYPES.map((employmentType) => (
										<option key={employmentType} value={employmentType}>
											{employmentType}
										</option>
									))}
								</select>
							</FormField>
						</div>
						<div className="form-grid-3">
							<FormField label="City">
								<input
									value={form.city}
									onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
								/>
							</FormField>
							<FormField label="State">
								<input
									value={form.state}
									onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
								/>
							</FormField>
							<FormField label="Zip Code" required>
								<input
									value={form.zipCode}
									onChange={(e) => setForm((f) => ({ ...f, zipCode: normalizeZipValue(e.target.value) }))}
									required
								/>
							</FormField>
						</div>
							<FormField label="Status" required>
								<select
									value={form.status}
									onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
									required
								>
									<option value="open">Open</option>
									<option value="on_hold">On Hold</option>
								</select>
							</FormField>
						<div className="form-grid-4">
							<FormField label="Openings">
								<input
									type="number"
									min="1"
									value={form.openings}
									onChange={(e) => setForm((f) => ({ ...f, openings: e.target.value }))}
								/>
							</FormField>
							<FormField label="Currency">
								<select
									value={form.currency}
									onChange={(e) => {
										const nextCurrency = JOB_ORDER_CURRENCIES.includes(e.target.value)
											? e.target.value
											: 'USD';
										setForm((current) => ({
											...current,
											currency: nextCurrency,
											salaryMin: formatCurrencyInput(current.salaryMin, nextCurrency),
											salaryMax: formatCurrencyInput(current.salaryMax, nextCurrency)
										}));
									}}
								>
									<option value="USD">USD</option>
									<option value="CAD">CAD</option>
									<option value="AUD">AUD</option>
								</select>
							</FormField>
							<FormField label="Salary Min">
								<input
									type="text"
									inputMode="decimal"
									value={form.salaryMin}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											salaryMin: formatCurrencyInput(e.target.value, f.currency)
										}))
									}
								/>
							</FormField>
							<FormField label="Salary Max">
								<input
									type="text"
									inputMode="decimal"
									value={form.salaryMax}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											salaryMax: formatCurrencyInput(e.target.value, f.currency)
										}))
									}
								/>
							</FormField>
						</div>
						{showSalaryRangeStatus ? (
							<div className="validation-chip-row">
								<span className={`chip ${hasSalaryRangeError ? 'validation-chip-invalid' : 'validation-chip-valid'}`}>
									{hasSalaryRangeError ? 'Salary Range Invalid' : 'Salary Range OK'}
								</span>
							</div>
						) : null}
							{careerSiteEnabled ? (
								<>
									<div className="checkbox-grid">
										<label className="switch-field">
											<input
												type="checkbox"
												className="switch-input"
												checked={form.publishToCareerSite}
												disabled={!form.publishToCareerSite && !canPublishToCareerSite}
												onChange={(e) => {
													const checked = e.target.checked;
													setForm((f) => ({ ...f, publishToCareerSite: checked }));
													setError('');
												}}
											/>
											<span className="switch-track" aria-hidden="true">
												<span className="switch-thumb" />
											</span>
											<span className="switch-copy">
												<span className="switch-label">Publish to Career Site</span>
												<span className="switch-hint">
													{canPublishToCareerSite
														? 'Publish the public description to your careers page.'
														: 'Add a public description before enabling career-site publishing.'}
												</span>
											</span>
										</label>
									</div>
									<FormField label="Public Description" required={form.publishToCareerSite}>
										<RichTextEditor
											value={form.publicDescription}
											onChange={(nextValue) => setForm((f) => ({ ...f, publicDescription: nextValue }))}
											ariaLabel="Public Description"
										/>
									</FormField>
								</>
							) : null}
						<CustomFieldsSection
							moduleKey="jobOrders"
							values={form.customFields}
							onChange={(nextCustomFields) =>
								setForm((f) => ({
									...f,
									customFields: nextCustomFields
								}))
							}
							onDefinitionsChange={setCustomFieldDefinitions}
						/>
						<SaveActionButton
							saving={saving}
							disabled={saving || !canSave}
							label="Save Job Order"
							savingLabel="Saving Job Order..."
						/>
					</form>
				</div>
			</article>
			<NewRecordGuide
				title="Job Order Setup"
				intro="This record drives matching, submissions, interviews, the client portal, and public job publishing when enabled."
				checklist={[
					'Set the status and employment type before saving.',
					'Use a real ZIP code and location so search and matching stay credible.',
					'If you plan to publish publicly, finish the public description before turning that on.'
				]}
				outcomes={[
					'The job opens directly into matching, submissions, and client portal workflows.',
					'Open job orders can be matched against candidates immediately after save.',
					'A job started from a client contact can later receive a persistent client review portal link.'
				]}
				tips={[
					'Keep internal description for recruiter context and public description for candidate-facing copy.'
				]}
			/>
			</div>

		</section>
	);
}

export default function NewJobOrdersPage() {
	return (
		<Suspense
			fallback={
				<section className="module-page">
					<p>Loading job order setup...</p>
				</section>
			}
		>
			<NewJobOrdersPageContent />
		</Suspense>
	);
}
