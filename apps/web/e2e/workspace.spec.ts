// The workspace around the terminal: copy and paste, tabs, a shell that exits, pause, the plain
// editor keys, and keys that must never reach the shell by accident.

import { expect, test } from '@playwright/test';
import { openLab, run, screen, waitForPrompt, pressCheck } from './workspace.ts';

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
  // The server keeps the settings too, for a browser that has none of its own.
  await expect.poll(async () => ((await (await page.request.get('/api/settings')).json()) as { editorKeys?: string }).editorKeys).toBe('plain');
  // Back to vim keys, so the tests after this one start from the defaults.
  await page.locator('.topbar-trigger[title="Settings"]').click();
  await page.getByRole('radio', { name: 'Vim' }).click();
  await expect.poll(async () => ((await (await page.request.get('/api/settings')).json()) as { editorKeys?: string }).editorKeys).toBe('vim');
});

// FEEDBACK 2026-11-17 (Chrome on Windows): Ctrl+Shift+C opened DevTools, Ctrl+W closed the tab,
// Ctrl+Shift+1 did nothing, and the tab's close button drew its icon off-center.

test('workspace chords are claimed every time; Ctrl+W, Ctrl+T, Ctrl+N never fall through', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await page.evaluate(() => {
    const w = window as unknown as { keys: Record<string, boolean> };
    w.keys = {};
    window.addEventListener('keydown', (e) => setTimeout(() => (w.keys[`${e.ctrlKey ? 'C-' : ''}${e.shiftKey ? 'S-' : ''}${e.code}`] = e.defaultPrevented), 0), true);
  });
  const claimed = (k: string): Promise<boolean | undefined> => page.evaluate((key) => (window as unknown as { keys: Record<string, boolean> }).keys[key], k);

  // With nothing selected in the terminal the chord is still the page's, and it copies what is
  // selected elsewhere (the ticket).
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => claimed('C-S-KeyC')).toBe(true);
  await page.locator('.lab-head h1, .lab-title').first().dblclick();
  const word = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(word).not.toBe('');
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(word);

  // Previous and next terminal, wrapping.
  await page.getByRole('button', { name: /Another terminal/ }).click();
  await page.getByRole('button', { name: /Another terminal/ }).click();
  await expect(page.locator('.tab')).toHaveCount(3);
  const active = (): Promise<number> => page.evaluate(() => [...document.querySelectorAll('.tab')].findIndex((t) => t.classList.contains('is-active')));
  await expect.poll(active).toBe(2);
  await page.keyboard.press('Control+Shift+PageDown');
  await expect.poll(active).toBe(0);
  await page.keyboard.press('Control+Shift+PageUp');
  await expect.poll(active).toBe(2);
  await page.keyboard.press('Control+Shift+PageUp');
  await expect.poll(active).toBe(1);
  await page.keyboard.press('Control+Shift+Digit1');
  await expect.poll(active).toBe(0);
  expect(await claimed('C-S-PageUp')).toBe(true);
  expect(await claimed('C-S-PageDown')).toBe(true);
  await waitForPrompt(page);

  // Ctrl+W is unix-word-rubout in the shell and never the browser's, wherever the focus is.
  await page.keyboard.type('echo one two');
  await page.keyboard.press('Control+w');
  await page.keyboard.type('three');
  await page.evaluate(() => window.__simlab.enter());
  expect(await screen(page)).toMatch(/\none three\n/);
  expect(await claimed('C-KeyW')).toBe(true);
  await page.keyboard.type('vim keys.txt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  // vim's normal mode: Ctrl+W is the window prefix, which the overlay does not have.
  // (Lower-case key names: vim reads the key's character, and "W" would be <C-W>.)
  for (const k of ['w', 't', 'n']) {
    await page.evaluate(() => ((window as unknown as { keys: Record<string, boolean> }).keys = {}));
    await page.keyboard.press(`Control+${k}`);
    await expect.poll(() => claimed(`C-Key${k.toUpperCase()}`)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.type('ione two');
  await page.keyboard.press('Control+w');
  await expect(page.locator('.cm-content')).toHaveText('one ');
});

test('full screen from the top bar and by chord', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  const full = (): Promise<boolean> => page.evaluate(() => document.fullscreenElement !== null);
  await page.getByRole('button', { name: /^Full screen/ }).click();
  await expect.poll(full).toBe(true);
  await expect(page.getByRole('button', { name: /^Leave full screen/ })).toHaveAttribute('aria-pressed', 'true');
  // The terminal keeps the keyboard.
  expect(await run(page, 'echo still-here')).toContain('still-here');
  await page.keyboard.press('Control+Shift+F');
  await expect.poll(full).toBe(false);
  await expect(page.getByRole('button', { name: /^Full screen/ })).toHaveAttribute('aria-pressed', 'false');
});

test('the page is installable: a manifest with icons the server serves', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const res = await request.get(href ?? '');
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const manifest = (await res.json()) as { display: string; start_url: string; icons: { src: string; sizes: string }[] };
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((i) => i.sizes)).toEqual(['any', '192x192', '512x512']);
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
});

test('icons sit in the middle of their buttons, at 100%, 125% and 150% display scaling', async ({ browser }) => {
  for (const deviceScaleFactor of [1, 1.25, 1.5]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor });
    const page = await context.newPage();
    await openLab(page, 'k8s.workloads.deployment-service-01', 1);
    await page.getByRole('button', { name: /Another terminal/ }).click();
    await expect(page.locator('.tab')).toHaveCount(2);
    // The close button shows on hover.
    await page.locator('.tab').first().hover();
    const off = await page.evaluate(() => {
      const out: string[] = [];
      for (const b of document.querySelectorAll('button')) {
        const kids = [...b.childNodes].filter((n) => n.nodeType === 1 || (n.textContent ?? '').trim() !== '');
        const icon = kids[0] as Element | undefined;
        if (kids.length !== 1 || icon?.nodeName.toLowerCase() !== 'svg') continue;
        const r = b.getBoundingClientRect();
        const i = icon.getBoundingClientRect();
        if (r.width === 0) continue;
        const dx = i.left + i.width / 2 - (r.left + r.width / 2);
        const dy = i.top + i.height / 2 - (r.top + r.height / 2);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) out.push(`${b.getAttribute('aria-label') ?? b.title}: ${dx.toFixed(2)}, ${dy.toFixed(2)}`);
      }
      // The new-terminal button sits on the tabs' line.
      const tab = document.querySelector('.tab')?.getBoundingClientRect();
      const plus = document.querySelector('.tab-new')?.getBoundingClientRect();
      if (tab && plus && Math.abs(tab.top + tab.height / 2 - (plus.top + plus.height / 2)) > 1) out.push('the new-terminal button is off the tabs line');
      return { out, checked: document.querySelectorAll('button > svg:only-child').length };
    });
    expect(off.checked).toBeGreaterThan(4);
    expect(off.out, `at ${deviceScaleFactor}x`).toEqual([]);
    await context.close();
  }
});

// Checkpoint A2: the editor asked for a font variable that no longer existed and fell back to
// the interface's proportional font, in which YAML indentation does not line up.
test('the editor overlay is set in the code font, like the terminal: columns line up', async ({ page }) => {
  await openLab(page, 'k8s.workloads.deployment-service-01', 1);
  await page.keyboard.type('vim font.yaml');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-overlay')).toBeVisible();
  await page.keyboard.type('iiiiiiiiii', { delay: 2 }); // i enters insert mode, then nine letters
  await page.keyboard.press('Enter');
  await page.keyboard.type('MMMMMMMMM', { delay: 2 });
  await page.keyboard.press('Escape');
  const lines = page.locator('.editor-body .cm-line');
  await expect(lines).toHaveCount(2);
  const widths = await lines.evaluateAll((els) =>
    els.map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect().width;
    }),
  );
  expect(widths[0]).toBeGreaterThan(40);
  expect(Math.abs((widths[0] ?? 0) - (widths[1] ?? 0))).toBeLessThan(0.5);
  // The same family as every other piece of code on the page, and vim's command line too.
  const code = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim());
  const family = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
  const norm = (s: string): string => s.replace(/["'\s]/g, '');
  expect(norm(await family('.editor-body .cm-content'))).toBe(norm(code));
  await page.keyboard.type(':');
  await expect(page.locator('.editor-body .cm-vim-panel')).toBeVisible();
  expect(norm(await family('.editor-body .cm-vim-panel'))).toBe(norm(code));
  expect(norm(await family('.editor-body .cm-vim-panel input'))).toBe(norm(code));
});

// Checkpoint A2: "the whole page shifts upward, leaving a blank area at the bottom" on the first
// click on Solutions. Not reproduced; whatever scrolled it, the page must not be scrollable, and
// the lab panel moves only its own scroller.
test('the page itself never scrolls: showing the solutions moves only the lab panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  // Something taller than the window, as a browser quirk or an extension might add.
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.style.height = '3000px';
    // After the app, not inside it: inside, it would be a flex item that squeezes the workspace away.
    document.body.append(tall);
  });
  await pressCheck(page);
  await expect(page.locator('.report .verdict')).toBeVisible();
  // The check's report is taller than its tab here; a second check brings it back to its top.
  await page.locator('.lab-scroll.is-active').evaluate((el) => el.scrollTo(0, 400));
  await pressCheck(page);
  await expect.poll(() => page.locator('.lab-scroll.is-active').evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator('.lab-scroll.is-active').evaluate((el) => el.scrollTo(0, 400));
  await page.getByRole('tab', { name: /^Solutions/ }).click();
  await page.getByRole('button', { name: 'Give up and see the solution' }).click();
  await expect(page.locator('.solutions')).toBeVisible();
  const moved = await page.evaluate(() => {
    // A script that tries to scroll the page, as scrollIntoView and focus do.
    window.scrollTo(0, 200);
    document.body.scrollTop = 200;
    (document.querySelector('#root') as HTMLElement).scrollTop = 200;
    (document.querySelector('.app') as HTMLElement).scrollTop = 200;
    document.querySelector('.lab-actions')?.scrollIntoView({ block: 'end' });
    const out: string[] = [];
    if (window.scrollY !== 0) out.push(`window ${window.scrollY}`);
    for (const el of document.querySelectorAll<HTMLElement>('*')) if (el.scrollTop !== 0 && !el.closest('.lab-scroll, .xterm')) out.push(`${el.tagName}.${el.className} ${el.scrollTop}`);
    return out;
  });
  expect(moved).toEqual([]);
  const top = await page.locator('.topbar').boundingBox();
  expect(top?.y).toBe(0);
});
