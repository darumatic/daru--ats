import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Division, Owner, Client and Hiring Manager are intentionally hidden from the
// job-order forms (new roles get server-side defaults). These source-text
// guards stop the fields from creeping back in and keep the routes wired to
// the helpers that provide the defaults.

function read(relativePath) {
	return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const createForm = read('app/job-orders/new/page.js');
const editForm = read('app/job-orders/[id]/page.js');
const listPage = read('app/job-orders/page.js');
const createRoute = read('app/api/job-orders/route.js');
const updateRoute = read('app/api/job-orders/[id]/route.js');

describe('job-order forms no longer render the assignment fields', () => {
	it.each(['Division', 'Owner', 'Client', 'Hiring Manager'])('create form has no "%s" field', (label) => {
		expect(createForm).not.toContain(`label="${label}"`);
	});

	it.each(['Division', 'Owner', 'Client', 'Hiring Manager'])('edit form has no "%s" field', (label) => {
		expect(editForm).not.toContain(`label="${label}"`);
	});

	it('create form still forwards a client/contact prefilled from a client or contact record', () => {
		expect(createForm).toContain("searchParams.get('clientId')");
		expect(createForm).toContain("searchParams.get('contactId')");
	});

	it('edit form no longer posts the assignment ids', () => {
		expect(editForm).not.toMatch(/^\s*(divisionId|ownerId|clientId|contactId):\s*''/m);
	});
});

describe('job-order list hides Client and Owner columns by default', () => {
	it.each(['client', 'owner'])('column "%s" is defaultVisible: false', (key) => {
		const column = listPage.match(new RegExp(`\\{[^{}]*key: '${key}'[^{}]*`, 's'));
		expect(column, `column ${key} exists`).not.toBeNull();
		expect(column[0]).toContain('defaultVisible: false');
	});
});

describe('job-order routes provide the defaults', () => {
	it('create route files jobs under the Unassigned placeholder client and defaults the owner', () => {
		expect(createRoute).toContain('ensureDefaultUnassignedClient(');
		expect(createRoute).toContain('resolveDefaultJobOrderOwnerId(');
		expect(createRoute).toContain('resolveJobOrderTargetDivisionId(');
	});

	it('update route carries stored assignments over and no longer demands a division from administrators', () => {
		expect(updateRoute).toContain('resolveJobOrderAssignmentUpdate(');
		expect(updateRoute).not.toContain('Division is required for administrators.');
	});
});
