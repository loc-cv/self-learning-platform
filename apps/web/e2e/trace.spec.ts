// Phase 13: the causal trace on screen, against the real engine. "Why?" on a Pending Pod names
// every node with its reason; the timeline marks the commands, and scrubbing back reads an earlier
// world, read-only, until "Back to now"; the time controls pause, speed up and skip, by button and
// by chord; a solved attempt's debrief replays it, and the reference solution's run beside it; the
// assist levels take away what they say; a 30-Pod rollout at 10× with the X-ray and its timeline
// open keeps the page responsive. Screenshots go to .tsbuild/playwright/trace/.

import { expect, test, type Page } from '@playwright/test';
import { advance, labTab, openDebrief, openLab, pressCheck, run, screen, settings, vimEx, waitForPrompt } from './workspace.ts';

const SHOTS = '../../.tsbuild/playwright/trace';
const LAB = 'k8s.scheduling.pending-pods-01';
const POD = '.xray [data-id^="k8s/Pod/billing/worker-"]';

/** Presses a chord and resolves with whether the page prevented the browser's default. */
async function chord(page: Page, keys: string, code: string): Promise<boolean> {
  const prevented = page.evaluate(
    (c) =>
      new Promise<boolean>((resolve) => {
        const on = (e: KeyboardEvent): void => {
          if (e.code !== c) return;
          window.removeEventListener('keydown', on, true);
          setTimeout(() => resolve(e.defaultPrevented));
        };
        window.addEventListener('keydown', on, true);
      }),
    code,
  );
  await page.keyboard.press(keys);
  return prevented;
}

async function openXray(page: Page): Promise<void> {
  expect(await chord(page, 'Control+Shift+Y', 'KeyY')).toBe(true);
  await expect(page.locator('.xray .vcanvas .vbox').first()).toBeVisible();
}

/** The fix of the scheduling lab, typed in the terminal: the selector's value in the right case. */
async function fixSelector(page: Page): Promise<void> {
  await page.locator('.terminal-slot.is-active').click();
  await page.keyboard.type('kubectl -n billing edit deployment worker');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await vimEx(page, '%s/disktype: SSD/disktype: ssd/');
  await vimEx(page, 'wq');
  await expect(page.locator('.editor-overlay')).toHaveCount(0);
  await waitForPrompt(page);
  expect(await screen(page)).toContain('deployment.apps/worker edited');
}

/** The clock's text in the top bar (virtual time spent). */
const clockText = (page: Page) => page.locator('.clock-time').innerText();
const seconds = (t: string): number => t.split(':').reduce((n, x) => n * 60 + Number(x), 0);

test('Why? on a Pending Pod names every node and why the scheduler passed it over', async ({ page }) => {
  await settings(page, {});
  await openLab(page, LAB, 1);
  await openXray(page);
  await page.locator(POD).first().click();
  await expect(page.locator('.xray-detail')).toBeVisible();
  await page.locator('.xray-detail').getByRole('button', { name: /Why\?/ }).click();
  const why = page.locator('.xray-detail .why');
  await expect(why.locator('.why-summary')).toBeVisible();
  // One line per node, each with a reason, as the FailedScheduling event gives them.
  const lines = why.locator('.trace-items li');
  for (const node of ['controlplane', 'node01', 'node02']) await expect(lines.filter({ hasText: node }).first()).toBeVisible();
  for (const text of await lines.allInnerTexts()) expect(text.trim().length).toBeGreaterThan(0);
  // The simulator speaks here, not a real tool: the event text is not in the code font.
  expect(await why.locator('.trace-text').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Sans');
  await page.screenshot({ path: `${SHOTS}/why-pending.png` });
  // An item about a node selects that node; the inspector asks again for it.
  await lines.filter({ hasText: 'node01' }).first().getByRole('button').click();
  await expect(page.locator('.xray [data-id="k8s/Node/node01"].is-selected')).toHaveCount(1);
  await expect(page.locator('.xray-detail .why, .xray-detail .why-wait').first()).toBeVisible();
});

test('the timeline marks a command; scrubbing back reads an earlier world, read-only, and returns to now', async ({ page }) => {
  await settings(page, {});
  await openLab(page, LAB, 1);
  await openXray(page);
  await expect(page.locator('.timeline')).toBeVisible();
  await run(page, 'kubectl -n billing get pods');
  await expect(page.locator('.timeline .tl-input').first()).toBeVisible();
  await fixSelector(page);
  await advance(page, 90_000);
  await expect(page.locator(`${POD}[aria-label$=": Running, healthy"]`)).toHaveCount(3);
  // Home on the playhead: the world at the start, with the Pods still Pending.
  await page.locator('.timeline-track').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('.xray-past')).toBeVisible();
  await expect(page.locator('.xray-past')).toContainText('read-only');
  await expect(page.locator(`${POD}[aria-label*="Pending"]`)).toHaveCount(3);
  // The world at the start holds nothing the fix made: the new ReplicaSet fades out and is gone.
  await expect(page.locator('.xray .is-leaving')).toHaveCount(0);
  await expect(page.locator('.xray [data-id^="k8s/ReplicaSet/billing/"]')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/timeline-past.png` });
  // The terminal and the world go on: a command still runs.
  await page.locator('.terminal-slot.is-active').click();
  expect(await run(page, 'kubectl -n billing get deploy worker --no-headers')).toMatch(/worker\s+3\/3/);
  await page.getByRole('button', { name: 'Back to now' }).click();
  await expect(page.locator('.xray-past')).toHaveCount(0);
  await expect(page.locator(`${POD}[aria-label$=": Running, healthy"]`)).toHaveCount(3);
  // Selecting a command's mark opens it on the card, the command in the code font (commands a
  // few pixels apart form one mark, and a click reaches the newest of them).
  const mark = await page.locator('.timeline .tl-input').first().boundingBox();
  if (!mark) throw new Error('no command mark');
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(page.locator('.xray-event .trace-input')).toContainText('kubectl -n billing');
  await expect(page.locator('.xray-past')).toBeVisible();
  // From the start, the arrow keys go from mark to mark: the first is the first command.
  await page.locator('.timeline-track').focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => {
    await page.keyboard.press('ArrowRight');
    return (await page.locator('.xray-event .trace-input').count()) > 0 ? await page.locator('.xray-event .trace-input').innerText() : '';
  }, { timeout: 10_000 }).toContain('kubectl -n billing get pods');
  await page.screenshot({ path: `${SHOTS}/timeline-command.png` });
  await page.locator('.timeline-track').focus();
  await page.keyboard.press('End');
  await expect(page.locator('.xray-past')).toHaveCount(0);
});

test('time controls: pause stops the clock, 10× runs it faster, skip jumps; the chords are claimed', async ({ page }) => {
  await settings(page, {});
  await openLab(page, LAB, 1);
  // Pause by chord: the clock stands still and the terminal says what that means.
  expect(await chord(page, 'Control+Shift+Space', 'Space')).toBe(true);
  await expect(page.locator('.clock.is-paused')).toBeVisible();
  await expect(page.locator('.paused-note')).toBeVisible();
  const paused = await clockText(page);
  await page.waitForTimeout(2500);
  expect(await clockText(page)).toBe(paused);
  await page.screenshot({ path: `${SHOTS}/paused.png` });
  await page.locator('.paused-note').getByRole('button', { name: /Resume/ }).click();
  await expect(page.locator('.clock.is-paused')).toHaveCount(0);
  await expect(page.locator('.paused-note')).toHaveCount(0);
  // 10× by clicking, then the next speed by chord wraps to 1×.
  await page.locator('.speed-switch').getByRole('radio', { name: '10×' }).click();
  await expect(page.locator('.speed-switch [aria-checked="true"]')).toHaveText('10×');
  const before = seconds(await clockText(page));
  await page.waitForTimeout(3000);
  const after = seconds(await clockText(page));
  expect(after - before).toBeGreaterThanOrEqual(18);
  expect(await chord(page, 'Control+Shift+S', 'KeyS')).toBe(true);
  await expect(page.locator('.speed-switch [aria-checked="true"]')).toHaveText('1×');
  // Skip to the next event: the note says how far, or that nothing is scheduled.
  const s0 = seconds(await clockText(page));
  expect(await chord(page, 'Control+Shift+J', 'KeyJ')).toBe(true);
  const note = page.locator('.skip-note');
  await expect(note).toBeVisible();
  const said = await note.innerText();
  expect(said).toMatch(/^\+\d|Nothing is scheduled to happen within the hour/);
  await expect.poll(async () => seconds(await clockText(page)), { timeout: 5000 }).toBeGreaterThanOrEqual(s0);
  await page.screenshot({ path: `${SHOTS}/skipped.png` });
  // The shortcut sheet lists the three.
  await page.keyboard.press('Control+Shift+Slash');
  for (const k of ['Ctrl+Shift+Space', 'Ctrl+Shift+S', 'Ctrl+Shift+J']) await expect(page.locator('.keys kbd', { hasText: k }).first()).toBeVisible();
});

test('a solved attempt replays in the debrief: start, change and settled frames, the reference run on request', async ({ page }) => {
  await settings(page, {});
  await openLab(page, LAB, 1);
  await run(page, 'kubectl -n billing get pods');
  await fixSelector(page);
  await advance(page, 90_000);
  await pressCheck(page);
  await expect(page.locator('.report .verdict')).toContainText('Solved');
  await labTab(page, 'Debrief').click();
  await page.locator('.explain').getByRole('button', { name: 'Skip' }).click();
  const replay = page.locator('.debrief .replay').first();
  await expect(replay).toBeVisible();
  await expect(replay.locator('.replay-kind')).toHaveText('At the start');
  const kinds = new Set<string>();
  const count = Number((await replay.locator('.scene-count').innerText()).split('/')[1]);
  for (let i = 0; i < count; i++) {
    kinds.add(await replay.locator('.replay-kind').innerText());
    if (i === 0) {
      await replay.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `${SHOTS}/replay-start.png` });
    }
    if (i === count - 1) {
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${SHOTS}/replay-last.png` });
    }
    if ((await replay.locator('.replay-kind').innerText()) === 'Your change landed') {
      await expect(replay.locator('.replay-labels')).toContainText('kubectl');
      await page.screenshot({ path: `${SHOTS}/replay-change.png` });
    }
    if (i < count - 1) await replay.getByRole('button', { name: 'Next frame' }).click();
  }
  expect([...kinds]).toEqual(expect.arrayContaining(['At the start', 'Your change landed', 'The world went on']));
  // Every command, also the one that changed nothing.
  const inputs = page.locator('.debrief .replay-inputs li');
  await expect(inputs.filter({ hasText: 'kubectl -n billing get pods' })).toHaveCount(1);
  await expect(inputs.filter({ hasText: 'kubectl -n billing edit deployment worker' })).toHaveCount(1);
  await page.getByRole('button', { name: /reference solution’s run/ }).click();
  await expect(page.locator('.debrief .replay')).toHaveCount(2);
  await page.locator('.debrief .replay').nth(1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/replay-reference.png` });
});

test('assist off: no X-ray anywhere, the chord does nothing, no world state beside the terminal and the ticket', async ({ page }) => {
  await settings(page, { assist: 'off' });
  await openLab(page, LAB, 1);
  await expect(page.locator('.xray-trigger')).toHaveCount(0);
  expect(await chord(page, 'Control+Shift+Y', 'KeyY')).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.locator('.xray')).toHaveCount(0);
  await expect(page.locator('.timeline')).toHaveCount(0);
  // The only drawings are the ticket's own figures, on every tab.
  const outsideTicket = () => page.evaluate(() => [...document.querySelectorAll('.vcanvas')].filter((el) => !el.closest('.ticket')).length);
  expect(await page.locator('.ticket .vcanvas').count()).toBeGreaterThan(0);
  for (const tab of ['Ticket', 'Check', 'Hints']) {
    await labTab(page, tab).click();
    expect(await outsideTicket()).toBe(0);
    await expect(page.locator('.lab-scroll.is-active .vcanvas:visible')).toHaveCount(tab === 'Ticket' ? await page.locator('.ticket .vcanvas').count() : 0);
  }
  await page.locator('.topbar-trigger[title="Settings"]').click();
  await expect(page.locator('.setting-assist')).toContainText('The exam gives none');
  await page.screenshot({ path: `${SHOTS}/assist-off.png` });
});

test('assist view: the X-ray without Why? or the timeline, and it says so', async ({ page }) => {
  await settings(page, { assist: 'view' });
  await openLab(page, LAB, 1);
  await openXray(page);
  await expect(page.locator('.timeline')).toHaveCount(0);
  await expect(page.locator('.xray-level')).toContainText('without Why? or the timeline');
  await page.locator(POD).first().click();
  await expect(page.locator('.xray-detail')).toBeVisible();
  await expect(page.locator('.xray-why')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/assist-view.png` });
});

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
};

test('a 30-replica rollout at 10× with the X-ray and its timeline open: the page stays responsive', async ({ page }) => {
  await settings(page, { panelOpen: false });
  await openLab(page, LAB, 1);
  await openXray(page);
  await expect(page.locator('.timeline')).toBeVisible();
  await run(page, 'clear');
  // Long tasks and the gaps between animation frames, while the rollout runs.
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __gaps: number[]; __stop: boolean };
    w.__long = [];
    w.__gaps = [];
    w.__stop = false;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
    let last = performance.now();
    const frame = (t: number): void => {
      w.__gaps.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  // The headless shell's own rhythm of frames, before anything runs: the gaps below compare with it.
  await page.waitForTimeout(2000);
  const idle = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[] };
    const g = w.__gaps;
    w.__gaps = [];
    return g;
  });
  await page.locator('.speed-switch').getByRole('radio', { name: '10×' }).click();
  await page.locator('.terminal-slot.is-active').click();
  await run(page, 'kubectl create deployment big --image=nginx --replicas=30');
  const keys: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    keys.push(...(await page.evaluate(() => window.__simlab.type('echo responsive'))));
    await page.evaluate(() => window.__simlab.enter());
  }
  await page.screenshot({ path: `${SHOTS}/rollout-10x.png` });
  const { long, gaps } = await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __gaps: number[]; __stop: boolean };
    w.__stop = true;
    return { long: w.__long, gaps: w.__gaps };
  });
  await expect(page.locator('.xray [data-id^="k8s/Pod/default/big-"]')).toHaveCount(30, { timeout: 30_000 });
  const events = await page.locator('.timeline .tl-event, .timeline .tl-input').count();
  console.log(
    `30-replica rollout at 10×, X-ray and timeline open: keystroke echo p50 ${pct(keys, 50).toFixed(1)} ms, p95 ${pct(keys, 95).toFixed(1)} ms, max ${Math.max(...keys).toFixed(1)} ms (${keys.length} keys); ` +
      `frame gaps p95 ${pct(gaps, 95).toFixed(1)} ms (idle before: p95 ${pct(idle, 95).toFixed(1)} ms), max ${Math.max(...gaps).toFixed(0)} ms (${gaps.length} frames); long tasks ${long.length}, longest ${Math.max(0, ...long).toFixed(0)} ms; ${events} timeline marks`,
  );
  expect(pct(keys, 95)).toBeLessThan(50);
  // No frame is dropped beyond the headless shell's own rhythm by more than two frames at 60 Hz.
  expect(pct(gaps, 95)).toBeLessThan(Math.max(50, pct(idle, 95)) + 34);
  expect(Math.max(0, ...long)).toBeLessThan(250);
});

// The owner's screen is scaled (memory/owner-environment.md): 125% and 150% on a 1920×1080 display
// give these CSS viewports. Docked at its narrowest and floating, the timeline fits its pane and
// reads a past moment by keyboard; under reduced motion nothing travels.
for (const [scale, viewport] of [
  [1, { width: 1440, height: 900 }],
  [1.25, { width: 1536, height: 730 }],
  [1.5, { width: 1280, height: 620 }],
] as const) {
  test(`the timeline fits docked (narrow) and floating at device scale ${scale}, reduced motion`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await settings(page, { xrayWidth: 320 });
    await openLab(page, LAB, 1);
    await run(page, 'kubectl -n billing get pods');
    // A moment to go back to: at the very start, the start is now.
    await advance(page, 10_000);
    await openXray(page);
    for (const mode of ['docked', 'floating'] as const) {
      if (mode === 'floating') await page.getByRole('button', { name: 'Float the X-ray' }).click();
      const xray = await page.locator('.xray').boundingBox();
      const track = await page.locator('.timeline-track').boundingBox();
      const head = await page.locator('.timeline-head').boundingBox();
      if (!xray || !track || !head) throw new Error('no box');
      expect(track.width).toBeGreaterThan(200);
      for (const b of [track, head]) expect(b.x + b.width).toBeLessThanOrEqual(xray.x + xray.width + 0.5);
      // Every control of the head is inside it.
      for (const el of await page.locator('.timeline-head > *').all()) {
        const b = await el.boundingBox();
        if (b && b.width > 0) expect(b.x + b.width, mode).toBeLessThanOrEqual(head.x + head.width + 0.5);
      }
      await page.locator('.timeline-track').focus();
      await page.keyboard.press('Home');
      await expect(page.locator('.xray-past')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/timeline-${mode}-scale-${scale}.png` });
      await page.keyboard.press('End');
      await expect(page.locator('.xray-past')).toHaveCount(0);
    }
    expect(await page.evaluate(() => [...document.querySelectorAll('.vcause-comet')].every((el) => getComputedStyle(el).display === 'none'))).toBe(true);
    await ctx.close();
  });
}

// No item has a scene anchored to the trace yet, so this test hands the page one: the ticket's
// first figure becomes a two-frame scene whose second frame carries a cause with per-candidate
// items and a link between two drawn entities. The page draws what it is given; the engine's side
// of anchored frames is tested in packages/learn.
test('a scene frame anchored to the trace quotes its cause and moves along its link once', async ({ page }) => {
  await page.addInitScript(() => {
    const Orig = window.Worker;
    class Rewriting extends Orig {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let handler: ((e: { data: unknown }) => void) | null = null;
        Object.defineProperty(this, 'onmessage', {
          configurable: true,
          get: () => handler,
          set: (fn: typeof handler) => {
            handler = fn;
          },
        });
        this.addEventListener('message', (e) => {
          const r = (window as unknown as { __rewrite?: (d: unknown) => unknown }).__rewrite;
          handler?.({ data: r ? r(e.data) : e.data });
        });
      }
    }
    window.Worker = Rewriting as typeof Worker;
    (window as unknown as { __rewrite: (d: unknown) => unknown }).__rewrite = (d) => {
      const m = d as { type: string; lab?: { ticket: { figure?: { kind: string; caption: string; alt: string; panel?: { model: { t: number; entities: { id: string; kind: string }[] } } } }[] } };
      const fig = m.type === 'ready' ? m.lab?.ticket.find((b) => b.figure?.panel)?.figure : undefined;
      if (!fig?.panel) return d;
      const panel = fig.panel;
      const ids = panel.model.entities.map((e) => e.id);
      const from = ids.find((id) => id.includes('/ReplicaSet/')) ?? ids[0];
      const to = ids.find((id) => id.includes('/Pod/')) ?? ids[1];
      const t = panel.model.t;
      Object.assign(fig, {
        kind: 'scene',
        frames: [
          { caption: 'Before.', panel, t },
          {
            caption: 'After.',
            panel: { ...panel, links: [{ from, to }] },
            t: t + 4000,
            cause: { id: 9, t: t + 4000, actor: 'test-actor', text: 'a hand-made cause for the test', about: [to], level: 'key', tone: 'bad', causes: [], items: [{ label: 'candidate-a', value: 'a reason', tone: 'bad' }, { label: 'candidate-b', value: 'fits', tone: 'good' }] },
          },
        ],
      });
      delete (fig as { panel?: unknown }).panel;
      return d;
    };
  });
  await settings(page, {});
  await openLab(page, LAB, 1);
  const scene = page.locator('.ticket .figure-scene').first();
  await expect(scene).toBeVisible();
  await expect(scene.locator('.scene-cause')).toHaveCount(0);
  await scene.getByRole('button', { name: 'Next frame' }).click();
  const cause = scene.locator('.scene-cause');
  await expect(cause).toContainText('test-actor');
  await expect(cause).toContainText('a hand-made cause for the test');
  await expect(cause.locator('.trace-when')).toHaveText('+0:04');
  await expect(cause.locator('.trace-items li')).toHaveCount(2);
  await expect(cause.locator('.sim-voice')).toBeVisible();
  // The link is a static mark with an arrow, and a stroke travels it once.
  await expect(scene.locator('.vcause-path')).toHaveCount(1);
  const anim = await scene.locator('.vcause-comet').evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe('vcause-travel');
  await page.waitForTimeout(1300);
  await scene.screenshot({ path: `${SHOTS}/scene-cause.png` });
});

test('the scheduling debrief\'s scene quotes the scheduler\'s verdict per node under its caption', async ({ page }) => {
  await settings(page, {});
  await openLab(page, LAB, 1);
  await openDebrief(page);
  const scene = page.locator('.debrief .figure-scene').first();
  await scene.scrollIntoViewIfNeeded();
  await scene.getByRole('button', { name: 'Next frame' }).click();
  const cause = scene.locator('.scene-cause');
  await expect(cause).toContainText('kube-scheduler');
  for (const node of ['controlplane', 'node01', 'node02']) await expect(cause.locator('.trace-items li', { hasText: node }).first()).toBeVisible();
  await page.waitForTimeout(1300);
  await scene.screenshot({ path: `${SHOTS}/scene-cause-scheduler.png` });
});
