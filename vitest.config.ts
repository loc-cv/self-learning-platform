import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.upstream/**', 'tools/eslint/fixtures/**'],
    // The lab tests take about 1.5 s each on an idle machine. With another project's jobs on every
    // core (load 18, 2026-11-17) one passed Vitest's default of 5 s and failed the gate. The engine
    // is deterministic, so a slow test is a busy machine, not a hang (docs/decisions.md D-116).
    testTimeout: 30_000,
  },
});
