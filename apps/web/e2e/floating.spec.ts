// Phase 10d: the X-ray as a panel that floats over the workspace. It moves by its header and
// resizes from its edges, by pointer and by keyboard; it never leaves the workspace, also after
// the window shrinks; its place, size and mode are remembered; it docks again. While it floats
// the terminal keeps its width and typing still reaches the shell.

import { expect, test, type Page } from '@playwright/test';
import { openLab, openXray, run, settings, waitForPrompt } from './workspace.ts';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const rect = async (page: Page, selector = '.xray'): Promise<Box> => {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
};
const inside = (a: Box, b: Box): boolean => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
async function drag(page: Page, from: [number, number], by: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + by[0] / 2, from[1] + by[1] / 2, { steps: 4 });
  await page.mouse.move(from[0] + by[0], from[1] + by[1], { steps: 4 });
  await page.mouse.up();
}
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('simlab.settings.v1') ?? '{}') as { xrayMode?: string; xrayFloat?: { x: number; y: number; w: number; h: number } });

test('floating: the terminal keeps its width, typing reaches the shell, the header moves it', async ({ page }) => {
  await settings(page, { xrayMode: 'floating' });
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  const cols = await page.evaluate(() => window.__simlab.cols());
  const terminal = await rect(page, '.terminals');
  await openXray(page);
  await expect(page.locator('.xray')).toHaveClass(/is-floating/);
  // Nothing in the workspace moved or shrank for it.
  expect(await rect(page, '.terminals')).toEqual(terminal);
  expect(await page.evaluate(() => window.__simlab.cols())).toBe(cols);
  const workspace = await rect(page, '.workspace');
  const start = await rect(page);
  expect(inside(start, workspace)).toBe(true);
  // Typing goes to the shell as before.
  expect(await run(page, 'echo typed-while-floating')).toContain('\ntyped-while-floating\n');
  // Dragged by its header (the title, not a control): it follows the pointer.
  const title = await rect(page, '.xray-title h2');
  await drag(page, [title.x + 4, title.y + 4], [-300, -200]);
  const moved = await rect(page);
  expect(moved).toEqual({ x: start.x - 300, y: start.y - 200, width: start.width, height: start.height });
  // The drag did not take the keyboard away from the terminal.
  expect(await run(page, 'echo typed-after-moving')).toContain('\ntyped-after-moving\n');
  // Clicking a control of the X-ray does not either; clicking the drawing does (it has its own keys).
  await page.getByRole('button', { name: 'Zoom out' }).click();
  expect(await run(page, 'echo typed-after-zoom')).toContain('\ntyped-after-zoom\n');
  // Pushed far past every side, all of it stays inside the workspace.
  for (const by of [[-3000, -3000], [3000, 3000]] as [number, number][]) {
    const t = await rect(page, '.xray-title h2');
    await drag(page, [t.x + 4, t.y + 4], by);
    const r = await rect(page);
    expect(inside(r, workspace), `dragged by ${by.join(',')}`).toBe(true);
    expect({ width: r.width, height: r.height }).toEqual({ width: start.width, height: start.height });
  }
});

test('floating: resized from edges and corners, by pointer and by keyboard, never past the workspace', async ({ page }) => {
  await settings(page, { xrayMode: 'floating', xrayFloat: { x: 500, y: 200, w: 520, h: 400 } });
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await openXray(page);
  const workspace = await rect(page, '.workspace');
  const a = await rect(page);
  expect({ x: a.x - workspace.x, y: a.y - workspace.y, width: a.width, height: a.height }).toEqual({ x: 500, y: 200, width: 520, height: 400 });
  // The right edge.
  await drag(page, [a.x + a.width - 2, a.y + a.height / 2], [60, 0]);
  expect(await rect(page)).toEqual({ ...a, width: a.width + 60 });
  // The top left corner: the bottom right corner stays where it is.
  // (A few pixels in: the pane's corners are round.)
  await drag(page, [a.x + 6, a.y + 6], [-40, -30]);
  const b = await rect(page);
  expect(b).toEqual({ x: a.x - 40, y: a.y - 30, width: a.width + 100, height: a.height + 30 });
  // Smaller than the minimum is refused; larger than the workspace is refused.
  await drag(page, [b.x + b.width - 6, b.y + b.height - 6], [-3000, -3000]);
  expect(await rect(page)).toEqual({ x: b.x, y: b.y, width: 320, height: 240 });
  await drag(page, [b.x + 320 - 6, b.y + 240 - 6], [3000, 3000]);
  const c = await rect(page);
  expect(inside(c, workspace)).toBe(true);
  expect(c.x + c.width).toBeCloseTo(workspace.x + workspace.width, 0);
  expect(c.y + c.height).toBeCloseTo(workspace.y + workspace.height, 0);
  // The keyboard, from the move handle: arrows move, Shift+arrows resize.
  // Its chord takes the handle from the terminal.
  await page.keyboard.press('Control+Shift+G');
  await expect(page.getByRole('button', { name: 'Move the X-ray' })).toBeFocused();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  const d = await rect(page);
  expect(d).toEqual({ x: c.x, y: c.y, width: c.width - 24, height: c.height - 24 });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  expect(await rect(page)).toEqual({ ...d, x: d.x + 24, y: d.y + 24 });
  for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowUp');
  expect(await rect(page)).toEqual({ ...d, x: workspace.x, y: workspace.y });
  // The arrow keys moved the panel, not the shell's cursor or history; Escape gives the keyboard back.
  const rows = await page.evaluate(() => window.__simlab.screen());
  expect(rows.filter((r) => r.trim() !== '')).toHaveLength(1);
  await page.keyboard.press('Escape');
  expect(await run(page, 'echo back-from-the-handle')).toContain('\nback-from-the-handle\n');
});

test('floating: stays inside when the window shrinks; place, size and mode are remembered; it docks again', async ({ page }) => {
  await settings(page, { xrayMode: 'docked' });
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await openXray(page);
  await expect(page.locator('.xray')).toHaveClass(/is-docked/);
  const colsDocked = await page.evaluate(() => window.__simlab.cols());
  // The control in its header floats it; the terminal gets its width back.
  await page.getByRole('button', { name: 'Float the X-ray' }).click();
  await expect(page.locator('.xray')).toHaveClass(/is-floating/);
  await expect.poll(() => page.evaluate(() => window.__simlab.cols())).toBeGreaterThan(colsDocked);
  const title = await rect(page, '.xray-title h2');
  await drag(page, [title.x + 4, title.y + 4], [-150, -100]);
  const placed = await rect(page);
  expect((await stored(page)).xrayMode).toBe('floating');
  // A smaller window: all of it is still inside, and nothing of the page scrolls.
  await page.setViewportSize({ width: 800, height: 520 });
  await expect.poll(async () => inside(await rect(page), await rect(page, '.workspace'))).toBe(true);
  await page.setViewportSize({ width: 360, height: 300 });
  await expect.poll(async () => inside(await rect(page), await rect(page, '.workspace'))).toBe(true);
  expect(await page.evaluate(() => window.scrollX + window.scrollY)).toBe(0);
  // Back at the first size it is where it was left.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => rect(page)).toEqual(placed);
  // A reload: the X-ray is closed (it is help), and opens floating in the same place.
  await page.reload();
  await waitForPrompt(page);
  await expect(page.locator('.xray')).toHaveCount(0);
  await page.getByRole('button', { name: /^X-ray/ }).click();
  await expect(page.locator('.xray')).toHaveClass(/is-floating/);
  await expect.poll(() => rect(page)).toEqual(placed);
  // Docked again, and that is remembered too; floating later returns to the same place.
  await page.getByRole('button', { name: 'Dock the X-ray' }).click();
  await expect(page.locator('.xray')).toHaveClass(/is-docked/);
  await expect(page.locator('.splitter-xray')).toBeVisible();
  await page.reload();
  await waitForPrompt(page);
  await page.keyboard.press('Control+Shift+Y');
  await expect(page.locator('.xray')).toHaveClass(/is-docked/);
  await page.getByRole('button', { name: 'Float the X-ray' }).click();
  await expect.poll(() => rect(page)).toEqual(placed);
});
