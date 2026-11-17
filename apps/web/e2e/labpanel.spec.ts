// Phase 10d: the lab panel in tabs. Ticket, Check, Hints, Debrief and Solutions each have a tab;
// a tab says what it holds before it is opened and when something new arrived; what gives the
// answer away asks first and is recorded; the tabs follow the ARIA tabs pattern and are reachable
// from the terminal by chord; each tab keeps its own scroll position.

import { expect, test, type Page } from '@playwright/test';
import { advance, check, labTab, openLab, run, settings, vimEx, waitForPrompt, pressCheck } from './workspace.ts';

const strip = (page: Page) => page.getByRole('tablist', { name: 'The lab' });
const selected = (page: Page) => strip(page).getByRole('tab', { selected: true });
const panel = (page: Page) => page.locator('.lab-scroll.is-active');

test('each part has its tab; an action opens the tab that shows its result', async ({ page }) => {
  await settings(page);
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await expect(strip(page).getByRole('tab')).toHaveText([/^Ticket$/, /^Check$/, /^Hints0\/3$/, /^Debrief$/, /^Solutions$/]);
  // The ticket first, and one panel at a time.
  await expect(selected(page)).toHaveText('Ticket');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(panel(page).locator('.ticket .figure')).toBeVisible();
  // An empty tab says what will appear in it.
  await labTab(page, 'Check').click();
  await expect(panel(page)).toContainText('Not checked yet');
  await labTab(page, 'Hints').click();
  await expect(panel(page)).toContainText('This lab has 3 hints');
  await labTab(page, 'Ticket').click();
  // Check, from the button under every tab: its tab opens with the report, the badge has the score.
  await pressCheck(page);
  await expect(selected(page)).toHaveText(/^Check3\/5$/);
  await expect(labTab(page, 'Check').locator('.tabstrip-badge')).toHaveAttribute('aria-label', '3 of 5 checks pass');
  await expect(panel(page).locator('.check.is-fail')).toHaveCount(2);
  await expect(panel(page).locator('.score-pct')).toHaveText('38%');
  // A hint, by its chord from the terminal: the Hints tab opens, the badge counts.
  await page.keyboard.press('Control+Shift+H');
  await expect(selected(page)).toHaveText(/^Hints1\/3$/);
  await expect(panel(page).locator('.hints li')).toHaveCount(1);
  // The actions are under every tab.
  for (const name of ['Ticket', 'Check', 'Hints', 'Debrief', 'Solutions']) {
    await labTab(page, name).click();
    for (const action of [/^Check/, /^Hint/, 'Reset']) await expect(page.locator('.lab-actions').getByRole('button', { name: action })).toBeVisible();
  }
  // With the panel hidden, an action brings it back to show its result.
  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('.lab-panel')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+Enter');
  await expect(selected(page)).toHaveText(/^Check/);
});

test('Debrief and Solutions ask first, and what was opened is recorded', async ({ page }) => {
  await settings(page);
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await labTab(page, 'Debrief').click();
  await expect(panel(page)).toContainText('The lab is not solved yet, and the debrief gives the answer away.');
  await expect(page.locator('.debrief')).toHaveCount(0);
  // Leaving without answering opens nothing.
  await labTab(page, 'Solutions').click();
  await expect(panel(page)).toContainText('Seeing the reference solutions before the lab is solved is giving up');
  await expect(page.locator('.solutions')).toHaveCount(0);
  await page.getByRole('button', { name: 'Give up and see the solution' }).click();
  await expect(page.locator('.solutions .solution').first()).toBeVisible();
  // Having given up, the debrief no longer asks: the answer is out.
  await expect(page.locator('.lab-kicker')).toContainText('gave up');
  await labTab(page, 'Debrief').click();
  await expect(page.locator('.debrief .figure').first()).toBeVisible();
  // Both were recorded with the attempt: after a reload neither asks again.
  await page.reload();
  await waitForPrompt(page);
  await expect(selected(page)).toHaveText('Ticket');
  await labTab(page, 'Solutions').click();
  await expect(page.locator('.solutions .solution').first()).toBeVisible();
  await labTab(page, 'Debrief').click();
  await expect(page.locator('.debrief .figure').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Give up and read it' })).toHaveCount(0);
  await expect(page.locator('.lab-kicker')).toContainText('gave up');
});

test('a solved lab: the Check tab says so and the Debrief tab says it has something new', async ({ page }) => {
  await settings(page);
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await expect(labTab(page, 'Debrief').locator('.tabstrip-fresh')).toHaveCount(0);
  await page.keyboard.type('kubectl -n billing edit deployment worker');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await vimEx(page, '%s/disktype: SSD/disktype: ssd/');
  await vimEx(page, 'wq');
  await expect(page.locator('.editor-overlay')).toHaveCount(0);
  await waitForPrompt(page);
  await advance(page, 90_000);
  expect(await check(page)).toContain('Solved');
  await expect(selected(page)).toHaveText(/^Check5\/5$/);
  await expect(labTab(page, 'Check')).toHaveClass(/is-ok/);
  // The debrief no longer asks; its tab is marked until it is opened.
  await expect(labTab(page, 'Debrief').locator('.tabstrip-fresh')).toHaveText('new');
  // The grade is there with the result, and can be changed with one click.
  await expect(page.locator('.report .rating')).toContainText('Next review');
  await page.getByRole('button', { name: 'Read the debrief' }).click();
  await expect(selected(page)).toHaveText(/^Debrief/);
  // The debrief first asks for the cause in the learner's words; it can be skipped.
  await expect(page.locator('.debrief')).toHaveCount(0);
  await page.locator('.explain').getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.debrief .figure').first()).toBeVisible();
  await expect(labTab(page, 'Debrief').locator('.tabstrip-fresh')).toHaveCount(0);
});

test('keyboard: a chord goes to the tabs, arrows move between them, Escape returns to the shell', async ({ page }) => {
  await settings(page);
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
  // The chord is claimed (the browser must not act on it) and focus goes to the next tab.
  const prevented = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const on = (e: KeyboardEvent): void => {
          if (e.code !== 'Period') return;
          window.removeEventListener('keydown', on, true);
          setTimeout(() => resolve(e.defaultPrevented));
        };
        window.addEventListener('keydown', on, true);
      }),
  );
  await page.keyboard.press('Control+Shift+Period');
  expect(await prevented).toBe(true);
  await expect(selected(page)).toHaveText('Check');
  await expect.poll(focused).toBe('lab-tab-check');
  // The ARIA tabs pattern: arrows select and wrap, Home and End go to the ends, one tab stop.
  await page.keyboard.press('ArrowRight');
  await expect(selected(page)).toHaveText(/^Hints/);
  expect(await focused()).toBe('lab-tab-hints');
  await page.keyboard.press('End');
  await expect(selected(page)).toHaveText('Solutions');
  await page.keyboard.press('ArrowRight');
  await expect(selected(page)).toHaveText('Ticket');
  await page.keyboard.press('ArrowLeft');
  await expect(selected(page)).toHaveText('Solutions');
  await page.keyboard.press('Home');
  await expect(selected(page)).toHaveText('Ticket');
  expect(await strip(page).getByRole('tab').evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length)).toBe(1);
  for (const t of await strip(page).getByRole('tab').all()) {
    const controls = await t.getAttribute('aria-controls');
    expect(await page.locator(`#${controls}`).getAttribute('aria-labelledby')).toBe(await t.getAttribute('id'));
  }
  // Tab goes into the panel; what asks first is reachable and usable by keyboard.
  await page.keyboard.press('Control+Shift+Comma');
  await expect(selected(page)).toHaveText('Solutions');
  await expect.poll(focused).toBe('lab-tab-solutions');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('lab-panel-solutions');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Give up and see the solution');
  await page.keyboard.press('Enter');
  await expect(page.locator('.solutions .solution').first()).toBeVisible();
  // Nothing typed so far reached the shell; Escape goes back to it.
  await labTab(page, 'Hints').focus();
  await page.keyboard.press('Escape');
  await run(page, 'echo back-in-the-shell');
  const rows = await page.evaluate(() => window.__simlab.screen());
  expect(rows.filter((r) => r.trim() !== '').slice(0, 3).join('\n')).toMatch(/^\S+[$#] echo back-in-the-shell\nback-in-the-shell\n\S+[$#] ?$/);
});

test('each tab keeps its own scroll position', async ({ page }) => {
  await settings(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await pressCheck(page);
  await expect(page.locator('.report .verdict')).toBeVisible();
  await panel(page).evaluate((el) => el.scrollTo(0, 180));
  await labTab(page, 'Ticket').click();
  expect(await panel(page).evaluate((el) => el.scrollTop)).toBe(0);
  await panel(page).evaluate((el) => el.scrollTo(0, 90));
  await labTab(page, 'Hints').click();
  await labTab(page, 'Check').click();
  expect(await panel(page).evaluate((el) => el.scrollTop)).toBe(180);
  await labTab(page, 'Ticket').click();
  expect(await panel(page).evaluate((el) => el.scrollTop)).toBe(90);
});

test('layout at 100%, 125% and 150% display scaling: tabs fit, the terminal keeps 80 columns', async ({ browser }) => {
  for (const deviceScaleFactor of [1, 1.25, 1.5]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor });
    const page = await context.newPage();
    await settings(page);
    await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
    const at = `at ${deviceScaleFactor}x`;
    const measure = () =>
      page.evaluate(() => {
        const strip = document.querySelector('.tabstrip') as HTMLElement;
        const boxes = [...document.querySelectorAll('.lab-panel, .terminals, .xray')].map((e) => e.getBoundingClientRect());
        return {
          cols: window.__simlab.cols(),
          tabsFit: strip.scrollWidth <= strip.clientWidth,
          inside: boxes.every((b) => b.left >= 0 && b.right <= window.innerWidth + 0.5 && b.bottom <= window.innerHeight + 0.5),
          // Docked panes lie side by side.
          apart: boxes.every((b, i) => i === 0 || document.querySelector('.xray.is-floating') !== null || b.left >= (boxes[i - 1] as DOMRect).right - 0.5),
        };
      });
    const closed = await measure();
    expect(closed, at).toMatchObject({ tabsFit: true, inside: true, apart: true });
    expect(closed.cols, at).toBeGreaterThanOrEqual(80);
    // The X-ray docked: it and the lab panel give way, the terminal keeps its columns.
    await page.keyboard.press('Control+Shift+Y');
    await expect(page.locator('.xray.is-docked .vcanvas .vbox').first()).toBeVisible();
    await expect.poll(async () => (await measure()).cols, at).toBeGreaterThanOrEqual(80);
    expect(await measure(), at).toMatchObject({ inside: true, apart: true });
    // Floating: the terminal is as wide as with the X-ray closed.
    await page.getByRole('button', { name: 'Float the X-ray' }).click();
    await expect(page.locator('.xray.is-floating')).toBeVisible();
    await expect.poll(async () => (await measure()).cols, at).toBe(closed.cols);
    expect(await measure(), at).toMatchObject({ tabsFit: true, inside: true });
    await context.close();
  }
});
