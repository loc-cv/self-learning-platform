// Playwright for the web app's smoke and exit-criteria tests: a production build served by the
// app server, opened in the Chromium headless shell that Playwright 1.64.1 uses. `npm run e2e`.

import { defineConfig } from '@playwright/test';

const PORT = 4318;

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
  webServer: {
    command: `npm run build && node ../server/src/main.ts --port ${PORT} --data ../../.tsbuild/playwright/data`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
