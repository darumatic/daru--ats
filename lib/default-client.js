export const DEFAULT_UNASSIGNED_CLIENT_NAME = 'Unassigned';
const PLACEHOLDER_CLIENT_DESCRIPTION =
	'Placeholder client for job orders created without a client.';

function normalizeName(value) {
	return String(value || '').trim().toLowerCase();
}

export function isPlaceholderClient(client) {
	if (!client || typeof client !== 'object') return false;
	return normalizeName(client.name) === normalizeName(DEFAULT_UNASSIGNED_CLIENT_NAME);
}

export function displayClientName(client) {
	if (!client || isPlaceholderClient(client)) return '';
	return String(client.name || '').trim();
}

function findPlaceholderClient(dbClient, divisionId) {
	return dbClient.client.findFirst({
		where: { name: DEFAULT_UNASSIGNED_CLIENT_NAME, divisionId },
		orderBy: { id: 'asc' }
	});
}

// Job orders require a client, and the job's division is derived from it, so a
// job created without a client is filed under one placeholder client per
// division. Client names are not unique, so this is find-then-create; when two
// requests race, the lower id wins and the loser removes its own duplicate.
export async function ensureDefaultUnassignedClient(dbClient, divisionId) {
	if (!dbClient?.client) {
		throw new Error('Database client is required to ensure default client.');
	}
	const normalizedDivisionId = Number(divisionId);
	if (!Number.isInteger(normalizedDivisionId) || normalizedDivisionId <= 0) {
		throw new Error('A division is required to ensure default client.');
	}

	const existing = await findPlaceholderClient(dbClient, normalizedDivisionId);
	if (existing) return existing;

	const created = await dbClient.client.create({
		data: {
			name: DEFAULT_UNASSIGNED_CLIENT_NAME,
			status: 'Prospect',
			description: PLACEHOLDER_CLIENT_DESCRIPTION,
			divisionId: normalizedDivisionId,
			ownerId: null
		}
	});

	const canonical = await findPlaceholderClient(dbClient, normalizedDivisionId);
	if (canonical && canonical.id !== created.id) {
		await dbClient.client.delete({ where: { id: created.id } }).catch(() => null);
		return canonical;
	}
	return created;
}
