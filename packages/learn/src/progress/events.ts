// The progress log (docs/LEARNING_MODEL.md §5): append-only events, one JSON object per line in
// data/progress.jsonl. Everything else the learning layer knows is derived from them by the
// reducer (reducer.ts). `at` is wall-clock time in milliseconds since the epoch, given by whoever
// records the event; nothing here reads a clock.

import type { Json } from '@simlab/kernel';
import { formatSchemaErrors, validateSchema } from '../item/jsonschema.ts';

/** The version every event of this code carries. Raise it when an event's meaning changes. */
export const PROGRESS_VERSION = 1;

/** FSRS's grades: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Rating = 1 | 2 | 3 | 4;
export const AGAIN: Rating = 1;
export const HARD: Rating = 2;
export const GOOD: Rating = 3;
export const EASY: Rating = 4;

/** What the learner chooses about scheduling. Changing one is an event, so a replay sees it when it happened. */
export interface LearnerSettings {
  /** The recall probability FSRS schedules for, 0.7 to 0.97. */
  retention: number;
  /** The daily session's time box. */
  dailyMinutes: number;
  /** The track new material comes from; none means reviews only. */
  activeTrack?: string;
  /** Local time minus UTC, in minutes: where the learner's day is. */
  utcOffsetMinutes: number;
  /** The hour of local time a new day starts at, so a session past midnight belongs to the evening. */
  dayStartHour: number;
}

export const DEFAULT_SETTINGS: LearnerSettings = { retention: 0.9, dailyMinutes: 30, utcOffsetMinutes: 0, dayStartHour: 4 };

interface Base {
  v: typeof PROGRESS_VERSION;
  at: number;
}

/** How an attempt came about: the queue asked for a review, offered something new, or the learner picked it. */
export type AttemptMode = 'review' | 'new' | 'free';

export type ProgressEvent =
  | (Base & { type: 'settings.changed'; settings: Partial<LearnerSettings> })
  | (Base & { type: 'attempt.started'; attempt: string; item: string; seed: number; mode: AttemptMode })
  /** A press of Check: the grade and each check's result. `step` is the lesson step of a guided task. */
  | (Base & { type: 'attempt.check'; attempt: string; passed: boolean; score: number; checks: { id: string; status: 'pass' | 'fail' | 'error' }[]; step?: number })
  | (Base & { type: 'attempt.hint'; attempt: string; index: number; step?: number })
  /** The live view of the world (the X-ray) opened or closed. */
  | (Base & { type: 'attempt.xray'; attempt: string; open: boolean })
  | (Base & { type: 'attempt.solution'; attempt: string })
  /** An answer to a prediction prompt: a choice, or free text the learner compared themselves. */
  | (Base & { type: 'attempt.prediction'; attempt: string; step: number; choice?: number; text?: string; correct?: boolean })
  /** Confidence before checking, 1 (guessing) to 5 (certain). */
  | (Base & { type: 'attempt.confidence'; attempt: string; confidence: number })
  /** The root cause in the learner's words, written before the debrief. */
  | (Base & { type: 'attempt.explanation'; attempt: string; text: string })
  /** `activeMs` is the time spent working, which is what the rating compares with the target. */
  | (Base & { type: 'attempt.finished'; attempt: string; outcome: 'passed' | 'failed' | 'abandoned'; activeMs: number })
  /** A card answered: one event for the whole attempt. */
  | (Base & { type: 'card.reviewed'; attempt: string; item: string; seed: number; outcome: 'passed' | 'failed'; activeMs: number; choice?: number })
  /** The grade FSRS gets for an attempt. `auto` comes from performance; a later `manual` one for the same attempt replaces it. */
  | (Base & { type: 'rating'; attempt: string; item: string; rating: Rating; source: 'auto' | 'manual'; reasons?: string[] });

export type ProgressEventType = ProgressEvent['type'];

type Schema = { [key: string]: Json };
const ID: Schema = { type: 'string', minLength: 1 };
const INT: Schema = { type: 'integer', minimum: 0 };
const BOOL: Schema = { type: 'boolean' };
const event = (properties: Schema, required: string[]): Schema => ({
  type: 'object',
  properties: { v: { const: PROGRESS_VERSION }, type: ID, at: { type: 'number', minimum: 0 }, ...properties },
  required: ['v', 'type', 'at', ...required],
  additionalProperties: false,
});

const SETTINGS: Schema = {
  type: 'object',
  minProperties: 1,
  properties: {
    retention: { type: 'number', minimum: 0.7, maximum: 0.97 },
    dailyMinutes: { type: 'number', minimum: 1, maximum: 1440 },
    activeTrack: ID,
    utcOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840 },
    dayStartHour: { type: 'integer', minimum: 0, maximum: 23 },
  },
  additionalProperties: false,
};

/** One schema per event type. */
export const EVENT_SCHEMAS: Record<ProgressEventType, Schema> = {
  'settings.changed': event({ settings: SETTINGS }, ['settings']),
  'attempt.started': event({ attempt: ID, item: ID, seed: INT, mode: { enum: ['review', 'new', 'free'] } }, ['attempt', 'item', 'seed', 'mode']),
  'attempt.check': event(
    {
      attempt: ID,
      passed: BOOL,
      score: { type: 'number', minimum: 0, maximum: 1 },
      checks: { type: 'array', items: { type: 'object', properties: { id: ID, status: { enum: ['pass', 'fail', 'error'] } }, required: ['id', 'status'], additionalProperties: false } },
      step: INT,
    },
    ['attempt', 'passed', 'score', 'checks'],
  ),
  'attempt.hint': event({ attempt: ID, index: INT, step: INT }, ['attempt', 'index']),
  'attempt.xray': event({ attempt: ID, open: BOOL }, ['attempt', 'open']),
  'attempt.solution': event({ attempt: ID }, ['attempt']),
  'attempt.prediction': event({ attempt: ID, step: INT, choice: INT, text: { type: 'string' }, correct: BOOL }, ['attempt', 'step']),
  'attempt.confidence': event({ attempt: ID, confidence: { type: 'integer', minimum: 1, maximum: 5 } }, ['attempt', 'confidence']),
  'attempt.explanation': event({ attempt: ID, text: { type: 'string' } }, ['attempt', 'text']),
  'attempt.finished': event({ attempt: ID, outcome: { enum: ['passed', 'failed', 'abandoned'] }, activeMs: { type: 'number', minimum: 0 } }, ['attempt', 'outcome', 'activeMs']),
  'card.reviewed': event({ attempt: ID, item: ID, seed: INT, outcome: { enum: ['passed', 'failed'] }, activeMs: { type: 'number', minimum: 0 }, choice: INT }, ['attempt', 'item', 'seed', 'outcome', 'activeMs']),
  rating: event({ attempt: ID, item: ID, rating: { enum: [1, 2, 3, 4] }, source: { enum: ['auto', 'manual'] }, reasons: { type: 'array', items: ID } }, ['attempt', 'item', 'rating', 'source']),
};

/** Why `e` is not an event this code can read, or undefined when it is one. The server asks before appending. */
export function eventProblem(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'an event is a JSON object';
  const o = e as { v?: unknown; type?: unknown };
  if (typeof o.v !== 'number' || !Number.isInteger(o.v)) return 'v must be an integer (the schema version)';
  if (o.v > PROGRESS_VERSION) return `v is ${o.v}; this version reads up to ${PROGRESS_VERSION}`;
  if (typeof o.type !== 'string' || !Object.hasOwn(EVENT_SCHEMAS, o.type)) return `unknown event type ${JSON.stringify(o.type)}`;
  const errors = formatSchemaErrors(validateSchema(EVENT_SCHEMAS[o.type as ProgressEventType], e as Json), 'the event');
  return errors.length > 0 ? `${o.type}: ${errors.join('; ')}` : undefined;
}

/** Parses the lines of a progress log. A line that is not an event stops the read with its number. */
export function parseLog(text: string): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      throw new Error(`progress log line ${i + 1}: not JSON`);
    }
    const problem = eventProblem(e);
    if (problem) throw new Error(`progress log line ${i + 1}: ${problem}`);
    out.push(e as ProgressEvent);
  });
  return out;
}
