import { describe, it, expect } from 'vitest';
import {
	isSelected,
	normalizeSelection,
	pageSelectionState,
	pruneSelection,
	togglePageSelection,
	toggleSelection
} from '../../lib/bulk-selection.js';

describe('bulk-selection helpers', () => {
	it('compares numeric and string ids as the same selection key', () => {
		const selection = normalizeSelection([1, '2']);
		expect(isSelected(selection, '1')).toBe(true);
		expect(isSelected(selection, 2)).toBe(true);
		expect(isSelected(selection, 3)).toBe(false);
	});

	it('toggles a single row without mutating the previous selection', () => {
		const original = new Set(['1']);
		const added = toggleSelection(original, 2);
		expect([...added]).toEqual(['1', '2']);
		expect([...original]).toEqual(['1']);
		expect([...toggleSelection(added, '1')]).toEqual(['2']);
	});

	it('header checkbox selects the whole page, then deselects it when everything is selected', () => {
		const pageIds = [1, 2, 3];
		const selected = togglePageSelection(new Set(['2', '9']), pageIds);
		expect([...selected].sort()).toEqual(['1', '2', '3', '9']);
		expect(pageSelectionState(selected, pageIds)).toEqual({ all: true, some: false, selectedCount: 3 });

		const deselected = togglePageSelection(selected, pageIds);
		expect([...deselected]).toEqual(['9']);
		expect(pageSelectionState(deselected, pageIds)).toEqual({ all: false, some: false, selectedCount: 0 });
	});

	it('reports a partially selected page as indeterminate', () => {
		expect(pageSelectionState(new Set(['1']), [1, 2])).toEqual({ all: false, some: true, selectedCount: 1 });
		expect(pageSelectionState(new Set(['1']), [])).toEqual({ all: false, some: false, selectedCount: 0 });
	});

	it('prunes ids that are no longer listed', () => {
		expect([...pruneSelection(new Set(['1', '2', '3']), [2, 3, 4])].sort()).toEqual(['2', '3']);
	});
});
