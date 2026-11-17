// Helpers for the browser tests: the page's probe (src/app/probe.ts) and typing into the
// terminal the way a person does.

import { expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __simlab: {
      screen(): string[];
      cols(): number;
      tty(): string | undefined;
      type(text: string): Promise<number[]>;
      enter(prompt?: RegExp): Promise<{ parsed: number; painted: number }>;
      advance(ms: number): void;
      speed(n: number): void;
    };
  }
}

/** Opens a lab variant by deep link and waits for the shell prompt. */
export async function openLab(page: Page, lab: string, seed: number): Promise<void> {
  await page.goto(`/?lab=${lab}&seed=${seed}`);
  await waitForPrompt(page);
}

export async function waitForPrompt(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const rows = window.__simlab?.screen() ?? [];
    const last = rows.filter((r) => r.trim() !== '').pop() ?? '';
    return /[$#]$/.test(last.trimEnd());
  }, null, { timeout: 60_000 });
}

/** The terminal's visible text. */
export async function screen(page: Page): Promise<string> {
  return (await page.evaluate(() => window.__simlab.screen())).join('\n');
}

/** Types a command with the keyboard, presses Enter and waits for the prompt to come back. */
export async function run(page: Page, command: string): Promise<string> {
  await page.keyboard.type(command, { delay: 2 });
  await page.evaluate(() => window.__simlab.enter());
  return screen(page);
}

/** Lets virtual time pass (Pods start, rollouts finish) without waiting in real time. */
export async function advance(page: Page, ms: number): Promise<void> {
  await page.evaluate((d) => window.__simlab.advance(d), ms);
  await page.waitForTimeout(150);
}

/** The settings a test starts with (browser storage), before the page loads. */
export async function settings(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  // Only when nothing is stored yet: a reload keeps what the page saved.
  await page.addInitScript((s) => {
    if (localStorage.getItem('simlab.settings.v1') === null) localStorage.setItem('simlab.settings.v1', JSON.stringify(s));
  }, { theme: 'dark', editorKeys: 'vim', panelWidth: 440, panelOpen: true, fontSize: 14, xrayWidth: 520, xrayMode: 'docked', motion: 'system', ...extra });
}

/** Opens the X-ray with its chord, in the mode the settings name. */
export async function openXray(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+Y');
  await expect(page.locator('.xray .vcanvas .vbox').first()).toBeVisible();
}

/** The lab panel's tab of that name. */
export const labTab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });

/** Opens the debrief before the lab is solved: its tab asks first. */
export async function openDebrief(page: Page): Promise<void> {
  await labTab(page, 'Debrief').click();
  await page.getByRole('button', { name: 'Read it anyway' }).click();
  await expect(page.locator('.debrief .figure').first()).toBeVisible();
}

/** Runs the check from the lab panel and returns the verdict text. */
export async function check(page: Page): Promise<string> {
  await page.getByRole('button', { name: /^Check/ }).click();
  const verdict = page.locator('.report .verdict');
  await expect(verdict).toBeVisible();
  return (await verdict.textContent()) ?? '';
}

/** Types into the editor overlay (vim keys): Ex commands go through vim's `:` prompt. */
export async function vimEx(page: Page, command: string): Promise<void> {
  await page.keyboard.type(`:${command}`, { delay: 5 });
  await page.keyboard.press('Enter');
}
