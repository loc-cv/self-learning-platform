// Playwright for the web app's smoke and exit-criteria tests: a production build served by the
// app server, opened in the Chromium headless shell that Playwright 1.64.1 uses. `npm run e2e`.

import { defineConfig } from '@playwright/test';

const PORT = 4318;
/** A second server over the same build with a data directory of its own: the tests that start from an empty log. */
export const FRESH_PORT = 4320;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../.tsbuild/playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The build also bundles the fixture pack (a lesson, cards, a drill, sidecars): vite.config.ts.
      command: `SIMLAB_FIXTURES=1 npm run build && node ../server/src/main.ts --port ${PORT} --data ../../.tsbuild/playwright/data`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `node ../server/src/main.ts --port ${FRESH_PORT} --data ../../.tsbuild/playwright/data-fresh`,
      url: `http://127.0.0.1:${FRESH_PORT}/api/settings`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
