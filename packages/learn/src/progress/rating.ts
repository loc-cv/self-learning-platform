// The automatic rating (docs/LEARNING_MODEL.md §6): what an attempt's performance tells FSRS.
// Pure: the same performance gives the same grade. The learner can override it; the override is
// its own event.

import { AGAIN, EASY, GOOD, HARD, type Rating } from './events.ts';

/** What an attempt showed. */
export interface Performance {
  passed: boolean;
  /** Time spent working. */
  activeMs: number;
  /** The item's target time. */
  targetMinutes: number;
  /** Hints taken, and how long the ladder is. */
  hintsUsed: number;
  hintCount: number;
  /** The live view of the world was opened before the attempt passed. */
  xrayOpened: boolean;
  /** The reference solution was viewed before the attempt passed. */
  solutionViewed: boolean;
  /** Presses of Check that did not pass. */
  failedChecks: number;
}

/** Slower than this share of the target is Hard; within the fast share, with no help, is Easy. */
export const SLOW_FACTOR = 1.5;
export const FAST_FACTOR = 0.6;
/** This many failed checks before the pass is Hard. */
export const FAILED_CHECKS_FOR_HARD = 2;

export type RatingReason = 'failed' | 'solution-viewed' | 'all-hints' | 'hints' | 'xray' | 'slow' | 'failed-checks' | 'fast' | 'clean';

export interface AutoRating {
  rating: Rating;
  /** Why, as stable codes the interface words: the ones that decided the grade. */
  reasons: RatingReason[];
}

/**
 * Again: not passed, the solution viewed, or the whole hint ladder used (its last rung is the
 * exact command). Hard: passed with a hint, with the X-ray, slowly, or after several failed
 * checks. Easy: passed first time, unaided, well inside the target. Good: everything else.
 */
export function autoRating(p: Performance): AutoRating {
  if (!p.passed) return { rating: AGAIN, reasons: ['failed'] };
  if (p.solutionViewed) return { rating: AGAIN, reasons: ['solution-viewed'] };
  // A ladder of three ends with the answer; a drill's single hint is a nudge and costs only Hard.
  if (p.hintCount >= 3 && p.hintsUsed >= p.hintCount) return { rating: AGAIN, reasons: ['all-hints'] };
  const target = p.targetMinutes * 60_000;
  const hard: RatingReason[] = [];
  if (p.hintsUsed > 0) hard.push('hints');
  if (p.xrayOpened) hard.push('xray');
  if (p.activeMs > target * SLOW_FACTOR) hard.push('slow');
  if (p.failedChecks >= FAILED_CHECKS_FOR_HARD) hard.push('failed-checks');
  if (hard.length > 0) return { rating: HARD, reasons: hard };
  if (p.failedChecks === 0 && p.activeMs <= target * FAST_FACTOR) return { rating: EASY, reasons: ['fast'] };
  return { rating: GOOD, reasons: ['clean'] };
}
