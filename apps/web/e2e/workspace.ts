// Helpers for the browser tests: the page's probe (src/app/probe.ts) and typing into the
// terminal the way a person does.

import { expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __simlab: {
      screen(): string[];
      tty(): string | undefined;
      type(text: string): Promise<number[]>;
      enter(prompt?: RegExp): Promise<{ parsed: number; painted: number }>;
      advance(ms: number): void;
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
