// Phase 10b: the X-ray, the live view of the world beside the terminal. In the scheduling lab it
// shows the Pending Pods apart from every node, and after the fix in the terminal the new Pods on
// the right node, without a reload. A 30-Pod rollout keeps the page responsive; reduced motion
// makes change instant. Screenshots of the workspace with the X-ray open and closed, both themes.

import { expect, test, type Page } from '@playwright/test';
import { advance, openLab, run, screen, vimEx, waitForPrompt } from './workspace.ts';

const SHOTS = '../../.tsbuild/playwright';

async function settings(page: Page, extra: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => localStorage.setItem('simlab.settings.v1', JSON.stringify(s)), { theme: 'dark', editorKeys: 'vim', panelWidth: 440, panelOpen: true, fontSize: 14, xrayWidth: 560, motion: 'system', ...extra });
}

/** Opens the X-ray with its chord and checks the page claimed the chord. */
async function openXray(page: Page): Promise<void> {
  const prevented = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const on = (e: KeyboardEvent): void => {
          if (e.code !== 'KeyY') return;
          window.removeEventListener('keydown', on, true);
          setTimeout(() => resolve(e.defaultPrevented));
        };
        // Capture phase, after the workspace's own listener, which stops propagation.
        window.addEventListener('keydown', on, true);
      }),
  );
  await page.keyboard.press('Control+Shift+Y');
  expect(await prevented).toBe(true);
  await expect(page.locator('.xray')).toBeVisible();
  await expect(page.locator('.vcanvas .vbox').first()).toBeVisible();
}

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
};
const within = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;

test('the scheduling lab: Pending Pods outside every node, then Running on node01 after the fix', async ({ page }) => {
  await settings(page, {});
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await expect(page.locator('.xray')).toHaveCount(0);
  await openXray(page);
  const pods = page.locator('[data-id^="k8s/Pod/billing/worker-"]');
  await expect(pods).toHaveCount(3);
  for (const label of await pods.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))) expect(label).toMatch(/^Pod worker-\S+: Pending, degraded$/);
  await expect(page.locator('.vlane-label')).toHaveText('Pods with no node');
  const lane = await box(page, '.vlane-frame');
  const nodes = await Promise.all(['controlplane', 'node01', 'node02'].map((n) => box(page, `[data-id="k8s/Node/${n}"] .vbox-frame`)));
  for (const p of await pods.all()) {
    const b = await p.boundingBox();
    if (!b) throw new Error('no box');
    expect(within(b, lane)).toBe(true);
    for (const n of nodes) expect(within(b, n)).toBe(false);
  }
  // Selecting an entity reads its facts.
  await pods.first().click();
  await expect(page.locator('.xray-detail')).toContainText('Node-Selectors');
  await expect(page.locator('.xray-detail')).toContainText('disktype=SSD');
  // The keyboard reaches every entity: arrows move the selection, Escape clears it.
  const first = await pods.first().getAttribute('data-id');
  await page.keyboard.press('ArrowRight');
  const moved = await page.locator('.vbox.is-selected').getAttribute('data-id');
  expect(moved).not.toBe(first);
  await expect(page.locator(`[data-id="${moved}"]`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vbox.is-selected')).toHaveCount(0);
  await pods.first().click();
  await page.screenshot({ path: `${SHOTS}/xray-pending.png` });

  // The fix, typed in the terminal: the X-ray follows without a reload.
  await page.locator('.terminal-slot.is-active').click();
  await page.keyboard.type('kubectl -n billing edit deployment worker');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await vimEx(page, '%s/disktype: SSD/disktype: ssd/');
  await vimEx(page, 'wq');
  await expect(page.locator('.editor-overlay')).toHaveCount(0);
  await waitForPrompt(page);
  expect(await screen(page)).toContain('deployment.apps/worker edited');
  await advance(page, 90_000);
  const running = page.locator('[data-id^="k8s/Pod/billing/worker-"][aria-label$=": Running, healthy"]');
  await expect(running).toHaveCount(3);
  await expect(page.locator('.vlane')).toHaveCount(0);
  // Positions and sizes settle after the move transition.
  await page.waitForTimeout(800);
  const node01 = await box(page, '[data-id="k8s/Node/node01"] .vbox-frame');
  for (const p of await running.all()) {
    const b = await p.boundingBox();
    if (!b) throw new Error('no box');
    expect(within(b, node01)).toBe(true);
  }
  await page.screenshot({ path: `${SHOTS}/xray-fixed.png` });
  // The X-ray agrees with kubectl on the same world.
  const out = await run(page, 'kubectl -n billing get pods -o wide --no-headers');
  const names = [...out.matchAll(/^(worker-\S+)\s+1\/1\s+Running\s+\S+\s+\S+\s+\S+\s+node01/gm)].map((m) => m[1]);
  expect(names.sort()).toEqual((await running.evaluateAll((els) => els.map((e) => (e.getAttribute('data-id') ?? '').split('/').pop()))).sort());
});

for (const theme of ['dark', 'light'] as const) {
  test(`screenshots, ${theme} theme: the X-ray open and closed`, async ({ page }) => {
    await settings(page, { theme });
    await openLab(page, 'k8s.troubleshooting.broken-rollout-01', 3);
    await run(page, 'kubectl -n shop get pods');
    await page.screenshot({ path: `${SHOTS}/workspace-${theme}-xray-closed.png` });
    await openXray(page);
    await page.locator('[data-id^="k8s/Service/shop/"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/workspace-${theme}-xray-open.png` });
  });
}

test('a 30-Pod rollout with the X-ray open: keystrokes still echo at once, no long frame', async ({ page }) => {
  await settings(page, { panelOpen: false });
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await run(page, 'kubectl create deployment big --image=nginx:1.31.8 --replicas=30');
  await advance(page, 60_000);
  await openXray(page);
  await expect(page.locator('[data-id^="k8s/Pod/default/big-"][aria-label$="healthy"]')).toHaveCount(30, { timeout: 30_000 });
  await run(page, 'clear');
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  await run(page, 'kubectl set image deployment/big nginx=nginx:1.14.2');
  // Virtual time at 10× real time: the rollout runs while we type.
  await page.evaluate(() => window.__simlab.speed(10));
  const keys: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    keys.push(...(await page.evaluate(() => window.__simlab.type('echo responsive'))));
    await page.evaluate(() => window.__simlab.enter());
  }
  await page.evaluate(() => window.__simlab.speed(1));
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  const sorted = [...keys].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
  console.log(`rollout of 30 Pods, X-ray open: keystroke echo p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (${keys.length} keys); long tasks ${long.length}, longest ${Math.max(0, ...long).toFixed(0)} ms`);
  // The rollout went through while we typed.
  await expect(page.locator('[data-id^="k8s/Deployment/default/big"]')).toHaveAttribute('aria-label', /: 30\/30, healthy$/, { timeout: 30_000 });
  expect(p95).toBeLessThan(50);
  expect(Math.max(0, ...long)).toBeLessThan(200);
});

test('reduced motion: change is instant, from the system or the setting', async ({ browser }) => {
  for (const how of ['system', 'setting'] as const) {
    const ctx = await browser.newContext(how === 'system' ? { reducedMotion: 'reduce' } : {});
    const page = await ctx.newPage();
    await settings(page, { motion: how === 'setting' ? 'reduced' : 'system' });
    await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
    await openXray(page);
    const pod = page.locator('[data-id^="k8s/Pod/billing/worker-"]').first();
    expect(await pod.evaluate((el) => getComputedStyle(el).transitionDuration.split(',').every((d) => parseFloat(d) === 0))).toBe(true);
    // A Pod that goes away leaves at once: no fading copy stays behind.
    await page.locator('.terminal-slot.is-active').click();
    await run(page, 'kubectl -n billing delete pod --all --wait=false');
    await advance(page, 5_000);
    await expect(page.locator('.vbox.is-leaving')).toHaveCount(0);
    await ctx.close();
  }
  // Without either, the same Pod moves with a transition.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await settings(page, {});
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await openXray(page);
  const pod = page.locator('[data-id^="k8s/Pod/billing/worker-"]').first();
  expect(await pod.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeGreaterThan(0);
  await ctx.close();
});
