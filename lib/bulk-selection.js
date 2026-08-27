// Pure helpers for multi-row selection in list views. Ids are compared as
// strings so numeric database ids and string DOM values never disagree.

export function toSelectionId(value) {
	return String(value);
}

export function normalizeSelection(selection) {
	if (selection instanceof Set) return new Set([...selection].map(toSelectionId));
	if (Array.isArray(selection)) return new Set(selection.map(toSelectionId));
	return new Set();
}

export function isSelected(selection, id) {
	return normalizeSelection(selection).has(toSelectionId(id));
}

export function toggleSelection(selection, id) {
	const next = normalizeSelection(selection);
	const key = toSelectionId(id);
	if (next.has(key)) {
		next.delete(key);
	} else {
		next.add(key);
	}
	return next;
}

// Selects every id in `ids` unless they are all already selected, in which
// case they are all deselected (header-checkbox semantics for one page).
export function togglePageSelection(selection, ids) {
	const next = normalizeSelection(selection);
	const keys = ids.map(toSelectionId);
	const allSelected = keys.length > 0 && keys.every((key) => next.has(key));
	keys.forEach((key) => (allSelected ? next.delete(key) : next.add(key)));
	return next;
}

export function pageSelectionState(selection, ids) {
	const current = normalizeSelection(selection);
	const keys = ids.map(toSelectionId);
	const selectedCount = keys.filter((key) => current.has(key)).length;
	return {
		all: keys.length > 0 && selectedCount === keys.length,
		some: selectedCount > 0 && selectedCount < keys.length,
		selectedCount
	};
}

export function pruneSelection(selection, validIds) {
	const valid = new Set(validIds.map(toSelectionId));
	return new Set([...normalizeSelection(selection)].filter((key) => valid.has(key)));
}
