// Phase 12 exit criteria: from an empty data directory a daily session runs end to end on the
// existing content and the next day's queue reflects it; hints, giving up, confidence and the
// rating override change the recorded events; a session of mixed item kinds survives a reload,
// and an unfinished attempt reopens from the server's log; the flows work from the keyboard.
//
// These tests use the second server (playwright.config.ts): its data directory starts empty.

import { expect, test, type Page } from '@playwright/test';
import { FRESH_PORT } from '../playwright.config.ts';
import { advance, pressCheck, run, screen, waitForPrompt } from './workspace.ts';

const BASE = `http://127.0.0.1:${FRESH_PORT}`;
const SHOTS = '../../.tsbuild/playwright/screens';
const DAY = 86_400_000;

type Event = { type: string; attempt?: string; item?: string; [k: string]: unknown };

async function log(page: Page): Promise<Event[]> {
  const text = await (await page.request.get(`${BASE}/api/progress`)).text();
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Event);
}

/** The log once the page's outbox has reached the server. */
async function settledLog(page: Page, atLeast: (events: Event[]) => boolean): Promise<Event[]> {
  await expect.poll(async () => atLeast(await log(page)), { timeout: 15_000 }).toBe(true);
  return log(page);
}

const sessionBar = (page: Page) => page.locator('.session-bar');
const kicker = (page: Page) => page.locator('.lab-kicker > span').first();

test.describe.configure({ mode: 'serial' });

test('a daily session from an empty log; the next day\'s queue reflects what happened', async ({ page }) => {
  const t0 = Date.now();
  await page.clock.setFixedTime(t0);
  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
  await expect(page.locator('.home')).toContainText('0 reviews due · 3 new');
  await page.screenshot({ path: `${SHOTS}/phase12-home-first-run.png` });
  await page.getByRole('button', { name: /Start today's session/ }).click();
  await waitForPrompt(page);

  // 1. The first lab, solved the way its ticket asks, with a confidence and an explanation.
  await expect(sessionBar(page)).toContainText('1/3');
  const ticket = (await page.locator('.ticket').innerText()).replace(/\s+/g, ' ');
  const m = /The (\w+) team needs its service running in the namespace (\w+).*runs (\d) replicas.*on port (\d+)/.exec(ticket);
  expect(m).not.toBeNull();
  const [, app, ns, replicas, port] = m as RegExpExecArray;
  await run(page, `kubectl -n ${ns} create deployment ${app} --image=nginx:1.31.8 --replicas=${replicas} --port=80 --dry-run=client -o yaml > /root/${app}.yaml`);
  await run(page, `echo --- >> /root/${app}.yaml`);
  await run(page, `kubectl -n ${ns} create service clusterip ${app} --tcp=${port}:80 --dry-run=client -o yaml >> /root/${app}.yaml`);
  await run(page, `kubectl apply -f /root/${app}.yaml`);
  await advance(page, 120_000);
  await page.screenshot({ path: `${SHOTS}/phase12-lab-in-progress.png` });
  await pressCheck(page, 4);
  await expect(page.locator('.report .verdict')).toContainText('Solved');
  await expect(page.locator('.report .rating')).toContainText(/Rating\s*(Good|Easy|Hard)/);
  // The debrief waits for the learner's own explanation, then shows figures, checks, both command lists.
  await page.getByRole('button', { name: 'Read the debrief' }).click();
  await expect(page.locator('.debrief')).toHaveCount(0);
  await page.getByLabel('The root cause in your words').fill('Nothing was broken: the objects had to be declared in a file.');
  await page.getByRole('button', { name: 'Show the debrief' }).click();
  await expect(page.locator('.debrief .figure').first()).toBeVisible();
  await expect(page.locator('.debrief .versus-side').first()).toContainText(`kubectl apply -f /root/${app}.yaml`);
  await expect(page.locator('.debrief .versus-side').nth(1)).toContainText('kubectl apply -f');
  await expect(page.locator('.debrief .explained')).toContainText('Nothing was broken');
  await expect(page.locator('.debrief .rating-next')).toContainText(/Next review in \d+ days/);
  // One click overrides the derived rating; Again brings the lab back tomorrow.
  await page.locator('.debrief .rating').getByRole('radio', { name: 'Again' }).click();
  await expect(page.locator('.debrief .rating-next')).toContainText('Next review tomorrow');
  await expect(page.locator('.debrief .rating-why')).toHaveText('set by you');
  await page.locator('.debrief').evaluate((el) => el.closest('.lab-scroll')?.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/phase12-debrief.png` });

  // 2. The second lab: a hint, then giving up for the solution. It ends failed.
  await sessionBar(page).getByRole('button', { name: /^Next/ }).click();
  await waitForPrompt(page);
  await expect(sessionBar(page)).toContainText('2/3');
  await page.locator('.lab-actions').getByRole('button', { name: /^Hint/ }).click();
  await expect(page.locator('.hints li')).toHaveCount(1);
  await page.getByRole('tab', { name: /^Solutions/ }).click();
  await page.getByRole('button', { name: 'Give up and see the solution' }).click();
  await expect(page.locator('.solutions .solution').first()).toBeVisible();
  await expect(page.locator('.lab-kicker')).toContainText('gave up');
  await page.locator('.solutions').getByRole('button', { name: /Next item/ }).click();

  // 3. The third lab is skipped: abandoned, no rating. The session is over.
  await waitForPrompt(page);
  await expect(sessionBar(page)).toContainText('3/3');
  await sessionBar(page).getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();

  const events = await settledLog(page, (es) => es.filter((e) => e.type === 'attempt.finished').length === 3);
  const attemptsInOrder = events.filter((e) => e.type === 'attempt.started');
  expect(attemptsInOrder.map((e) => e.item)).toEqual(['k8s.workloads.deployment-service-01', 'k8s.scheduling.pending-pods-01', 'k8s.troubleshooting.broken-rollout-01']);
  expect(attemptsInOrder.map((e) => e['mode'])).toEqual(['new', 'new', 'new']);
  const of = (n: number): Event[] => events.filter((e) => e.attempt === attemptsInOrder[n]?.attempt);
  expect(of(0).map((e) => e.type)).toEqual(['attempt.started', 'attempt.confidence', 'attempt.check', 'attempt.finished', 'rating', 'attempt.explanation', 'rating']);
  expect(of(0)[1]).toMatchObject({ confidence: 4 });
  expect(of(0)[2]).toMatchObject({ passed: true, score: 1 });
  expect(of(0)[3]).toMatchObject({ outcome: 'passed' });
  expect(of(0)[4]).toMatchObject({ source: 'auto' });
  expect(of(0)[5]).toMatchObject({ text: 'Nothing was broken: the objects had to be declared in a file.' });
  expect(of(0)[6]).toMatchObject({ source: 'manual', rating: 1 });
  expect(of(1).map((e) => e.type)).toEqual(['attempt.started', 'attempt.hint', 'attempt.solution', 'attempt.finished', 'rating']);
  expect(of(1)[1]).toMatchObject({ index: 0 });
  expect(of(1)[3]).toMatchObject({ outcome: 'failed' });
  expect(of(1)[4]).toMatchObject({ source: 'auto', rating: 1, reasons: ['failed'] });
  expect(of(2).map((e) => e.type)).toEqual(['attempt.started', 'attempt.finished']);
  expect(of(2)[1]).toMatchObject({ outcome: 'abandoned' });
  // The first lab's input log is on the server too.
  const stored = await page.request.get(`${BASE}/api/attempts/${attemptsInOrder[0]?.attempt}`);
  expect(stored.ok()).toBe(true);
  expect((await stored.text()).split('\n').length).toBeGreaterThan(50);

  // The next day: both rated labs are due (Again is one day), the skipped one is still new.
  await page.clock.setFixedTime(t0 + DAY);
  await page.reload();
  await expect(page.locator('.home')).toContainText('2 reviews due · 1 new');
  await page.screenshot({ path: `${SHOTS}/phase12-home-next-day.png` });
  // And a day later still, with nothing done in between, nothing has moved.
  await page.clock.setFixedTime(t0 + 2 * DAY);
  await page.reload();
  await expect(page.locator('.home')).toContainText('2 reviews due · 1 new');
});

/** Reads `namespace <ns>` and a replica count out of a ticket, a task or a card's prompt. */
function scaleTarget(text: string): { ns: string; replicas: string } {
  const flat = text.replace(/\s+/g, ' ');
  const ns = /(?:namespace|in) (shop|billing)\b/.exec(flat)?.[1];
  const replicas = /(?:to|run) (\d) replicas/.exec(flat)?.[1];
  if (!ns || !replicas) throw new Error(`no scale target in: ${flat}`);
  return { ns, replicas };
}

async function scale(page: Page, text: string): Promise<void> {
  const { ns, replicas } = scaleTarget(text);
  await page.locator('.terminal-slot.is-active').click();
  await run(page, `kubectl -n ${ns} scale deployment web --replicas=${replicas}`);
  await advance(page, 90_000);
}

test('a session of mixed kinds: lesson, cards, drill; it survives a reload and resumes from the server', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
  // New material from the fixture track: a lesson, a card by choice, a drill, a card by command.
  await page.locator('.home .select-trigger').first().click();
  await page.getByRole('option', { name: /Scaling/ }).click();
  await expect(page.locator('.home')).toContainText('A replica count is a wish');
  await page.getByRole('button', { name: /Start today's session/ }).click();

  const seen: string[] = [];
  let reloaded = false;
  for (let guard = 0; guard < 8; guard++) {
    await expect(page.locator('.lab-kicker').or(page.getByRole('heading', { name: "Today's session" })).first()).toBeVisible({ timeout: 60_000 });
    if (await page.getByRole('heading', { name: "Today's session" }).isVisible()) break;
    const kind = ((await kicker(page).textContent()) ?? '').toLowerCase();
    if (kind === 'lesson') {
      seen.push('lesson');
      await waitForPrompt(page);
      // Page 1 ends at a prediction: answer, lock in, see what happens. The next page was locked until then.
      await page.getByRole('tab', { name: /^Step 2/ }).click();
      await expect(page.locator('.lesson-panel')).toContainText('This step opens when the one before it is done.');
      await page.getByRole('tab', { name: /^Step 1/ }).click();
      await page.getByRole('radio', { name: /The ReplicaSet the Deployment owns/ }).click();
      await page.getByRole('button', { name: 'Lock in my answer' }).click();
      await expect(page.locator('.predict-verdict')).toHaveText('✓ Right.');
      await page.locator('.lab-actions').getByRole('button', { name: /Continue/ }).click();
      // Page 2 is a guided task: it advances when its check passes.
      await page.locator('.lab-actions').getByRole('button', { name: /^Hint/ }).click();
      await expect(page.locator('.task .hints li')).toHaveCount(1);
      await page.locator('.lab-actions').getByRole('button', { name: /^Check/ }).click();
      await expect(page.locator('.task .report .verdict')).toContainText('Not there yet');
      await scale(page, await page.locator('.task').innerText());
      await page.locator('.lab-actions').getByRole('button', { name: /^Check/ }).click();
      // Page 3: a prediction in free text.
      await page.getByLabel('Your prediction').fill('a new Pod replaces it');
      await page.getByRole('button', { name: 'Lock in my answer' }).click();
      await expect(page.locator('.predict-reveal')).toContainText('creates a replacement at once');
      await page.locator('.lab-actions').getByRole('button', { name: /Continue/ }).click();
      await expect(page.locator('.lesson-done')).toContainText('Lesson complete');
      await page.screenshot({ path: `${SHOTS}/phase12-lesson.png` });
    } else if (kind === 'card' && (await page.locator('.card-page').count()) > 0) {
      seen.push('card by choice');
      await page.keyboard.press('2');
      await page.getByRole('button', { name: 'Answer' }).click();
      await expect(page.locator('.card-answer')).toContainText('The ReplicaSet controller.');
      await expect(page.locator('.card .rating')).toContainText('Good');
      await page.screenshot({ path: `${SHOTS}/phase12-card.png` });
    } else if (kind === 'card') {
      seen.push('card by command');
      await waitForPrompt(page);
      await scale(page, await page.locator('.card-prompt').innerText());
      await page.locator('.card-actions').getByRole('button', { name: /^Check/ }).click();
      await expect(page.locator('.card-answer')).toContainText('kubectl -n');
    } else {
      seen.push(kind);
      await waitForPrompt(page);
      if (!reloaded) {
        // Mid-attempt: a command typed, then this browser's copy of the attempt is thrown away.
        // The reload reopens the attempt by replay from the server's log, and the session goes on.
        reloaded = true;
        await run(page, 'echo before the reload');
        await page.waitForTimeout(3_000);
        await page.evaluate(() => {
          for (const k of Object.keys(localStorage)) if (k.startsWith('simlab.attempt.')) localStorage.removeItem(k);
          localStorage.removeItem('simlab.active.v1');
        });
        await page.reload();
        await waitForPrompt(page);
        expect(await screen(page)).toContain('before the reload');
        await expect(sessionBar(page)).toBeVisible();
      }
      await scale(page, await page.locator('.ticket').innerText());
      await pressCheck(page);
      await expect(page.locator('.report .verdict')).toContainText('Solved');
    }
    await sessionBar(page).getByRole('button', { name: /^Next/ }).click();
  }
  expect([...seen].sort()).toEqual(['card by choice', 'card by command', 'drill', 'lesson']);
  // The lesson comes first; what it opens follows.
  expect(seen[0]).toBe('lesson');
  await expect(page.locator('.home')).toContainText(/done for today/i);

  const events = await settledLog(page, (es) => es.filter((e) => e.type === 'card.reviewed').length === 2);
  const lesson = events.find((e) => e.type === 'attempt.started' && e.item === 'fx.workloads.scaling-lesson-01');
  const ofLesson = events.filter((e) => e.attempt === lesson?.attempt);
  expect(ofLesson.map((e) => e.type)).toEqual(['attempt.started', 'attempt.prediction', 'attempt.hint', 'attempt.check', 'attempt.check', 'attempt.prediction', 'attempt.finished']);
  expect(ofLesson[1]).toMatchObject({ step: 2, choice: 1, correct: true });
  expect(ofLesson[2]).toMatchObject({ step: 3, index: 0 });
  expect(ofLesson[3]).toMatchObject({ step: 3, passed: false });
  expect(ofLesson[4]).toMatchObject({ step: 3, passed: true });
  expect(ofLesson[5]).toMatchObject({ step: 4, text: 'a new Pod replaces it' });
  // A lesson is done once: finished, never rated.
  expect(ofLesson[6]).toMatchObject({ outcome: 'passed' });
  const cards = events.filter((e) => e.type === 'card.reviewed');
  expect(cards.map((e) => e.item).sort()).toEqual(['fx.workloads.owner-card-01', 'fx.workloads.scale-card-01']);
  expect(cards.find((e) => e.item === 'fx.workloads.owner-card-01')).toMatchObject({ outcome: 'passed', choice: 1 });
  const drill = events.find((e) => e.type === 'attempt.started' && e.item === 'fx.workloads.scale-drill-01');
  expect(events.filter((e) => e.attempt === drill?.attempt).map((e) => e.type)).toEqual(['attempt.started', 'attempt.check', 'attempt.finished', 'rating']);
});

test('by keyboard alone: start the session, check with a confidence, skip, go home', async ({ page }) => {
  await page.clock.setFixedTime(Date.now() + 3 * DAY);
  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
  // Tab reaches the session's button; Enter starts it.
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    await page.keyboard.press('Tab');
    found = await page.evaluate(() => /session/i.test(document.activeElement?.textContent ?? '') && document.activeElement?.tagName === 'BUTTON');
  }
  expect(found).toBe(true);
  await page.keyboard.press('Enter');
  await waitForPrompt(page);
  await expect(sessionBar(page)).toBeVisible();
  // The check's chord opens the confidence prompt with the keyboard in it; a digit answers and checks.
  await page.keyboard.press('Control+Shift+Enter');
  await expect(page.locator('.confidence')).toBeFocused();
  await page.keyboard.press('2');
  await expect(page.locator('.report .verdict')).toBeVisible();
  await expect(page.locator('.confidence')).toHaveCount(0);
  // Escape cancels the prompt without checking, and the keys go to the shell again.
  await page.keyboard.press('Control+Shift+Enter');
  await expect(page.locator('.confidence')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.confidence')).toHaveCount(0);
  await page.keyboard.type('echo keys reach the shell');
  await page.evaluate(() => window.__simlab.enter());
  expect(await screen(page)).toContain('keys reach the shell');
  // Skip with its chord: the next item opens. Home with its chord.
  const first = await page.locator('.lab-id').textContent();
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('.lab-id')).not.toHaveText(first ?? '', { timeout: 60_000 });
  await waitForPrompt(page);
  await page.keyboard.press('Control+Shift+D');
  await expect(page.getByRole('heading', { name: "Today's session" })).toBeVisible();
  // The unfinished item waits on the home screen.
  await expect(page.locator('.home')).toContainText('Unfinished');
});
