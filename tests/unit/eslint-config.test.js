import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

// eslint-config-next registers the react-hooks plugin only on
// **/*.{js,jsx,mjs,ts,tsx,mts,cts} — note cts but not cjs. A rules object that
// names a react-hooks rule without carrying that same `files` glob makes ESLint
// hard-error ("could not find plugin react-hooks") on every .cjs script, which
// took out `eslint .` entirely while the CI target (`eslint app lib`) kept
// passing and hid it.

// Loading eslint-config-next's plugin graph costs a few seconds, so share one
// instance and give these room past vitest's 5s default.
const eslint = new ESLint();
const TIMEOUT_MS = 30000;

describe('eslint flat config', () => {
	it('lints a .cjs script instead of failing to resolve the react-hooks plugin', async () => {
		const results = await eslint.lintFiles(['scripts/preflight.cjs']);
		expect(results).toHaveLength(1);
		expect(results[0].fatalErrorCount).toBe(0);
		expect(results[0].errorCount).toBe(0);
	}, TIMEOUT_MS);

	it('scopes the react-hooks rules to the files where the plugin is registered', async () => {
		const config = await eslint.calculateConfigForFile('scripts/preflight.cjs');
		expect(Object.keys(config.plugins)).not.toContain('react-hooks');
		expect(Object.keys(config.rules).filter((rule) => rule.startsWith('react-hooks/'))).toEqual([]);
	}, TIMEOUT_MS);

	it('still downgrades the react-hooks rules to warnings on app source', async () => {
		const config = await eslint.calculateConfigForFile('app/candidates/new/page.js');
		expect(Object.keys(config.plugins)).toContain('react-hooks');
		// severity 1 === warn, so CI reports these without failing the build
		expect(config.rules['react-hooks/exhaustive-deps'][0]).toBe(1);
		expect(config.rules['react-hooks/preserve-manual-memoization'][0]).toBe(1);
		expect(config.rules['react-hooks/set-state-in-effect'][0]).toBe(1);
		expect(config.rules['react-hooks/refs'][0]).toBe(1);
	}, TIMEOUT_MS);

	it('applies no-unused-vars everywhere, including the .cjs scripts', async () => {
		for (const file of ['app/candidates/new/page.js', 'scripts/preflight.cjs']) {
			const config = await eslint.calculateConfigForFile(file);
			expect(config.rules['no-unused-vars'][0], file).toBe(1);
		}
	}, TIMEOUT_MS);
});
