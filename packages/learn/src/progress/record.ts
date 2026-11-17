// Writing the log (docs/LEARNING_MODEL.md §5, §6): the events that close an attempt. The app
// records what happens as it happens; when the attempt ends, these turn the attempt's state into
// `attempt.finished` and the automatic `rating`, so the grade is in the log and a later change to
// the rating rules never rewrites history.

import type { ItemMeta } from '../pack.ts';
import { isScheduled } from '../pack.ts';
import { AGAIN, GOOD, PROGRESS_VERSION, type ProgressEvent, type Rating } from './events.ts';
import { autoRating, type AutoRating } from './rating.ts';
import type { OpenAttempt, ProgressState } from './reducer.ts';

export interface FinishInput {
  attempt: string;
  at: number;
  outcome: 'passed' | 'failed' | 'abandoned';
  /** Time spent working; default: from the attempt's start to `at`. */
  activeMs?: number;
  /** How many hints the variant's ladder has. */
  hintCount: number;
}

/** The automatic rating of an open attempt that ends now. */
export function rateAttempt(a: OpenAttempt, meta: Pick<ItemMeta, 'targetMinutes'>, input: FinishInput): AutoRating {
  return autoRating({
    passed: input.outcome === 'passed',
    activeMs: input.activeMs ?? input.at - a.startedAt,
    targetMinutes: meta.targetMinutes,
    hintsUsed: a.hints,
    hintCount: input.hintCount,
    xrayOpened: a.xray,
    solutionViewed: a.solution,
    failedChecks: a.failedChecks,
  });
}

/**
 * The events that end an open attempt: `attempt.finished`, and for a scheduled item that was not
 * abandoned the automatic `rating`. An abandoned attempt changes no schedule; a lesson is never
 * rated (it is done once, D-141).
 */
export function finishAttempt(state: ProgressState, meta: ItemMeta, input: FinishInput): ProgressEvent[] {
  const a = state.open[input.attempt];
  if (!a) throw new Error(`no open attempt ${input.attempt}`);
  const activeMs = input.activeMs ?? input.at - a.startedAt;
  const events: ProgressEvent[] = [{ v: PROGRESS_VERSION, type: 'attempt.finished', at: input.at, attempt: input.attempt, outcome: input.outcome, activeMs }];
  if (input.outcome !== 'abandoned' && isScheduled(meta.kind)) {
    const r = rateAttempt(a, meta, { ...input, activeMs });
    events.push({ v: PROGRESS_VERSION, type: 'rating', at: input.at, attempt: input.attempt, item: a.item, rating: r.rating, source: 'auto', reasons: r.reasons });
  }
  return events;
}

export interface CardReviewInput {
  attempt: string;
  item: string;
  seed: number;
  at: number;
  activeMs: number;
  /** A card checked by choice or by command: whether the answer was right. */
  correct?: boolean;
  choice?: number;
  /** A self-graded card: the learner's own grade. */
  rating?: Rating;
}

/** The events of a card review: checked cards are Good or Again; a self-graded one takes the learner's grade. */
export function cardReview(input: CardReviewInput): ProgressEvent[] {
  if (input.correct === undefined && input.rating === undefined) throw new Error('a card review needs `correct` or `rating`');
  const rating: Rating = input.rating ?? (input.correct ? GOOD : AGAIN);
  const reviewed: ProgressEvent = { v: PROGRESS_VERSION, type: 'card.reviewed', at: input.at, attempt: input.attempt, item: input.item, seed: input.seed, outcome: rating === AGAIN ? 'failed' : 'passed', activeMs: input.activeMs };
  if (input.choice !== undefined) reviewed.choice = input.choice;
  return [reviewed, { v: PROGRESS_VERSION, type: 'rating', at: input.at, attempt: input.attempt, item: input.item, rating, source: input.rating === undefined ? 'auto' : 'manual' }];
}
