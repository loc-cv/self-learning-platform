// The workspace around the terminal: copy and paste, tabs, a shell that exits, pause, the plain
// editor keys, and keys that must never reach the shell by accident.

import { expect, test } from '@playwright/test';
import { openLab, run, screen, waitForPrompt } from './workspace.ts';

test('copy the selection and paste into the terminal', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await run(page, 'echo copy-me-please');
  // Double-click selects a word in xterm.js; Ctrl+Shift+C copies it.
  const row = page.locator('.xterm-rows > div', { hasText: /^copy-me-please/ }).first();
  const box = await row.boundingBox();
  if (!box) throw new Error('the output row is not on screen');
  await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('copy-me-please');
  // Pasting is the browser's paste event on the terminal (Ctrl+Shift+V or the menu).
  await page.evaluate(() => {
    const ta = document.querySelector('.terminal-slot.is-active .xterm-helper-textarea') as HTMLTextAreaElement;
    const data = new DataTransfer();
    data.setData('text/plain', 'echo pasted-$HOSTNAME');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.evaluate(() => window.__simlab.enter());
  expect(await screen(page)).toContain('pasted-controlplane');
});

test('tabs: a second terminal, a shell that exits and comes back, closing a tab', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await run(page, 'export MARK=first');
  await page.getByRole('button', { name: /Another terminal/ }).click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await waitForPrompt(page);
  // Same machine, separate login: the variable is not in this shell.
  expect(await run(page, 'echo "[$MARK]" $(hostname)')).toContain('[] controlplane');
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ended-note')).toBeVisible();
  await expect(page.locator('.tab.is-active')).toHaveClass(/is-ended/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.ended-note')).toHaveCount(0);
  await waitForPrompt(page);
  expect(await run(page, 'echo back')).toContain('back');
  await page.keyboard.press('Control+Shift+X');
  await expect(page.locator('.tab')).toHaveCount(1);
  await waitForPrompt(page);
  expect(await run(page, 'echo $MARK')).toMatch(/\nfirst\n/);
});

test('pause stops the clock; Escape on a popover does not reach the shell', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.locator('.clock')).toHaveClass(/is-paused/);
  const t = await page.locator('.clock-time').textContent();
  await page.waitForTimeout(2200);
  await expect(page.locator('.clock-time')).toHaveText(t ?? '');
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.locator('.clock')).not.toHaveClass(/is-paused/);

  await page.locator('.topbar-trigger[title="Settings"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.popover')).toHaveCount(0);
  expect(await run(page, 'echo intact')).toMatch(/echo intact\nintact/);
});

test('plain editor keys: Ctrl+S saves, Ctrl+X closes, the choice is remembered', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await page.locator('.topbar-trigger[title="Settings"]').click();
  await page.getByRole('radio', { name: 'Plain' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.type('vi plain.txt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await expect(page.locator('.editor-help')).toContainText('Ctrl+S');
  await page.keyboard.type('typed without modes');
  await page.keyboard.press('Control+S');
  await expect(page.locator('.editor-status')).toContainText('Saved /root/plain.txt');
  await page.keyboard.press('Control+X');
  await expect(page.locator('.editor-overlay')).toHaveCount(0);
  await waitForPrompt(page);
  expect(await run(page, 'cat plain.txt')).toContain('typed without modes');
  await page.reload();
  await waitForPrompt(page);
  expect(await page.evaluate(() => localStorage.getItem('simlab.settings.v1'))).toContain('"editorKeys":"plain"');
});
