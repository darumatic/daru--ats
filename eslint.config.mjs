import nextConfig from 'eslint-config-next';

// eslint-config-next registers the react-hooks plugin on this glob only. A
// rules object that names a react-hooks rule has to carry the same `files`, or
// ESLint hard-errors on any file outside it ("could not find plugin
// react-hooks") — which is what an unscoped override did to scripts/*.cjs,
// since the glob covers cts but not cjs.
const NEXT_PLUGIN_FILES = ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'];

// These rules flag pre-existing patterns that we want to track but not block
// CI on until fixed incrementally. Downgrade all to warnings so the lint step
// reports issues without breaking the build on existing code.
const existingCodeWarnings = {
	'react-hooks/set-state-in-effect': 'warn',
	'react-hooks/refs': 'warn',
	'react-hooks/exhaustive-deps': 'warn',
	'react-hooks/preserve-manual-memoization': 'warn'
};

export default [
	...nextConfig,
	{
		files: NEXT_PLUGIN_FILES,
		rules: existingCodeWarnings
	},
	{
		// Core rule, so it needs no plugin and can cover the .cjs scripts too.
		rules: {
			'no-unused-vars': 'warn'
		}
	}
];
