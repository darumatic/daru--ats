import { toNullableInt } from '@/lib/value-utils';

// Division a new job order is filed under when the form no longer asks for one:
// administrators may still post a division (API callers), otherwise they fall
// back to their own division; everyone else is pinned to their own division.
export function resolveJobOrderTargetDivisionId({ actingUser, divisionIdInput }) {
	const ownDivisionId = toNullableInt(actingUser?.divisionId);
	if (actingUser?.role === 'ADMINISTRATOR') {
		return toNullableInt(divisionIdInput) ?? ownDivisionId;
	}
	return ownDivisionId;
}

// A new job order is owned by whoever creates it, but only when that user sits
// in the job's division — access control rejects owners from other divisions.
export function resolveDefaultJobOrderOwnerId({ actingUser, divisionId }) {
	const targetDivisionId = toNullableInt(divisionId);
	const ownDivisionId = toNullableInt(actingUser?.divisionId);
	if (!actingUser?.id || !targetDivisionId || ownDivisionId !== targetDivisionId) {
		return null;
	}
	return actingUser.id;
}

// On update, client/contact/owner are optional in the payload. Missing values
// keep what is stored, and an unchanged assignment set is reported as
// `changed: false` so callers can skip re-validating legacy rows.
export function resolveJobOrderAssignmentUpdate(normalized, existing) {
	const clientId = toNullableInt(normalized?.clientId) ?? toNullableInt(existing?.clientId);
	const contactId = toNullableInt(normalized?.contactId) ?? toNullableInt(existing?.contactId);
	const ownerId = toNullableInt(normalized?.ownerId) ?? toNullableInt(existing?.ownerId);
	const changed =
		clientId !== toNullableInt(existing?.clientId) ||
		contactId !== toNullableInt(existing?.contactId) ||
		ownerId !== toNullableInt(existing?.ownerId);

	return {
		clientId,
		contactId,
		ownerId,
		divisionId: toNullableInt(existing?.divisionId),
		changed
	};
}
