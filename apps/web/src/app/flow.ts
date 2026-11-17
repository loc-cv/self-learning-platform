// From what happens in an attempt to the progress log (docs/LEARNING_MODEL.md §5, §12): each lab
// action and each thing the learner says becomes an event, and leaving an item decides how an
// unfinished attempt ends. Pure functions; App.tsx records what they return.

import { dayIndex, PROGRESS_VERSION, type AttemptMode, type LearnerSettings, type ProgressEvent, type Rating, type RatingReason, type Schedule } from '@simlab/learn';
import type { LabResult, LessonStep, Note } from '../protocol.ts';

export interface AttemptRef {
  /** The attempt's id in the progress log. */
  id: string;
  item: string;
  mode: AttemptMode;
}

export function startedEvent(a: AttemptRef, seed: number, at: number): ProgressEvent {
  return { v: PROGRESS_VERSION, type: 'attempt.started', at, attempt: a.id, item: a.item, seed, mode: a.mode };
}

/**
 * The events of a lab action's result. `gaveUp` says the action revealed the answer before the
 * attempt passed: the solutions, or the debrief read early. Both count as the solution viewed.
 */
export function resultEvents(attempt: string, result: LabResult, at: number, gaveUp: boolean): ProgressEvent[] {
  const base = { v: PROGRESS_VERSION, at, attempt } as const;
  switch (result.action) {
    case 'check': {
      const e: ProgressEvent = { ...base, type: 'attempt.check', passed: result.report.passed, score: result.report.score, checks: result.report.checks.map((c) => ({ id: c.id, status: c.status })) };
      if (result.step !== undefined) e.step = result.step;
      return [e];
    }
    case 'hint': {
      if (!result.hint) return [];
      const e: ProgressEvent = { ...base, type: 'attempt.hint', index: result.hint.index };
      if (result.step !== undefined) e.step = result.step;
      return [e];
    }
    case 'solutions':
    case 'debrief':
      return gaveUp ? [{ ...base, type: 'attempt.solution' }] : [];
    case 'reset':
      return [];
  }
}

/** The event of something the learner said. A prediction with choices is checked against the step's answer. */
export function noteEvent(attempt: string, note: Note, at: number, steps?: readonly LessonStep[]): ProgressEvent | undefined {
  const base = { v: PROGRESS_VERSION, at, attempt } as const;
  if (note.kind === 'confidence') return { ...base, type: 'attempt.confidence', confidence: note.value };
  if (note.kind === 'explanation') return note.text.trim() === '' ? undefined : { ...base, type: 'attempt.explanation', text: note.text.trim() };
  const e: ProgressEvent = { ...base, type: 'attempt.prediction', step: note.step };
  const step = steps?.[note.step];
  if (note.choice !== undefined) {
    e.choice = note.choice;
    if (step?.kind === 'predict' && step.answer !== undefined) e.correct = note.choice === step.answer;
  }
  if (note.text !== undefined) e.text = note.text;
  return e;
}

export type LeaveReason =
  /** The session skips the item, or another variant of it starts: the attempt is given up without a grade. */
  | 'skip'
  /** Home, another item, the next one: an attempt that can still be solved stays open. */
  | 'away';

/**
 * How an attempt that has not passed ends when the learner leaves it. Having seen the answer it
 * failed; skipped, it is abandoned and changes no schedule; otherwise it stays open and resumes.
 */
export function leaveOutcome(gaveUp: boolean, reason: LeaveReason): 'failed' | 'abandoned' | undefined {
  if (gaveUp) return 'failed';
  return reason === 'skip' ? 'abandoned' : undefined;
}

/** A lesson is over when every gate is behind the learner: each task passed, each prediction answered. */
export function lessonDone(steps: readonly LessonStep[], tasks: Readonly<Record<number, { passed: boolean }>> | undefined, predictions: Readonly<Record<number, unknown>> | undefined): boolean {
  return steps.every((s, i) => (s.kind === 'task' ? tasks?.[i]?.passed === true : s.kind === 'predict' ? predictions?.[i] !== undefined : true));
}

export const RATING_NAMES: Record<Rating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/** Why the automatic rating is what it is (packages/learn/src/progress/rating.ts). */
export const REASON_TEXT: Record<RatingReason, string> = {
  failed: 'not solved',
  'solution-viewed': 'the solution was viewed before it passed',
  'all-hints': 'every hint was used, and the last one is the exact command',
  hints: 'a hint was used',
  xray: 'the X-ray was open before it passed',
  slow: 'slower than one and a half times the target',
  'failed-checks': 'two or more checks failed first',
  fast: 'first check, no help, well inside the target',
  clean: 'solved without help, inside the target',
};

/** "tomorrow", "in 5 days", with the date: when a schedule brings the item back, in the learner's days. */
export function nextReview(schedule: Pick<Schedule, 'dueAt'>, settings: Pick<LearnerSettings, 'utcOffsetMinutes' | 'dayStartHour'>, now: number): { days: number; text: string; date: string } {
  const days = Math.max(0, dayIndex(schedule.dueAt, settings) - dayIndex(now, settings));
  // The date as the learner's clock shows it: shift by the stored offset and read the UTC fields.
  const local = new Date(schedule.dueAt + settings.utcOffsetMinutes * 60_000);
  const date = `${local.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][local.getUTCMonth()]}`;
  return { days, text: days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`, date };
}

/** A lesson's steps in the pages its tab strip shows: a page ends at a prediction or a guided task, its gate. */
export interface LessonPage {
  /** Indexes of the page's steps. */
  steps: number[];
  /** The step that must be done before the next page opens; the last page may have none. */
  gate?: number;
  gateKind?: 'predict' | 'task';
}

export function lessonPages(steps: readonly LessonStep[]): LessonPage[] {
  const pages: LessonPage[] = [];
  let open: number[] = [];
  steps.forEach((s, i) => {
    open.push(i);
    if (s.kind === 'predict' || s.kind === 'task') {
      pages.push({ steps: open, gate: i, gateKind: s.kind });
      open = [];
    }
  });
  if (open.length > 0) pages.push({ steps: open });
  return pages;
}

/** Whether a page's gate is behind the learner (a page without one never holds anyone up). */
export function gateDone(page: LessonPage, steps: readonly LessonStep[], tasks: Readonly<Record<number, { passed: boolean }>> | undefined, predictions: Readonly<Record<number, unknown>> | undefined): boolean {
  if (page.gate === undefined) return true;
  return steps[page.gate]?.kind === 'task' ? tasks?.[page.gate]?.passed === true : predictions?.[page.gate] !== undefined;
}

/** The first page whose gate is still ahead: pages after it are locked. The last page when all are done. */
export function lessonFrontier(pages: readonly LessonPage[], steps: readonly LessonStep[], tasks: Readonly<Record<number, { passed: boolean }>> | undefined, predictions: Readonly<Record<number, unknown>> | undefined): number {
  const at = pages.findIndex((p) => !gateDone(p, steps, tasks, predictions));
  return at === -1 ? Math.max(0, pages.length - 1) : at;
}
