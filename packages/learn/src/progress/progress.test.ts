// The parts of the learning core one at a time (docs/LEARNING_MODEL.md §5 to §9): events, the
// automatic rating, the reducer, seeds, the queue.

import { describe, expect, test } from 'vitest';
import { buildCatalog, catalogProblems, parsePackManifest, type Catalog, type PackContent } from '../pack.ts';
import type { AnyItem } from '../item/types.ts';
import { resolveParams } from '../item/variant.ts';
import { counterItem } from '../testing.ts';
import { DAY_MS, dayIndex } from './day.ts';
import { AGAIN, DEFAULT_SETTINGS, EASY, eventProblem, GOOD, HARD, parseLog, PROGRESS_VERSION, type ProgressEvent, type Rating } from './events.ts';
import { retrievability } from './fsrs.ts';
import { availableNew, buildQueue, dueReviews } from './queue.ts';
import { autoRating, type Performance } from './rating.ts';
import { cardReview, finishAttempt } from './record.ts';
import { applyEvent, initialState, replay, schedule, type ProgressState } from './reducer.ts';
import { attemptSeed, reviewSeed } from './seeds.ts';
import { demoCatalog } from './simulate.ts';
import { itemStatus, recentMistakes } from './stats.ts';

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const ev = <E extends Omit<ProgressEvent, 'v'>>(e: E): ProgressEvent => ({ v: PROGRESS_VERSION, ...e }) as unknown as ProgressEvent;
const apply = (state: ProgressState, events: readonly ProgressEvent[]): ProgressState => events.reduce(applyEvent, state);

describe('events', () => {
  test('an event of this version with the fields of its type is accepted', () => {
    expect(eventProblem(ev({ type: 'attempt.started', at: T0, attempt: 'a1', item: 'x.y', seed: 4, mode: 'new' }))).toBeUndefined();
    expect(eventProblem(ev({ type: 'settings.changed', at: T0, settings: { retention: 0.85 } }))).toBeUndefined();
  });

  test('anything else is refused with the reason', () => {
    expect(eventProblem('x')).toBe('an event is a JSON object');
    expect(eventProblem({ type: 'rating', at: 1 })).toBe('v must be an integer (the schema version)');
    expect(eventProblem({ v: 2, type: 'rating', at: 1 })).toBe('v is 2; this version reads up to 1');
    expect(eventProblem({ v: 1, type: 'attempt.cheered', at: 1 })).toBe('unknown event type "attempt.cheered"');
    expect(eventProblem({ v: 1, type: 'rating', at: 1, attempt: 'a', item: 'i', rating: 5, source: 'auto' })).toMatch(/^rating: .*rating/);
    expect(eventProblem({ v: 1, type: 'attempt.hint', at: 1, attempt: 'a', index: 0, colour: 'x' })).toMatch(/colour/);
    expect(eventProblem({ v: 1, type: 'settings.changed', at: 1, settings: { retention: 0.5 } })).toMatch(/retention/);
    expect(eventProblem({ v: 1, type: 'attempt.hint', at: 1, attempt: 'a' })).toBe('attempt.hint: the event needs index');
  });

  test('a log is one event per line; a bad line stops the read with its number', () => {
    const line = JSON.stringify(ev({ type: 'attempt.xray', at: T0, attempt: 'a', open: true }));
    expect(parseLog(`${line}\n\n${line}\n`).length).toBe(2);
    expect(() => parseLog(`${line}\n{"v":1}\n`)).toThrow('progress log line 2: unknown event type undefined');
    expect(() => parseLog(`${line}\n{"v":1,"type"`)).toThrow('progress log line 2: not JSON');
    expect(() => replay([{ v: 3 } as unknown as ProgressEvent])).toThrow('event 1: v is 3; this version reads up to 1');
  });
});

describe('the automatic rating', () => {
  const clean: Performance = { passed: true, activeMs: 5 * 60_000, targetMinutes: 6, hintsUsed: 0, hintCount: 3, xrayOpened: false, solutionViewed: false, failedChecks: 0 };
  const cases: [string, Partial<Performance>, Rating, string[]][] = [
    ['passed inside the target', {}, GOOD, ['clean']],
    ['passed fast, first check, unaided', { activeMs: 3 * 60_000 }, EASY, ['fast']],
    ['fast but with a failed check first', { activeMs: 3 * 60_000, failedChecks: 1 }, GOOD, ['clean']],
    ['a hint', { hintsUsed: 1 }, HARD, ['hints']],
    ['the X-ray', { xrayOpened: true, activeMs: 60_000 }, HARD, ['xray']],
    ['slow', { activeMs: 10 * 60_000 }, HARD, ['slow']],
    ['two failed checks', { failedChecks: 2 }, HARD, ['failed-checks']],
    ['a hint and slow', { hintsUsed: 2, activeMs: 20 * 60_000 }, HARD, ['hints', 'slow']],
    ['the whole ladder', { hintsUsed: 3 }, AGAIN, ['all-hints']],
    ["a drill's only hint", { hintsUsed: 1, hintCount: 1 }, HARD, ['hints']],
    ['the solution viewed', { solutionViewed: true }, AGAIN, ['solution-viewed']],
    ['not passed', { passed: false, activeMs: 60_000 }, AGAIN, ['failed']],
  ];
  test.each(cases)('%s', (_name, change, rating, reasons) => {
    expect(autoRating({ ...clean, ...change })).toEqual({ rating, reasons });
  });
});

/** One attempt of `item` from start to rating, `minutes` long, starting at `at`. */
function attempt(state: ProgressState, catalog: Catalog, item: string, id: string, at: number, opts: { passed?: boolean; hints?: number; minutes?: number } = {}): ProgressEvent[] {
  const meta = catalog.items[item];
  if (!meta) throw new Error(`no item ${item}`);
  const ms = (opts.minutes ?? meta.targetMinutes * 0.9) * 60_000;
  const events: ProgressEvent[] = [ev({ type: 'attempt.started', at, attempt: id, item, seed: 1, mode: 'free' })];
  for (let h = 0; h < (opts.hints ?? 0); h++) events.push(ev({ type: 'attempt.hint', at: at + 1000, attempt: id, index: h }));
  events.push(ev({ type: 'attempt.check', at: at + ms, attempt: id, passed: opts.passed ?? true, score: opts.passed === false ? 0 : 1, checks: [] }));
  const open = apply(state, events);
  return [...events, ...finishAttempt(open, meta, { attempt: id, at: at + ms, outcome: opts.passed === false ? 'failed' : 'passed', activeMs: ms, hintCount: 3 })];
}

describe('the reducer', () => {
  const catalog = demoCatalog();
  const lab = 'demo.basics.lab-01';

  test('an attempt becomes item progress, a day and a schedule', () => {
    const s = apply(initialState(), attempt(initialState(), catalog, lab, 'a1', T0));
    expect(s.open).toEqual({});
    expect(s.items[lab]).toMatchObject({ attempts: 1, passes: 1, firstPassedAt: T0 + 7.2 * 60_000, reviews: 1, lapses: 0, mistakes: { failures: 0, failedChecks: 0, hints: 0, solutions: 0 } });
    expect(s.items[lab]?.schedule).toMatchObject({ rating: GOOD, reviewedAt: T0 + 7.2 * 60_000 });
    expect(s.items[lab]?.schedule?.intervalDays).toBeGreaterThan(2);
    expect(s.days[String(dayIndex(T0, DEFAULT_SETTINGS))]).toEqual({ attempts: 1, passes: 1, activeMs: 7.2 * 60_000 });
    expect(s.lastFinished).toEqual({ item: lab, at: T0 + 7.2 * 60_000 });
    expect(s.events).toBe(4);
  });

  test('an item is new, then learning, due when its day comes, and mastered once its interval is long', () => {
    const status = (s: ProgressState, id: string, now: number) => itemStatus(s.items[id], s.settings, now);
    expect(status(initialState(), lab, T0)).toBe('new');
    let s = apply(initialState(), attempt(initialState(), catalog, lab, 'a1', T0));
    expect(status(s, lab, T0 + DAY_MS)).toBe('learning');
    const due = s.items[lab]?.schedule?.dueAt as number;
    expect(status(s, lab, due)).toBe('due');
    s = apply(s, attempt(s, catalog, lab, 'a2', due));
    expect(s.items[lab]?.schedule?.intervalDays).toBeGreaterThan(21);
    expect(status(s, lab, due + DAY_MS)).toBe('mastered');
    const lesson = 'demo.basics.lesson-01';
    expect(status(apply(s, attempt(s, catalog, lesson, 'l1', T0)), lesson, T0 + 99 * DAY_MS)).toBe('mastered');
  });

  test('the argument is not changed', () => {
    const before = initialState();
    const frozen = JSON.stringify(before);
    apply(before, attempt(before, catalog, lab, 'a1', T0));
    expect(JSON.stringify(before)).toBe(frozen);
  });

  test('a manual rating replaces the automatic one: same starting point, counted once', () => {
    const first = apply(initialState(), attempt(initialState(), catalog, lab, 'a1', T0));
    const second = apply(first, attempt(first, catalog, lab, 'a2', T0 + 5 * DAY_MS, { hints: 1 }));
    expect(second.items[lab]?.schedule?.rating).toBe(HARD);
    const override = ev({ type: 'rating', at: T0 + 5 * DAY_MS + 3_600_000, attempt: 'a2', item: lab, rating: EASY, source: 'manual' });
    const overridden = applyEvent(second, override);
    // As if the second attempt had been rated Easy in the first place, at the time it ended.
    const direct = schedule(first.items[lab]?.schedule, EASY, second.items[lab]?.last?.at as number, 0.9);
    expect(overridden.items[lab]?.schedule).toEqual(direct);
    expect(overridden.items[lab]?.reviews).toBe(2);
    expect(overridden.items[lab]?.schedule?.intervalDays).toBeGreaterThan(second.items[lab]?.schedule?.intervalDays as number);
    // And again: an override of the override.
    const twice = applyEvent(overridden, { ...override, rating: AGAIN } as ProgressEvent);
    expect(twice.items[lab]?.schedule).toEqual(schedule(first.items[lab]?.schedule, AGAIN, second.items[lab]?.last?.at as number, 0.9));
    expect(twice.items[lab]).toMatchObject({ reviews: 2, lapses: 1 });
    expect(applyEvent(twice, { ...override, rating: GOOD } as ProgressEvent).items[lab]?.lapses).toBe(0);
  });

  test('a rating for an attempt that is not the last one changes nothing', () => {
    const first = apply(initialState(), attempt(initialState(), catalog, lab, 'a1', T0));
    const second = apply(first, attempt(first, catalog, lab, 'a2', T0 + 5 * DAY_MS));
    const stale = applyEvent(second, ev({ type: 'rating', at: T0 + 6 * DAY_MS, attempt: 'a1', item: lab, rating: AGAIN, source: 'manual' }));
    expect(stale.items).toEqual(second.items);
    expect(applyEvent(second, ev({ type: 'rating', at: T0, attempt: 'zz', item: 'demo.nothing', rating: GOOD, source: 'manual' })).items).toEqual(second.items);
  });

  test('a failure is a lapse, a mistake and a short interval; an abandoned attempt changes no schedule', () => {
    const first = apply(initialState(), attempt(initialState(), catalog, lab, 'a1', T0));
    const failed = apply(first, attempt(first, catalog, lab, 'a2', T0 + 5 * DAY_MS, { passed: false }));
    expect(failed.items[lab]).toMatchObject({ attempts: 2, passes: 1, lapses: 1, mistakes: { failures: 1, failedChecks: 1 } });
    expect(failed.items[lab]?.schedule).toMatchObject({ rating: AGAIN, intervalDays: 1 });
    expect(recentMistakes(failed.items[lab], dayIndex(T0 + 5 * DAY_MS, DEFAULT_SETTINGS))).toBe(2);
    expect(recentMistakes(failed.items[lab], dayIndex(T0 + 13 * DAY_MS, DEFAULT_SETTINGS))).toBe(0);
    const at = T0 + 9 * DAY_MS;
    const started = applyEvent(failed, ev({ type: 'attempt.started', at, attempt: 'a3', item: lab, seed: 2, mode: 'review' }));
    const events = finishAttempt(started, catalog.items[lab] as never, { attempt: 'a3', at: at + 60_000, outcome: 'abandoned', hintCount: 3 });
    expect(events.map((e) => e.type)).toEqual(['attempt.finished']);
    const abandoned = apply(started, events);
    expect(abandoned.items[lab]?.schedule).toEqual(failed.items[lab]?.schedule);
    expect(abandoned.items[lab]).toMatchObject({ attempts: 3, passes: 1 });
  });

  test('help after the pass is study: the X-ray and the solution then cost nothing', () => {
    const start = ev({ type: 'attempt.started', at: T0, attempt: 'a1', item: lab, seed: 1, mode: 'new' });
    const pass = ev({ type: 'attempt.check', at: T0 + 1000, attempt: 'a1', passed: true, score: 1, checks: [] });
    const xray = ev({ type: 'attempt.xray', at: T0 + 500, attempt: 'a1', open: true });
    const solution = ev({ type: 'attempt.solution', at: T0 + 500, attempt: 'a1' });
    expect(apply(initialState(), [start, pass, xray, solution]).open['a1']).toMatchObject({ xray: false, solution: false });
    const helped = apply(initialState(), [start, xray, solution, solution, pass]);
    expect(helped.open['a1']).toMatchObject({ xray: true, solution: true });
    expect(helped.items[lab]?.mistakes.solutions).toBe(1);
    expect(finishAttempt(helped, catalog.items[lab] as never, { attempt: 'a1', at: T0 + 2000, outcome: 'passed', hintCount: 3 })[1]).toMatchObject({ type: 'rating', rating: AGAIN, reasons: ['solution-viewed'] });
  });

  test('predictions, confidence and the self-explanation are kept with the attempt', () => {
    const s = apply(initialState(), [
      ev({ type: 'attempt.started', at: T0, attempt: 'a1', item: lab, seed: 1, mode: 'new' }),
      ev({ type: 'attempt.prediction', at: T0, attempt: 'a1', step: 2, choice: 1, correct: true }),
      ev({ type: 'attempt.prediction', at: T0, attempt: 'a1', step: 4, text: 'it restarts' }),
      ev({ type: 'attempt.confidence', at: T0, attempt: 'a1', confidence: 4 }),
      ev({ type: 'attempt.explanation', at: T0, attempt: 'a1', text: 'The taint kept the Pods off the node.' }),
    ]);
    expect(s.open['a1']).toMatchObject({ predictions: 2, correctPredictions: 1, confidence: 4, explained: true });
    const done = applyEvent(s, ev({ type: 'attempt.finished', at: T0 + 1000, attempt: 'a1', outcome: 'passed', activeMs: 1000 }));
    expect(done.items[lab]?.last?.confidence).toBe(4);
  });

  test('events for an attempt that is not open change nothing but the count', () => {
    const s = apply(initialState(), [ev({ type: 'attempt.hint', at: T0, attempt: 'ghost', index: 0 }), ev({ type: 'attempt.finished', at: T0, attempt: 'ghost', outcome: 'passed', activeMs: 1 })]);
    expect(s).toEqual({ ...initialState(), events: 2 });
  });

  test('a lesson is done once and never scheduled; a card review is one event and a rating', () => {
    const lesson = 'demo.basics.lesson-01';
    const done = apply(initialState(), attempt(initialState(), catalog, lesson, 'a1', T0));
    expect(done.items[lesson]).toMatchObject({ attempts: 1, passes: 1 });
    expect(done.items[lesson]?.schedule).toBeUndefined();
    const card = 'demo.basics.card-01';
    const right = apply(done, cardReview({ attempt: 'c1', item: card, seed: 3, at: T0, activeMs: 20_000, correct: true, choice: 1 }));
    expect(right.items[card]).toMatchObject({ attempts: 1, passes: 1, last: { seed: 3 }, schedule: { rating: GOOD } });
    const wrong = apply(right, cardReview({ attempt: 'c2', item: card, seed: 4, at: T0 + 6 * DAY_MS, activeMs: 20_000, correct: false }));
    expect(wrong.items[card]).toMatchObject({ attempts: 2, passes: 1, lapses: 1, mistakes: { failures: 1 }, schedule: { rating: AGAIN } });
    expect(cardReview({ attempt: 'c3', item: card, seed: 5, at: T0, activeMs: 1, rating: HARD })).toMatchObject([{ outcome: 'passed' }, { rating: HARD, source: 'manual' }]);
    expect(() => cardReview({ attempt: 'c3', item: card, seed: 5, at: T0, activeMs: 1 })).toThrow('a card review needs `correct` or `rating`');
  });

  test('the target retention in force at the review decides the interval', () => {
    const at95 = schedule(undefined, GOOD, T0, 0.95);
    const at85 = schedule(undefined, GOOD, T0, 0.85);
    expect(at95.intervalDays).toBeLessThan(at85.intervalDays);
    expect(at95.memory.stability).toBe(at85.memory.stability);
    // Changing the setting is an event: reviews before it keep what they were given.
    const first = apply(initialState(), attempt(initialState(), catalog, lab, 'a1', T0));
    const changed = applyEvent(first, ev({ type: 'settings.changed', at: T0 + DAY_MS, settings: { retention: 0.8 } }));
    expect(changed.items[lab]?.schedule).toEqual(first.items[lab]?.schedule);
    const later = apply(changed, attempt(changed, catalog, lab, 'a2', T0 + 5 * DAY_MS));
    const same = apply(first, attempt(first, catalog, lab, 'a2', T0 + 5 * DAY_MS));
    expect(later.items[lab]?.schedule?.intervalDays).toBeGreaterThan(same.items[lab]?.schedule?.intervalDays as number);
  });

  test('recall is the target retention when the interval has passed, and falls with time', () => {
    const s = schedule(undefined, GOOD, T0, 0.9);
    expect(retrievability(s.memory, s.memory.scheduledDays)).toBeCloseTo(0.9, 3);
    expect(retrievability(s.memory, 0)).toBeCloseTo(1, 4);
    expect(retrievability(s.memory, 60)).toBeLessThan(0.8);
  });
});

describe('the learner\'s day', () => {
  test('starts at the day start hour of local time', () => {
    const hanoi = { utcOffsetMinutes: 420, dayStartHour: 4 };
    const at = (h: number, m = 0): number => Date.UTC(2026, 10, 17, h, m);
    // 03:59 in Hanoi is 20:59 UTC the day before: still yesterday's session.
    expect(dayIndex(at(21, 0), hanoi) - dayIndex(at(20, 59), hanoi)).toBe(1);
    expect(dayIndex(at(20, 59), hanoi)).toBe(dayIndex(at(0, 0), hanoi));
    expect(dayIndex(at(21, 0), { utcOffsetMinutes: 0, dayStartHour: 4 })).toBe(dayIndex(at(4, 0), { utcOffsetMinutes: 0, dayStartHour: 4 }));
  });
});

describe('seeds', () => {
  test('a function of the item and the attempt count; a review avoids the last variant', () => {
    expect(attemptSeed('x.y', 3)).toBe(attemptSeed('x.y', 3));
    expect(new Set([0, 1, 2, 3, 4, 5].map((n) => attemptSeed('x.y', n))).size).toBe(6);
    expect(attemptSeed('x.y', 0)).not.toBe(attemptSeed('x.z', 0));
    const item = counterItem();
    let last: number | undefined;
    for (let n = 0; n < 40; n++) {
      const seed = reviewSeed(item, n, last);
      if (last !== undefined) expect(resolveParams(item, seed)).not.toEqual(resolveParams(item, last));
      expect(reviewSeed(item, n, last)).toBe(seed);
      last = seed;
    }
    const fixed = { ...counterItem(), world: { topology: 'counter-1', setup: [] } } as unknown as AnyItem;
    expect(reviewSeed(fixed as never, 2, 77)).toBe(attemptSeed(fixed.id, 2));
  });
});

describe('the daily queue', () => {
  const skill = (id: string, requires?: string[]) => ({ id: `q.${id}`, title: id, ...(requires ? { requires: requires.map((r) => `q.${r}`) } : {}) });
  const item = (name: string, kind: string, skills: string[], minutes: number): AnyItem => ({ id: `q.${name}`, kind, title: name, skills: skills.map((s) => `q.${s}`), curriculum: ['q.d.c'], difficulty: 1, targetMinutes: minutes }) as unknown as AnyItem;
  const pack: PackContent = {
    pack: { id: 'q', title: 'Queue', skills: [skill('a'), skill('b', ['a']), skill('c')], tracks: [{ id: 'q.track', title: 'T', items: ['q.a-lesson', 'q.a-drill', 'q.a-lab', 'q.b-drill', 'q.c-drill', 'q.c-lab'] }] },
    items: [item('a-lesson', 'lesson', ['a'], 5), item('a-drill', 'drill', ['a'], 2), item('a-lab', 'lab', ['a'], 8), item('b-drill', 'drill', ['b'], 2), item('c-drill', 'drill', ['c'], 2), item('c-lab', 'lab', ['c'], 30), item('free-card', 'card', ['c'], 0.5)],
  };
  const catalog = buildCatalog([pack]);
  const withTrack = (minutes = 30): ProgressState => applyEvent(initialState(), ev({ type: 'settings.changed', at: T0, settings: { activeTrack: 'q.track', dailyMinutes: minutes } }));
  const ids = (state: ProgressState, now: number): string[] => buildQueue(state, catalog, now).entries.map((e) => `${e.item}${e.repeatsSkill ? '*' : ''}`);

  test('the pack is valid', () => {
    expect(catalogProblems([pack])).toEqual([]);
  });

  test('no active track: reviews only', () => {
    expect(buildQueue(initialState(), catalog, T0).entries).toEqual([]);
  });

  test('new items in track order, prerequisites met, interleaved, inside the box', () => {
    // b needs a, which nothing has passed yet; c-lab (30 minutes) does not fit after the rest.
    expect(ids(withTrack(), T0)).toEqual(['q.a-lesson', 'q.c-drill', 'q.a-drill', 'q.a-lab*']);
    const q = buildQueue(withTrack(), catalog, T0);
    expect(q).toMatchObject({ minutes: 17, minutesLeft: 30, waiting: { reviews: 0, fresh: 1 } });
    expect(q.entries.every((e) => e.reason === 'new' && e.seed > 0)).toBe(true);
    // New items stop at the first that does not fit: the track is not skipped ahead.
    expect(ids(withTrack(6), T0)).toEqual(['q.a-lesson']);
    expect(ids(withTrack(7), T0)).toEqual(['q.a-lesson', 'q.a-drill*']);
  });

  test('the first item of a day is offered even when it alone is longer than the box', () => {
    expect(ids(withTrack(3), T0)).toEqual(['q.a-lesson']);
    const s = withTrack(3);
    const spent = apply(s, attempt(s, catalog, 'q.a-lesson', 'a1', T0, { minutes: 4 }));
    expect(buildQueue(spent, catalog, T0 + 5 * 60_000)).toMatchObject({ minutesLeft: 0, entries: [], waiting: { fresh: 5 } });
  });

  test('passing an item opens what it is a prerequisite of, and the queue follows what was just done', () => {
    const s = withTrack();
    const done = apply(s, attempt(s, catalog, 'q.a-lesson', 'a1', T0, { minutes: 5 }));
    // The lesson (skill a) was the last thing done: the next is not on a while another is there.
    expect(ids(done, T0 + 5 * 60_000)).toEqual(['q.b-drill', 'q.a-drill', 'q.c-drill', 'q.a-lab']);
    expect(availableNew(done, catalog).map((c) => c.item)).toEqual(['q.a-drill', 'q.a-lab', 'q.b-drill', 'q.c-drill', 'q.c-lab']);
    // The next day nothing was just done.
    expect(ids(done, T0 + DAY_MS)[0]).toBe('q.a-drill');
  });

  test('due reviews come first, most forgotten first; reviews on skills with recent mistakes before those', () => {
    let s = withTrack(60);
    for (const [i, id] of ['q.a-lesson', 'q.a-drill', 'q.c-drill', 'q.a-lab', 'q.b-drill'].entries()) s = apply(s, attempt(s, catalog, id, `a${i}`, T0 + i * 60_000, { minutes: 1 }));
    // Nothing is due the next day: only what is new.
    expect(ids(s, T0 + DAY_MS)).toEqual(['q.c-lab']);
    // Every attempt was fast and clean (Easy), so the first intervals are weeks long.
    const later = T0 + 100 * DAY_MS;
    const due = dueReviews(s, catalog, later);
    expect(due.map((d) => d.item).sort()).toEqual(['q.a-drill', 'q.a-lab', 'q.b-drill', 'q.c-drill']);
    expect(due.every((d) => (d.overdueDays ?? 0) > 20 && (d.recall ?? 1) < 0.9)).toBe(true);
    const q = buildQueue(s, catalog, later);
    expect(q.entries.slice(0, 4).every((e) => e.reason === 'review')).toBe(true);
    expect(q.entries[q.entries.length - 1]).toMatchObject({ item: 'q.c-lab', reason: 'new' });
    // A failed attempt on c today: c's reviews move to the front.
    const failed = apply(s, attempt(s, catalog, 'q.free-card', 'f1', later - DAY_MS, { passed: false, minutes: 0.1 }));
    const after = buildQueue(failed, catalog, later);
    expect(after.entries[0]).toMatchObject({ skill: 'q.c', reason: 'review' });
    expect(after.entries[0]?.mistakes).toBeGreaterThan(0);
    expect(after.entries.filter((e) => e.skill !== 'q.c').every((e) => e.mistakes === 0)).toBe(true);
  });

  test('a review that does not fit is skipped for a shorter one, and waits', () => {
    let s = withTrack(60);
    for (const [i, id] of ['q.a-lesson', 'q.a-lab', 'q.c-drill'].entries()) s = apply(s, attempt(s, catalog, id, `a${i}`, T0 + i * 60_000, { minutes: 1 }));
    s = applyEvent(s, ev({ type: 'settings.changed', at: T0 + DAY_MS, settings: { dailyMinutes: 5 } }));
    const q = buildQueue(s, catalog, T0 + 100 * DAY_MS);
    expect(q.entries.map((e) => `${e.item} ${e.reason}`)).toEqual(['q.c-drill review', 'q.a-drill new']);
    expect(q.waiting).toEqual({ reviews: 1, fresh: 2 });
  });

  test('an item the catalog no longer has is left out', () => {
    const s = apply(initialState(), cardReview({ attempt: 'c1', item: 'q.gone', seed: 1, at: T0, activeMs: 1, correct: true }));
    expect(buildQueue(s, catalog, T0 + 30 * DAY_MS).entries).toEqual([]);
  });

  test('with the items at hand a review gets a variant whose parameters differ from the last one', () => {
    const lab = { ...counterItem(), id: 'q.a-lab' };
    let s = withTrack();
    s = apply(s, attempt(s, catalog, 'q.a-lesson', 'a0', T0, { minutes: 1 }));
    s = apply(s, [ev({ type: 'attempt.started', at: T0, attempt: 'a1', item: 'q.a-lab', seed: 5, mode: 'new' }), ev({ type: 'attempt.finished', at: T0 + 1000, attempt: 'a1', outcome: 'passed', activeMs: 1000 }), ev({ type: 'rating', at: T0 + 1000, attempt: 'a1', item: 'q.a-lab', rating: GOOD, source: 'auto' })]);
    const entry = buildQueue(s, catalog, T0 + 100 * DAY_MS, { items: { 'q.a-lab': lab } }).entries.find((e) => e.item === 'q.a-lab');
    expect(entry?.reason).toBe('review');
    expect(resolveParams(lab, entry?.seed as number)).not.toEqual(resolveParams(lab, 5));
  });
});

describe('packs', () => {
  test('a manifest needs an id, a title and skills; unknown fields are refused', () => {
    expect(parsePackManifest({ id: 'p', title: 'P', skills: [{ id: 'p.s', title: 'S', requires: ['p.t'] }], tracks: [{ id: 'p.track', title: 'T', items: ['p.x.i-01'] }] }).problems).toEqual([]);
    expect(parsePackManifest({ id: 'p', title: 'P' }).problems.join()).toMatch(/skills/);
    expect(parsePackManifest({ id: 'p', title: 'P', skills: [{ id: 'p.s', title: 'S', level: 3 }] }).problems.join()).toMatch(/level/);
  });

  test('what is wrong across packs is named', () => {
    const it = (id: string, kind: string, skills: string[]): AnyItem => ({ id, kind, title: id, skills, curriculum: ['p.d.c'], difficulty: 1, targetMinutes: 1 }) as unknown as AnyItem;
    const exam = { id: 'p.exam-01', kind: 'exam', title: 'E', minutes: 1, passPercent: 50, tasks: [] } as unknown as AnyItem;
    const bad: PackContent = {
      pack: {
        id: 'p',
        title: 'P',
        skills: [{ id: 'p.a', title: 'A', requires: ['p.c'] }, { id: 'p.b', title: 'B', requires: ['p.a'] }, { id: 'p.c', title: 'C', requires: ['p.b'] }, { id: 'p.d', title: 'D', requires: ['p.nope', 'p.d'] }, { id: 'p.a', title: 'A again' }, { id: 'p.e', title: 'E' }, { id: 'p.f', title: 'F', requires: ['p.e'] }],
        tracks: [{ id: 'p.track', title: 'T', items: ['p.f-drill', 'p.e-drill', 'p.missing', 'p.exam-01'] }],
      },
      items: [it('p.e-drill', 'drill', ['p.e']), it('p.f-drill', 'drill', ['p.f']), it('p.e-drill', 'drill', ['p.e']), exam],
    };
    expect(catalogProblems([bad, { pack: { id: 'p', title: 'Other', skills: [{ id: 'p.z', title: 'Z' }] }, items: [] }])).toEqual([
      'pack p is defined twice',
      'skill p.a is defined twice',
      'item p.e-drill is defined twice',
      'skill p.d requires p.nope, which no pack defines',
      'skill p.d requires itself',
      'track p.track: p.f-drill needs skill p.e, which no earlier item of the track practices; it would never be offered',
      'track p.track: no item p.missing',
      'track p.track: p.exam-01 is an exam; a track holds what is practiced and scheduled',
    ]);
    const cycle: PackContent = { pack: { id: 'c', title: 'C', skills: [{ id: 'c.a', title: 'A', requires: ['c.c'] }, { id: 'c.b', title: 'B', requires: ['c.a'] }, { id: 'c.c', title: 'C', requires: ['c.b'] }] }, items: [] };
    expect(catalogProblems([cycle])).toEqual(['skills require each other: c.a → c.c → c.b → c.a']);
  });
});
