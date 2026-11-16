// Phase 10c: figures in the lab panel. Each lab's ticket carries a figure and each debrief opens with
// figures; the broken rollout's scene steps forward and back and replays, and nothing plays by
// itself under reduced motion. Screenshots of every debrief, and of a comparison enlarged, go to
// .tsbuild/playwright/ (copy them out before the next run: Playwright empties the directory).

import { expect, test, type Page } from '@playwright/test';
import { openLab } from './workspace.ts';

const SHOTS = '../../.tsbuild/playwright';

async function settings(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((s) => localStorage.setItem('simlab.settings.v1', JSON.stringify(s)), { theme: 'dark', editorKeys: 'vim', panelWidth: 440, panelOpen: true, fontSize: 14, xrayWidth: 520, motion: 'system', ...extra });
}

async function openDebrief(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Debrief' }).click();
  await page.getByRole('button', { name: 'Read it anyway' }).click();
  await expect(page.locator('.debrief .figure').first()).toBeVisible();
}

/** The lab panel's scroll area at full height, so a screenshot holds the whole debrief. */
async function shootDebrief(page: Page, name: string): Promise<void> {
  const height = await page.locator('.lab-scroll').evaluate((el) => el.scrollHeight);
  await page.setViewportSize({ width: 1440, height: Math.min(6000, height + 260) });
  await page.locator('.debrief').scrollIntoViewIfNeeded();
  await page.locator('.debrief').screenshot({ path: `${SHOTS}/${name}.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
}

const LABS = [
  { id: 'k8s.scheduling.pending-pods-01', seed: 3, variant: 'taint', ticket: 1, debrief: ['compare', 'diagram'] },
  { id: 'k8s.scheduling.pending-pods-01', seed: 1, variant: 'selector', ticket: 1, debrief: ['compare', 'diagram'] },
  { id: 'k8s.scheduling.pending-pods-01', seed: 4, variant: 'memory', ticket: 1, debrief: ['compare', 'diagram'] },
  { id: 'k8s.troubleshooting.broken-rollout-01', seed: 1, variant: 'name', ticket: 0, debrief: ['compare', 'scene'] },
  { id: 'k8s.workloads.deployment-service-01', seed: 1, variant: 'all', ticket: 1, debrief: ['view', 'view'] },
] as const;

for (const lab of LABS) {
  test(`${lab.id} (${lab.variant}): the ticket's figure, the debrief opens with figures`, async ({ page }) => {
    await settings(page);
    await openLab(page, lab.id, lab.seed);
    const ticket = page.locator('.ticket .figure');
    await expect(ticket).toHaveCount(lab.ticket);
    // The drawing is one image whose name is the alt text.
    if (lab.ticket > 0) await expect(ticket.locator('svg[role="img"]')).toHaveAttribute('aria-label', /.{40,}/);
    await openDebrief(page);
    const body = page.locator('.debrief > :not(header)');
    // The first thing in the debrief is a figure.
    await expect(body.first()).toHaveClass(/\bfigure\b/);
    const kinds = await page.locator('.debrief .figure').evaluateAll((els) => els.map((e) => /figure-(view|compare|scene|diagram)/.exec(e.className)?.[1]));
    expect(kinds).toEqual(lab.debrief);
    await expect(page.locator('.debrief .figure.is-failed')).toHaveCount(0);
    await shootDebrief(page, `debrief-${lab.id.split('.')[1]}-${lab.variant}`);
  });
}

test('the scheduling lab: the ticket shows Pending Pods with no node; the comparison marks what changed', async ({ page }) => {
  await settings(page);
  await openLab(page, 'k8s.scheduling.pending-pods-01', 3);
  const ticket = page.locator('.ticket .figure');
  await expect(ticket.locator('.vlane-label')).toHaveText('Pods with no node');
  await expect(ticket.locator('.vcard.vbox-process')).toHaveCount(3);
  // No facts in the ticket's figure: `show: []`.
  await expect(ticket.locator('.vfact')).toHaveCount(0);
  await openDebrief(page);
  const compare = page.locator('.debrief .figure-compare');
  const [left, right] = [compare.locator('.figure-panel').nth(0), compare.locator('.figure-panel').nth(1)];
  await expect(left.locator('.figure-panel-title')).toHaveText('At the start');
  await expect(right.locator('.figure-panel-title')).toHaveText('Solved');
  await expect(left.locator('.vbox.is-removed')).toHaveCount(3);
  await expect(right.locator('.vmark-change.is-added')).toHaveCount(4);
  // The node's taint and the new Pods' tolerations, wrapped onto a second line in narrow cards.
  await expect(right.locator('.vfact-value', { hasText: /^dedicated=shop:(NoSchedule)?$/ })).toHaveCount(4);
  await expect(compare.locator('.figure-divergence')).toHaveText('DIV-043');
  // Enlarged, the two sides stand side by side.
  await compare.getByRole('button', { name: 'Show larger' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const panels = dialog.locator('.figure-panel');
  const [a, b] = [await panels.nth(0).boundingBox(), await panels.nth(1).boundingBox()];
  expect(a && b && Math.abs(a.y - b.y) < 1 && b.x > a.x + a.width - 1).toBe(true);
  await page.screenshot({ path: `${SHOTS}/debrief-scheduling-taint-enlarged.png` });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('the broken rollout: step through the scene, back, and replay', async ({ page }) => {
  await settings(page);
  await openLab(page, 'k8s.troubleshooting.broken-rollout-01', 1);
  await openDebrief(page);
  const scene = page.locator('.debrief .figure-scene');
  const count = scene.locator('.scene-count');
  const caption = scene.locator('.scene-caption');
  await expect(count).toHaveText('1 / 5');
  await expect(caption).toContainText('Before the release');
  const pods = (): Promise<number> => scene.locator('.vcard.vbox-process:not(.is-leaving)').count();
  expect(await pods()).toBe(4);
  // Nothing plays by itself.
  await page.waitForTimeout(3000);
  await expect(count).toHaveText('1 / 5');
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await expect(count).toHaveText('2 / 5');
  await expect(caption).toContainText('maxSurge');
  await expect(scene.locator('.vcard.state-progressing.vbox-process')).toHaveCount(2);
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await expect(count).toHaveText('3 / 5');
  await expect(scene.locator('.vcard.state-failed.vbox-process')).toHaveCount(2);
  await scene.locator('.figure-panel').screenshot({ path: `${SHOTS}/scene-rollout-frame3.png` });
  await scene.getByRole('button', { name: 'Previous frame' }).click();
  await expect(count).toHaveText('2 / 5');
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await expect(count).toHaveText('5 / 5');
  await expect(scene.getByRole('button', { name: 'Next frame' })).toBeDisabled();
  // Replay goes back to the first frame and plays on its own.
  await scene.getByRole('button', { name: 'Replay' }).click();
  await expect(count).toHaveText('1 / 5');
  await expect(count).toHaveText('2 / 5', { timeout: 5000 });
});

test('under reduced motion, Replay only goes back to the first frame', async ({ page }) => {
  await settings(page, { motion: 'reduced' });
  await openLab(page, 'k8s.troubleshooting.broken-rollout-01', 1);
  await openDebrief(page);
  const scene = page.locator('.debrief .figure-scene');
  const count = scene.locator('.scene-count');
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await scene.getByRole('button', { name: 'Next frame' }).click();
  await expect(count).toHaveText('3 / 5');
  await scene.getByRole('button', { name: 'Replay' }).click();
  await expect(count).toHaveText('1 / 5');
  await page.waitForTimeout(3500);
  await expect(count).toHaveText('1 / 5');
});
