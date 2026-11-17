// FSRS through ts-fsrs (PLAN.md §11: a maintained library, not a hand-rolled scheduler). The
// library's default model, FSRS-7, with its default weights; time as plain numbers (elapsed days),
// so a card's memory state is plain data and no Date is involved. Only the memory model and the
// interval for a target retention come from the library; when an item is due is the reducer's
// business (a floor of one day, the learner's day boundary).
//
// ts-fsrs 6.0.0: README "Create a custom scheduler with defineScheduler"; `numericChrono` counts
// in days and takes the time since the last review as `now` (srs-kit chrono/numeric).

import { defineScheduler, numericChrono } from 'ts-fsrs';
import { schedulerDesiredRetentionMiddleware, schedulerMaximumIntervalMiddleware, schedulerScheduledDaysMiddleware, schedulerStatsMiddleware } from 'ts-fsrs/middlewares';
import { FSRS7_DEFAULT_WEIGHTS, FSRS7Model } from 'ts-fsrs/models/fsrs-7';
import type { Rating } from './events.ts';

/** What FSRS remembers about one item: plain numbers and strings, stored in the progress state as is. */
export interface Memory {
  stability: number;
  stabilityFast: number;
  difficulty: number;
  /** The library's card state and schedule status; with no learning steps a reviewed card is in review. */
  state: 0 | 1 | 2 | 3;
  scheduleStatus: 'new' | 'learning' | 'review';
  reps: number;
  lapses: number;
  /** The interval FSRS asked for at the last review, in days. */
  scheduledDays: number;
}

/** No interval is longer than this many days. */
export const MAXIMUM_INTERVAL_DAYS = 3650;

const definition = defineScheduler({ model: FSRS7Model, chrono: numericChrono }).use(
  schedulerDesiredRetentionMiddleware,
  schedulerStatsMiddleware,
  schedulerScheduledDaysMiddleware,
  schedulerMaximumIntervalMiddleware,
);

type Scheduler = ReturnType<typeof definition.create>;
const schedulers = new Map<number, Scheduler>();

/** One scheduler per target retention; building one is pure, so the cache only saves time. */
function schedulerFor(retention: number): Scheduler {
  let s = schedulers.get(retention);
  if (!s) {
    // No learning-steps middleware: an item reviewed today comes back on a later day, never
    // minutes later (docs/decisions.md D-142).
    s = definition.create({ config: { fractionalDays: true, weights: FSRS7_DEFAULT_WEIGHTS, desiredRetention: retention, maximumInterval: MAXIMUM_INTERVAL_DAYS } });
    schedulers.set(retention, s);
  }
  return s;
}

/**
 * One review: the memory after it, whose `scheduledDays` is the interval for `retention`.
 * `elapsedDays` is the time since the last review (ignored for a first review).
 */
export function reviewMemory(memory: Memory | undefined, elapsedDays: number, rating: Rating, retention: number): Memory {
  const s = schedulerFor(retention);
  const card = memory ?? s.newCard({ now: 0 });
  const next = s.review({ card, grade: rating, now: Math.max(0, elapsedDays) }).card;
  return { stability: next.stability, stabilityFast: next.stabilityFast, difficulty: next.difficulty, state: next.state, scheduleStatus: next.scheduleStatus, reps: next.reps, lapses: next.lapses, scheduledDays: next.scheduledDays };
}

/** The probability of recalling the item `elapsedDays` after its last review, 0 to 1. */
export function retrievability(memory: Memory, elapsedDays: number): number {
  return schedulerFor(0.9).model.forgettingCurve(memory, Math.max(0, elapsedDays));
}
