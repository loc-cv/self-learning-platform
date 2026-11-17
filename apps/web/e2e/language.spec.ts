// Phase 12 exit criterion: the language of prose is English, Vietnamese or both side by side;
// side by side every text unit is one row with its two texts aligned; a unit with no current
// Vietnamese shows its English with a badge; the setting is remembered; the terminal stays as
// the real tools print. The fixture lesson's sidecar holds every state on purpose.

import { expect, test, type Page } from '@playwright/test';
import { openLab, run } from './workspace.ts';

const lang = (page: Page, name: string) => page.getByRole('radiogroup', { name: 'Language of prose' }).getByRole('radio', { name, exact: true });
const title = (page: Page) => page.locator('.lab-title');
const VI_TITLE = 'Số replica là một mong muốn mà Deployment luôn đáp ứng';
const EN_TITLE = 'A replica count is a wish the Deployment keeps granting';

test('EN, VI and side by side on an item whose sidecar has current, outdated and missing units', async ({ page }) => {
  await openLab(page, 'fx.workloads.scaling-lesson-01', 1);
  // English: no Vietnamese, no badge.
  await expect(lang(page, 'EN')).toHaveAttribute('aria-checked', 'true');
  await expect(title(page)).toHaveText(EN_TITLE);
  await expect(page.locator('.lab-panel .lang-badge')).toHaveCount(0);

  // Vietnamese: a current unit is Vietnamese; an outdated and a missing one stay English, each with its badge.
  await lang(page, 'VI').click();
  await expect(title(page)).toHaveText(VI_TITLE);
  await expect(page.locator('.lab-kicker .lang-badge')).toHaveText('VI partial');
  const first = page.locator('.lesson-page > .lang-fallback').first();
  await expect(first).toContainText('A Deployment does not run Pods itself.');
  await expect(first.locator('.lang-badge')).toHaveText('VI outdated');
  const prompt = page.locator('.predict > .markdown').first();
  await expect(prompt).toContainText('Đối tượng nào tạo ra các Pod mới?');
  await expect(prompt).toHaveAttribute('lang', 'vi');
  // The choices have no translation: English, each with the badge for a missing one.
  await expect(page.locator('.choice .lang-badge')).toHaveText(['EN only', 'EN only', 'EN only']);
  // Code and the seed's values are the same in both languages.
  await expect(prompt.locator('code')).toHaveText('replicas');

  // Side by side: one row per unit, English left, Vietnamese right, tops aligned.
  await lang(page, 'EN·VI').click();
  const row = page.locator('.predict > .bi').first();
  await expect(row.locator('.bi-en')).toContainText('Which object creates the new Pods?');
  await expect(row.locator('.bi-vi')).toContainText('Đối tượng nào tạo ra các Pod mới?');
  const [en, vi] = [await row.locator('.bi-en').boundingBox(), await row.locator('.bi-vi').boundingBox()];
  expect(en && vi && Math.abs(en.y - vi.y) < 1 && vi.x > en.x + en.width - 1).toBe(true);
  // Every unit of the page is such a row: the Vietnamese side holds the text or the reason it is absent.
  const outdated = page.locator('.lesson-page > .bi').first();
  await expect(outdated.locator('.bi-en')).toContainText('A Deployment does not run Pods itself.');
  await expect(outdated.locator('.bi-vi .lang-badge')).toHaveText('VI outdated');
  await expect(outdated.locator('.bi-vi')).not.toContainText('Deployment không tự chạy Pod');
  await expect(page.locator('.choice .bi-vi .lang-badge')).toHaveText(['EN only', 'EN only', 'EN only']);
  await expect(title(page).locator('.bi-en')).toHaveText(EN_TITLE);
  await expect(title(page).locator('.bi-vi')).toHaveText(VI_TITLE);
  // The figure is drawn once; its caption has no Vietnamese and says so.
  await expect(page.locator('.lesson-page .figure')).toHaveCount(1);
  await expect(page.locator('.lesson-page .figure .lang-badge')).toHaveText('EN only');
  await page.screenshot({ path: '../../.tsbuild/playwright/screens/phase12-side-by-side.png' });

  // The terminal is not translated, and the setting is remembered across a reload.
  expect(await run(page, 'kubectl get namespace default')).toMatch(/NAME\s+STATUS\s+AGE/);
  await page.reload();
  await expect(lang(page, 'EN·VI')).toHaveAttribute('aria-checked', 'true');
  await expect(title(page).locator('.bi-vi')).toHaveText(VI_TITLE);
});

test('an item with no sidecar says so once, not on every paragraph; the browser lists titles in the chosen language', async ({ page }) => {
  await openLab(page, 'k8s.scheduling.pending-pods-01', 1);
  await lang(page, 'VI').click();
  await expect(page.locator('.lab-kicker .lang-badge')).toHaveText('English only');
  await expect(page.locator('.ticket .lang-badge')).toHaveCount(0);
  await expect(page.locator('.ticket .bi')).toHaveCount(0);
  // The browser lists titles in the chosen language, with a mark where there is none.
  await page.getByRole('button', { name: /^Browse/ }).click();
  await expect(page.locator('.browser-list')).toContainText(VI_TITLE);
  await page.keyboard.press('Escape');
});
