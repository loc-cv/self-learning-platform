// The daily session as the page runs it (docs/LEARNING_MODEL.md §8, §12): the queue is a pure
// function of the progress state, rebuilt after every item; what the page adds is what the log
// does not hold: that a session is running, and which entries the learner skipped today.

import { buildQueue, dayIndex, PROGRESS_VERSION, type Catalog, type LearnerSettings, type ProgressEvent, type ProgressState, type Queue } from '@simlab/learn';
import type { Practiced } from '../content.ts';
import type { KeyValue } from './storage.ts';

/** What a time box can be set to on the home screen (minutes). */
export const TIME_BOXES = [15, 30, 45, 60] as const;

export interface DailySession {
  /** The learner's day the session belongs to; one from another day is over. */
  day: number;
  /** The runner is on: finishing an item opens the next one. */
  running: boolean;
  /** Items skipped today: they stay due and come back tomorrow, or from the home screen. */
  skipped: string[];
  /** What the session went through, in order. */
  done: { item: string; outcome: 'passed' | 'failed' | 'abandoned' }[];
}

const KEY = 'simlab.session.v1';

export function loadSession(kv: KeyValue | undefined, day: number): DailySession {
  const fresh: DailySession = { day, running: false, skipped: [], done: [] };
  try {
    const raw = kv?.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Partial<DailySession>) : undefined;
    if (!s || s.day !== day || !Array.isArray(s.skipped) || !Array.isArray(s.done)) return fresh;
    return { day, running: s.running === true, skipped: s.skipped, done: s.done };
  } catch {
    return fresh;
  }
}

export function saveSession(kv: KeyValue | undefined, s: DailySession): void {
  try {
    kv?.setItem(KEY, JSON.stringify(s));
  } catch {
    // Without storage a reload forgets that a session was running; the queue itself is in the log.
  }
}

/** Today's queue without what the learner skipped. */
export function sessionQueue(state: ProgressState, catalog: Catalog, items: Readonly<Record<string, Practiced>>, now: number, skipped: readonly string[] = []): Queue {
  const q = buildQueue(state, catalog, now, { items });
  if (skipped.length === 0) return q;
  const entries = q.entries.filter((e) => !skipped.includes(e.item));
  return { ...q, entries, minutes: entries.reduce((n, e) => n + e.minutes, 0) };
}

export const today = (state: ProgressState, now: number): number => dayIndex(now, state.settings);

/** A `settings.changed` event. */
export function settingsEvent(settings: Partial<LearnerSettings>, at: number): ProgressEvent {
  return { v: PROGRESS_VERSION, type: 'settings.changed', at, settings };
}

/**
 * What a first run, or a move to another time zone, has to record before a queue means anything:
 * the browser's offset from UTC, and a track to take new material from (the first one of the
 * catalog) when none is chosen or the chosen one is gone.
 */
export function initialSettings(state: ProgressState, catalog: Catalog, utcOffsetMinutes: number, at: number): ProgressEvent | undefined {
  const change: Partial<LearnerSettings> = {};
  if (state.settings.utcOffsetMinutes !== utcOffsetMinutes) change.utcOffsetMinutes = utcOffsetMinutes;
  const tracks = Object.keys(catalog.tracks);
  const first = tracks[0];
  if (first !== undefined && (state.settings.activeTrack === undefined || !catalog.tracks[state.settings.activeTrack])) change.activeTrack = first;
  return Object.keys(change).length > 0 ? settingsEvent(change, at) : undefined;
}

/** An attempt's id, also the name of its input log on the server: sortable by start time. */
export function attemptId(at: number, random: number): string {
  return `a${at.toString(36)}-${Math.floor(random * 36 ** 6).toString(36).padStart(6, '0')}`;
}

/** The open attempt of an item, if the log has one: the newest. */
export function openAttemptOf(state: ProgressState, item: string): string | undefined {
  let best: string | undefined;
  for (const [id, a] of Object.entries(state.open)) if (a.item === item && (best === undefined || a.startedAt >= (state.open[best]?.startedAt ?? 0))) best = id;
  return best;
}
