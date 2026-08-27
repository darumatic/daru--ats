import { describe, it, expect, vi } from 'vitest';
import {
	DEFAULT_UNASSIGNED_CLIENT_NAME,
	displayClientName,
	ensureDefaultUnassignedClient,
	isPlaceholderClient
} from '../../lib/default-client.js';

function makeDb({ findFirstResults = [], createResult = null } = {}) {
	const findFirst = vi.fn();
	findFirstResults.forEach((result) => findFirst.mockResolvedValueOnce(result));
	return {
		client: {
			findFirst,
			create: vi.fn().mockResolvedValue(createResult),
			delete: vi.fn().mockResolvedValue(null)
		}
	};
}

describe('isPlaceholderClient / displayClientName', () => {
	it('matches the Unassigned placeholder regardless of case and whitespace', () => {
		expect(isPlaceholderClient({ name: DEFAULT_UNASSIGNED_CLIENT_NAME })).toBe(true);
		expect(isPlaceholderClient({ name: '  unassigned ' })).toBe(true);
	});

	it('is false for real clients and missing values', () => {
		expect(isPlaceholderClient({ name: 'Acme Corp' })).toBe(false);
		expect(isPlaceholderClient(null)).toBe(false);
		expect(isPlaceholderClient(undefined)).toBe(false);
		expect(isPlaceholderClient({})).toBe(false);
	});

	it('displays real client names and hides the placeholder', () => {
		expect(displayClientName({ name: 'Acme Corp' })).toBe('Acme Corp');
		expect(displayClientName({ name: 'Unassigned' })).toBe('');
		expect(displayClientName(null)).toBe('');
	});
});

describe('ensureDefaultUnassignedClient', () => {
	it('reuses the existing placeholder for the division without creating another', async () => {
		const existing = { id: 5, name: DEFAULT_UNASSIGNED_CLIENT_NAME, divisionId: 2 };
		const db = makeDb({ findFirstResults: [existing] });

		await expect(ensureDefaultUnassignedClient(db, 2)).resolves.toBe(existing);
		expect(db.client.findFirst).toHaveBeenCalledWith({
			where: { name: DEFAULT_UNASSIGNED_CLIENT_NAME, divisionId: 2 },
			orderBy: { id: 'asc' }
		});
		expect(db.client.create).not.toHaveBeenCalled();
	});

	it('creates the placeholder in the given division with no owner when missing', async () => {
		const created = { id: 9, name: DEFAULT_UNASSIGNED_CLIENT_NAME, divisionId: 3 };
		const db = makeDb({ findFirstResults: [null, created], createResult: created });

		await expect(ensureDefaultUnassignedClient(db, '3')).resolves.toBe(created);
		expect(db.client.create).toHaveBeenCalledTimes(1);
		expect(db.client.create.mock.calls[0][0].data).toMatchObject({
			name: DEFAULT_UNASSIGNED_CLIENT_NAME,
			divisionId: 3,
			ownerId: null
		});
		expect(db.client.delete).not.toHaveBeenCalled();
	});

	it('converges on the lower id and removes its own duplicate when two requests race', async () => {
		const winner = { id: 7, name: DEFAULT_UNASSIGNED_CLIENT_NAME, divisionId: 3 };
		const loser = { id: 8, name: DEFAULT_UNASSIGNED_CLIENT_NAME, divisionId: 3 };
		const db = makeDb({ findFirstResults: [null, winner], createResult: loser });

		await expect(ensureDefaultUnassignedClient(db, 3)).resolves.toBe(winner);
		expect(db.client.delete).toHaveBeenCalledWith({ where: { id: 8 } });
	});

	it('throws without a database client or a division', async () => {
		await expect(ensureDefaultUnassignedClient(null, 1)).rejects.toThrow('Database client is required');
		await expect(ensureDefaultUnassignedClient(makeDb(), null)).rejects.toThrow('division is required');
		await expect(ensureDefaultUnassignedClient(makeDb(), 0)).rejects.toThrow('division is required');
	});
});
