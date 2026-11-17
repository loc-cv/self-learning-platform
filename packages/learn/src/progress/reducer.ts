// The reducer (docs/LEARNING_MODEL.md §5): progress state is a pure function of the event log.
// `applyEvent` never reads a clock, a random source or the content; the same events in the same
// order give the same state, which is what lets the derived state be deleted and rebuilt, and
// what the simulated learner test compares. State is plain serializable data.

import { dayIndex, DAY_MS } from './day.ts';
import { AGAIN, DEFAULT_SETTINGS, eventProblem, PROGRESS_VERSION, type LearnerSettings, type ProgressEvent, type Rating } from './events.ts';
import { reviewMemory, type Memory } from './fsrs.ts';

/** No item comes back sooner than this after a review: the daily session is the unit (D-142). */
export const MINIMUM_INTERVAL_DAYS = 1;

/** An attempt that has started and not finished. */
export interface OpenAttempt {
  item: string;
  seed: number;
  startedAt: number;
  hints: number;
  failedChecks: number;
  checks: number;
  xray: boolean;
  solution: boolean;
  /** A check passed; what happens after no longer counts as help. */
  passed: boolean;
  predictions: number;
  correctPredictions: number;
  confidence?: number;
  explained: boolean;
}

/** The last finished attempt of an item: what a rating is about. */
export interface LastAttempt {
  attempt: string;
  at: number;
  seed: number;
  outcome: 'passed' | 'failed' | 'abandoned';
  activeMs: number;
  hints: number;
  failedChecks: number;
  xray: boolean;
  solution: boolean;
  confidence?: number;
}

/** Where FSRS has an item. */
export interface Schedule {
  memory: Memory;
  reviewedAt: number;
  dueAt: number;
  /** The interval in days from `reviewedAt` to `dueAt`. */
  intervalDays: number;
  rating: Rating;
}

export interface Mistakes {
  /** Attempts that ended failed. */
  failures: number;
  failedChecks: number;
  hints: number;
  solutions: number;
}

export interface ItemProgress {
  /** Finished attempts, abandoned ones included. */
  attempts: number;
  passes: number;
  firstPassedAt?: number;
  last?: LastAttempt;
  /** Absent until the first rating: the item is new. */
  schedule?: Schedule;
  /** The schedule before the rating of `ratedAttempt`, so a manual rating can replace an automatic one. */
  ratedAttempt?: string;
  before?: Schedule | null;
  reviews: number;
  /** Reviews rated Again after the first. */
  lapses: number;
  mistakes: Mistakes;
  /** Mistakes per learner's day, for "recent mistakes". */
  mistakeDays: Record<string, number>;
  activeMs: number;
}

export interface DayProgress {
  attempts: number;
  passes: number;
  activeMs: number;
}

export interface ProgressState {
  v: typeof PROGRESS_VERSION;
  /** Events applied. */
  events: number;
  settings: LearnerSettings;
  open: Record<string, OpenAttempt>;
  items: Record<string, ItemProgress>;
  days: Record<string, DayProgress>;
  /** The last item finished, for interleaving against what the learner just did. */
  lastFinished?: { item: string; at: number };
}

export function initialState(): ProgressState {
  return { v: PROGRESS_VERSION, events: 0, settings: { ...DEFAULT_SETTINGS }, open: {}, items: {}, days: {} };
}

const newItem = (): ItemProgress => ({ attempts: 0, passes: 0, reviews: 0, lapses: 0, mistakes: { failures: 0, failedChecks: 0, hints: 0, solutions: 0 }, mistakeDays: {}, activeMs: 0 });

function mistake(item: ItemProgress, kind: keyof Mistakes, at: number, settings: LearnerSettings): ItemProgress {
  const day = String(dayIndex(at, settings));
  return { ...item, mistakes: { ...item.mistakes, [kind]: item.mistakes[kind] + 1 }, mistakeDays: { ...item.mistakeDays, [day]: (item.mistakeDays[day] ?? 0) + 1 } };
}

/** The schedule after a review at `at` with `rating`. */
export function schedule(before: Schedule | undefined, rating: Rating, at: number, retention: number): Schedule {
  const elapsed = before ? (at - before.reviewedAt) / DAY_MS : 0;
  const memory = reviewMemory(before?.memory, elapsed, rating, retention);
  const intervalDays = Math.max(MINIMUM_INTERVAL_DAYS, memory.scheduledDays);
  return { memory, reviewedAt: at, dueAt: at + Math.round(intervalDays * DAY_MS), intervalDays, rating };
}

function finish(state: ProgressState, itemId: string, last: LastAttempt): ProgressState {
  let item = state.items[itemId] ?? newItem();
  const passed = last.outcome === 'passed';
  item = { ...item, attempts: item.attempts + 1, passes: item.passes + (passed ? 1 : 0), last, activeMs: item.activeMs + last.activeMs };
  if (passed && item.firstPassedAt === undefined) item.firstPassedAt = last.at;
  if (last.outcome === 'failed') item = mistake(item, 'failures', last.at, state.settings);
  const day = String(dayIndex(last.at, state.settings));
  const d = state.days[day] ?? { attempts: 0, passes: 0, activeMs: 0 };
  return {
    ...state,
    items: { ...state.items, [itemId]: item },
    days: { ...state.days, [day]: { attempts: d.attempts + 1, passes: d.passes + (passed ? 1 : 0), activeMs: d.activeMs + last.activeMs } },
    lastFinished: { item: itemId, at: last.at },
  };
}

/** An open attempt's item, changed; an event for an attempt that is not open changes nothing. */
function onOpen(state: ProgressState, attempt: string, change: (a: OpenAttempt, item: ItemProgress) => { a: OpenAttempt; item?: ItemProgress }): ProgressState {
  const a = state.open[attempt];
  if (!a) return state;
  const r = change(a, state.items[a.item] ?? newItem());
  return { ...state, open: { ...state.open, [attempt]: r.a }, items: r.item ? { ...state.items, [a.item]: r.item } : state.items };
}

/** The state after one more event. The argument is not changed. */
export function applyEvent(state: ProgressState, e: ProgressEvent): ProgressState {
  const s = { ...state, events: state.events + 1 };
  switch (e.type) {
    case 'settings.changed':
      return { ...s, settings: { ...s.settings, ...e.settings } };
    case 'attempt.started':
      return { ...s, open: { ...s.open, [e.attempt]: { item: e.item, seed: e.seed, startedAt: e.at, hints: 0, failedChecks: 0, checks: 0, xray: false, solution: false, passed: false, predictions: 0, correctPredictions: 0, explained: false } } };
    case 'attempt.check':
      return onOpen(s, e.attempt, (a, item) => (e.passed ? { a: { ...a, checks: a.checks + 1, passed: true } } : { a: { ...a, checks: a.checks + 1, failedChecks: a.failedChecks + 1 }, item: mistake(item, 'failedChecks', e.at, s.settings) }));
    case 'attempt.hint':
      return onOpen(s, e.attempt, (a, item) => ({ a: { ...a, hints: a.hints + 1 }, item: mistake(item, 'hints', e.at, s.settings) }));
    case 'attempt.xray':
      // Looking after the pass is study, not help.
      return onOpen(s, e.attempt, (a) => ({ a: e.open && !a.passed ? { ...a, xray: true } : a }));
    case 'attempt.solution':
      return onOpen(s, e.attempt, (a, item) => (a.passed || a.solution ? { a } : { a: { ...a, solution: true }, item: mistake(item, 'solutions', e.at, s.settings) }));
    case 'attempt.prediction':
      return onOpen(s, e.attempt, (a) => ({ a: { ...a, predictions: a.predictions + 1, correctPredictions: a.correctPredictions + (e.correct === true ? 1 : 0) } }));
    case 'attempt.confidence':
      return onOpen(s, e.attempt, (a) => ({ a: { ...a, confidence: e.confidence } }));
    case 'attempt.explanation':
      return onOpen(s, e.attempt, (a) => ({ a: { ...a, explained: true } }));
    case 'attempt.finished': {
      const a = s.open[e.attempt];
      if (!a) return s;
      const { [e.attempt]: _closed, ...open } = s.open;
      const last: LastAttempt = { attempt: e.attempt, at: e.at, seed: a.seed, outcome: e.outcome, activeMs: e.activeMs, hints: a.hints, failedChecks: a.failedChecks, xray: a.xray, solution: a.solution };
      if (a.confidence !== undefined) last.confidence = a.confidence;
      return finish({ ...s, open }, a.item, last);
    }
    case 'card.reviewed':
      return finish(s, e.item, { attempt: e.attempt, at: e.at, seed: e.seed, outcome: e.outcome, activeMs: e.activeMs, hints: 0, failedChecks: 0, xray: false, solution: false });
    case 'rating': {
      const item = s.items[e.item];
      // A rating is about the item's last finished attempt; one for anything else is stale.
      if (!item?.last || item.last.attempt !== e.attempt) return s;
      const again = item.ratedAttempt === e.attempt;
      const before = again ? (item.before ?? undefined) : item.schedule;
      const next = schedule(before, e.rating, item.last.at, s.settings.retention);
      const lapsed = (r: Rating): number => (before && r === AGAIN ? 1 : 0);
      const lapses = item.lapses - (again && item.schedule ? lapsed(item.schedule.rating) : 0) + lapsed(e.rating);
      return { ...s, items: { ...s.items, [e.item]: { ...item, schedule: next, ratedAttempt: e.attempt, before: before ?? null, reviews: item.reviews + (again ? 0 : 1), lapses } } };
    }
  }
}

/** The state a log gives. Throws on a line that is not an event of a version this code reads. */
export function replay(events: readonly ProgressEvent[], from: ProgressState = initialState()): ProgressState {
  let state = from;
  events.forEach((e, i) => {
    const problem = eventProblem(e);
    if (problem) throw new Error(`event ${i + 1}: ${problem}`);
    state = applyEvent(state, e);
  });
  return state;
}
