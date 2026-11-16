// Phase 10 exit criterion 1: every lab is solvable in the browser, one through `kubectl edit` and
// one by editing a file with `vim`, both in the editor overlay with vim keys.

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { advance, check, openLab, run, screen, vimEx, waitForPrompt } from './workspace.ts';

const overlay = '.editor-overlay';

test('pending Pods: fix the node selector with kubectl edit (seed 1: disktype=SSD)', async ({ page }) => {
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  expect(await run(page, 'kubectl -n billing get pods')).toMatch(/worker-\S+\s+0\/1\s+Pending/);
  await page.keyboard.type('kubectl -n billing edit deployment worker');
  await page.keyboard.press('Enter');
  await expect(page.locator(overlay)).toBeVisible();
  await expect(page.locator('.editor-file')).toContainText('/tmp/kubectl-edit-');
  await expect(page.locator('.editor-status')).toContainText(/^"\/tmp\/kubectl-edit-\S+" \d+L, \d+B/);
  await page.screenshot({ path: '../../.tsbuild/playwright/kubectl-edit.png' });
  await vimEx(page, '%s/disktype: SSD/disktype: ssd/');
  await vimEx(page, 'wq');
  await expect(page.locator(overlay)).toHaveCount(0);
  await waitForPrompt(page);
  expect(await screen(page)).toContain('deployment.apps/worker edited');
  await advance(page, 90_000);
  expect(await run(page, 'kubectl -n billing get pods -o wide')).toMatch(/worker-\S+\s+1\/1\s+Running.*node01/);
  expect(await check(page)).toContain('Solved');
});

test('broken rollout: set the image and repoint the Service (seed 3)', async ({ page }) => {
  await openLab(page, 'k8s.troubleshooting.broken-rollout-01', 3);
  expect(await run(page, 'kubectl -n shop get pods')).toMatch(/ImagePullBackOff|ErrImagePull/);
  expect(await run(page, 'kubectl -n shop set image deployment/checkout checkout=nginx:1.31.8')).toContain('deployment.apps/checkout image updated');
  await page.keyboard.type('kubectl -n shop edit service checkout');
  await page.keyboard.press('Enter');
  await expect(page.locator(overlay)).toBeVisible();
  await vimEx(page, '%s#app.kubernetes.io/name: checkout#app: checkout#');
  await vimEx(page, 'wq');
  await expect(page.locator(overlay)).toHaveCount(0);
  await waitForPrompt(page);
  expect(await screen(page)).toContain('service/checkout edited');
  await advance(page, 120_000);
  expect(await run(page, 'kubectl -n shop get endpointslices')).toMatch(/checkout-\S+\s+IPv4\s+80\s+\d/);
  expect(await check(page)).toContain('Solved');
});

test('Deployment and Service from a file edited with vim (seed 3)', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 3);
  await run(page, 'kubectl -n billing create deployment web --image=nginx:1.31.8 --port=80 --dry-run=client -o yaml > /root/web.yaml');
  await page.keyboard.type('vim /root/web.yaml');
  await page.keyboard.press('Enter');
  await expect(page.locator(overlay)).toBeVisible();
  await expect(page.locator('.editor-status')).toContainText('"/root/web.yaml"');
  // Normal-mode editing, as a vim user would: find the line, change the number.
  await page.keyboard.type('/replicas', { delay: 5 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('$ciw4', { delay: 5 });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '../../.tsbuild/playwright/vim.png' });
  await vimEx(page, 'w');
  await expect(page.locator('.editor-status')).toContainText(/"\/root\/web\.yaml" \d+L, \d+B written/);
  await vimEx(page, 'q');
  await expect(page.locator(overlay)).toHaveCount(0);
  await waitForPrompt(page);
  expect(await run(page, 'grep replicas /root/web.yaml')).toContain('replicas: 4');
  await run(page, 'echo --- >> /root/web.yaml');
  await run(page, 'kubectl -n billing create service clusterip web --tcp=8080:80 --dry-run=client -o yaml >> /root/web.yaml');
  expect(await run(page, 'kubectl apply -f /root/web.yaml')).toMatch(/deployment.apps\/web created\s+service\/web created/);
  await advance(page, 90_000);
  expect(await check(page)).toContain('Solved');
});

test('vim refuses :q on a changed buffer with E37 and reports an unsupported command as [sim]', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await page.keyboard.type('vim notes.txt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-status')).toContainText('"notes.txt" [New]');
  await page.keyboard.type('ihello', { delay: 5 });
  await expect(page.locator('.editor-status')).toContainText('-- INSERT --');
  await page.keyboard.press('Escape');
  await vimEx(page, 'q');
  await expect(page.locator('.editor-status')).toContainText('E37: No write since last change (add ! to override)');
  await vimEx(page, 'sp');
  await expect(page.locator('.editor-status')).toContainText('[sim] vim: :sp is not simulated yet');
  await vimEx(page, 'frobnicate');
  await expect(page.locator('.editor-status')).toContainText('E492: Not an editor command: frobnicate');
  await expect(page.locator('.gap-count')).toHaveText('1');
  await vimEx(page, 'wq');
  await expect(page.locator('.overlay, .editor-overlay')).toHaveCount(0);
  await waitForPrompt(page);
  expect(await run(page, 'cat notes.txt')).toContain('hello');
  // The gap reaches the server's gap log (the tests' own data directory, playwright.config.ts).
  const log = '../../.tsbuild/playwright/data/gaps.jsonl';
  await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain('"commandLine":":sp"');
});
