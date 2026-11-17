// Phase 10 exit criterion 4 (the page's half): nothing is loaded from a network. Every request
// the page makes goes to the local server, and with the browser offline a lab still runs.

import { expect, test } from '@playwright/test';
import { check, run, waitForPrompt, startFromBrowser } from './workspace.ts';

test('every request stays on the local server, and the app runs offline once loaded', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL as string).origin;
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) foreign.push(u);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
  await context.setOffline(true);
  await startFromBrowser(page, 'Last night');
  await waitForPrompt(page);
  expect(await run(page, 'kubectl get deploy -A')).toMatch(/kube-system\s+coredns/);
  expect(await check(page)).toMatch(/passes/);
  await context.setOffline(false);
  expect(foreign).toEqual([]);
});
