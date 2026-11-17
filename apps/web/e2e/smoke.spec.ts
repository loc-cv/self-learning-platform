// The phase 10 smoke test: open a lab from the list, type a command, run the check, see a result.

import { expect, test } from '@playwright/test';
import { check, run, waitForPrompt, startFromBrowser } from './workspace.ts';

test('open a lab, type a command, check it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
  await startFromBrowser(page, 'A new Deployment whose Pods never start');
  await waitForPrompt(page);
  const out = await run(page, 'kubectl get pods -A');
  expect(out).toMatch(/NAMESPACE\s+NAME\s+READY\s+STATUS/);
  expect(out).toMatch(/Pending/);
  const verdict = await check(page);
  expect(verdict).toMatch(/% of the checks' weight passes/);
  await expect(page.locator('.check.is-fail').first()).toBeVisible();
  await page.screenshot({ path: '../../.tsbuild/playwright/smoke.png' });
});
