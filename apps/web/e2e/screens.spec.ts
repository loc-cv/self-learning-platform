// Phase 10d: screenshots of every screen in both themes, for the owner to look at: the workspace
// with the X-ray closed, docked and floating, a debrief, the lab list and the editor overlay.
// Phase 13: "Why?" on the selection, a past moment read from the timeline, the time controls
// after a skip and while paused, and the debrief's replay.
// They go to .tsbuild/playwright/screens/ (copy them out before the next run: Playwright empties
// the directory). The workspace is the scheduling lab after a failed check and one hint.

import { expect, test } from '@playwright/test';
import { labTab, openDebrief, openLab, openXray, run, settings, pressCheck, openBrowser } from './workspace.ts';

const SHOTS = '../../.tsbuild/playwright/screens';

for (const theme of ['dark', 'light'] as const) {
  test(`screenshots, ${theme} theme`, async ({ page }) => {
    await settings(page, { theme });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${theme}-home.png` });
    await openBrowser(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-browser.png` });
    await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
    await run(page, 'kubectl -n billing get pods');
    await page.getByRole('button', { name: /^Hint/ }).click();
    await expect(page.locator('.hints li')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/${theme}-workspace-hints.png` });
    await pressCheck(page);
    await expect(page.locator('.report .verdict')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${theme}-workspace-xray-closed.png` });
    await openXray(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/${theme}-workspace-xray-docked.png` });
    await page.getByRole('button', { name: 'Float the X-ray' }).click();
    await labTab(page, 'Ticket').click();
    // The floating X-ray is smaller than the docked one: everything fits once fitted.
    await page.getByRole('button', { name: 'Fit everything' }).click();
    await page.locator('.xray [data-id^="k8s/Pod/billing/worker-"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/${theme}-workspace-xray-floating.png` });
    await page.getByRole('button', { name: 'Dock the X-ray' }).click();
    // The Pod chosen while floating is still selected (a second click would clear it).
    await expect(page.locator('.xray-detail')).toBeVisible();
    await page.locator('.xray-detail').getByRole('button', { name: /Why\?/ }).click();
    await expect(page.locator('.xray-detail .why, .xray-detail .why-none').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${theme}-xray-why.png` });
    await page.locator('.timeline-track').focus();
    await page.keyboard.press('Home');
    await expect(page.locator('.xray-past')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${theme}-xray-past.png` });
    await page.keyboard.press('End');
    await page.locator('.terminal-slot.is-active').click();
    await page.keyboard.press('Control+Shift+J');
    await expect(page.locator('.skip-note')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${theme}-time-skipped.png` });
    await page.keyboard.press('Control+Shift+Space');
    await expect(page.locator('.paused-note')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${theme}-time-paused.png` });
    await page.keyboard.press('Control+Shift+Space');
    await page.keyboard.press('Control+Shift+Y');
    await labTab(page, 'Solutions').click();
    await page.screenshot({ path: `${SHOTS}/${theme}-solutions-asks.png` });
    await openDebrief(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${theme}-debrief.png` });
    const replay = page.locator('.debrief .replay').first();
    if ((await replay.count()) > 0) {
      await replay.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      const next = replay.getByRole('button', { name: 'Next frame' });
      if (await next.isEnabled()) await next.click();
      await page.waitForTimeout(1400);
      await page.screenshot({ path: `${SHOTS}/${theme}-debrief-replay.png` });
    }
    await page.getByRole('button', { name: 'Show larger' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${theme}-figure-dialog.png` });
    await page.keyboard.press('Escape');
    await page.locator('.topbar-trigger[title="Settings"]').click();
    await expect(page.locator('.popover')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${theme}-settings.png` });
    await page.keyboard.press('Escape');
    await page.locator('.terminal-slot.is-active').click();
    await page.keyboard.type('kubectl -n billing edit deployment worker');
    await page.keyboard.press('Enter');
    await expect(page.locator('.editor-overlay')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${theme}-editor.png` });
  });
}
