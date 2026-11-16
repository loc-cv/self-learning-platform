// Phase 10 exit criterion 2: reloading mid-lab resumes with the same terminal content and world.
// Also: several terminals on the same machine, and a vim session open across the reload.

import { expect, test } from '@playwright/test';
import { openLab, run, screen, waitForPrompt } from './workspace.ts';

test('a reload replays the attempt: same terminals, same world, the open editor', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 2);
  await run(page, 'kubectl -n media create deployment catalog --image=nginx:1.31.8 --replicas=3');
  await run(page, 'kubectl -n media get deploy');
  await page.getByRole('button', { name: /Hint/ }).click();
  await expect(page.locator('.hints li')).toHaveCount(1);
  const first = await screen(page);

  // A second terminal on the same machine, with a vim session left open in it.
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.tab')).toHaveCount(2);
  await waitForPrompt(page);
  await run(page, 'echo second terminal');
  await page.keyboard.type('vim draft.yaml');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await page.keyboard.type('ikind: Service', { delay: 5 });
  await page.keyboard.press('Escape');
  await page.keyboard.type(':w', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-status')).toContainText('written');

  // At once: what was on screen is in the stored log (the page holds every input, D-105).
  await page.reload();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('kind: Service');
  await expect(page.locator('.hints li')).toHaveCount(1);
  await page.keyboard.type(':q', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toHaveCount(0);
  await waitForPrompt(page);
  expect(await run(page, 'cat draft.yaml')).toContain('kind: Service');

  await page.keyboard.press('Control+Shift+1');
  await page.waitForTimeout(200);
  const after = await screen(page);
  // The first terminal shows what it showed: the commands and their output.
  for (const line of first.split('\n').filter((l) => l.trim() !== '')) expect(after).toContain(line.trimEnd());
  expect(await run(page, 'kubectl -n media get deploy catalog --no-headers')).toMatch(/catalog\s+\d\/3\s+3/);
});
