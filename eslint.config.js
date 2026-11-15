import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { ENGINE_PACKAGES } from './tools/eslint/boundaries.js';
import simlab from './tools/eslint/plugin.js';

export default tseslint.config(
  {
    // Fixtures are violations on purpose; plugin.test.ts lints them under a virtual path.
    ignores: ['**/node_modules/**', '.tsbuild/**', '.upstream/**', 'data/**', '**/dist/**', 'tools/eslint/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { simlab },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Guarantee 1: imports follow the dependency graph (PLAN.md §6).
      'simlab/package-boundaries': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // `const { field: _, ...rest } = record` is how a frozen record loses a field.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Guarantee 2: engine source is deterministic and host-independent (CLAUDE.md hard rule 4).
    // Tests are exempt: they may read fixtures from disk. docs/decisions.md D-005.
    files: ENGINE_PACKAGES.map((name) => `packages/${name}/src/**/*.ts`),
    ignores: ['**/*.test.ts'],
    rules: { 'simlab/engine-determinism': 'error' },
  },
  {
    files: ['**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
