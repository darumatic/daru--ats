import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['tests/unit/**/*.test.js'],
		environment: 'node'
	},
	resolve: {
		alias: {
			'@': resolve(import.meta.dirname, '.'),
			'server-only': resolve(import.meta.dirname, 'tests/stubs/server-only.js')
		}
	}
});
