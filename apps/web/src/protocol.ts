// The message protocol between the page and the engine worker (docs/ARCHITECTURE.md §2.5, §3.8):
// terminal bytes both ways, control of the lab and of time, and the editor protocol. Every message
// is plain data (structured clone).

import type { Checkpoint, GapEvent, LoggedInput, Millis, SessionLog, ViewModel } from '@simlab/kernel';
import type { EditorRequest } from '@simlab/host';
import type { GradeReport, RenderedBlock } from '@simlab/learn';

/** What the page keeps in browser storage to resume an attempt by replay (§2.8). */
export interface StoredAttempt {
  v: 1;
  item: string;
  seed: number;
  /** Wall-clock start of the first attempt; the baseline is built at this virtual time. */
  startTime: Millis;
  /** Earlier attempts at this variant, ended by a reset. Not replayed; their lab actions count. */
  previous: SessionLog[];
  current: SessionLog;
  /** The last check's report, shown again after a reload. Not world state. */
  report?: GradeReport;
}

export type LabAction = 'check' | 'hint' | 'debrief' | 'solutions' | 'reset';

export type ToWorker =
  | { type: 'start'; item: string; seed: number; startTime: Millis; resume?: StoredAttempt }
  | { type: 'tty.open'; req: number; cols: number; rows: number }
  | { type: 'tty.bytes'; tty: string; data: string }
  | { type: 'tty.resize'; tty: string; cols: number; rows: number }
  | { type: 'tty.close'; tty: string }
  | { type: 'editor.save'; session: string; content: string }
  | { type: 'editor.close'; session: string }
  | { type: 'lab'; req: number; action: LabAction }
  /** Basic pause (phase 13 adds the speed control and skip to the UI). */
  | { type: 'pause'; paused: boolean }
  | { type: 'speed'; speed: number }
  /** Moves virtual time: by `ms`, or to the next pending event when `ms` is absent. */
  | { type: 'advance'; ms?: number }
  /** Asks for the stored attempt now (the page is being hidden). */
  | { type: 'flush' }
  /** The X-ray opened or closed: while it is open the worker sends view models (`view`). */
  | { type: 'view'; open: boolean }
  /** Something the editor overlay does not simulate; the worker completes it into a gap record. */
  | { type: 'gap'; session: string; gap: { kind: 'command' | 'behavior'; program: string; what: string; commandLine: string } };

export interface LabInfo {
  id: string;
  title: string;
  seed: number;
  targetMinutes: number;
  difficulty: number;
  /** Prose and rendered figures (figures of the start world, built when the attempt starts). */
  ticket: RenderedBlock[];
  hintCount: number;
  /** For gap records: the page does not load the engine packages. */
  engine: { version: string; kubernetes: string };
}

/** The lab's state as the learner has seen it: survives a reload through the log's lab actions. */
export interface LabState {
  hints: string[];
  solved: boolean;
  solutionViewed: boolean;
  debriefSeen: boolean;
  report?: GradeReport;
}

export interface TtyInfo {
  tty: string;
  cols: number;
  rows: number;
  /** The terminal's shell has exited. */
  ended: boolean;
}

export interface OpenEditor {
  session: string;
  tty?: string;
  request: EditorRequest;
  /** What the overlay starts with: the request's content, or the last save before a reload. */
  content: string;
  /** At least one save of this session was written (vim drops `[New]` after it). */
  saved: boolean;
}

export type LabResult =
  | { action: 'check'; report: GradeReport }
  | { action: 'hint'; hint?: { index: number; text: string } }
  /** Prose and figures, rendered when asked for: `now` is the world at that moment. */
  | { action: 'debrief'; blocks: RenderedBlock[] }
  | { action: 'solutions'; solutions: { name: string; text: string }[] }
  | { action: 'reset' };

export type ResumeProblem = 'changed' | 'diverged' | 'unknown-item' | 'error';

export type FromWorker =
  | { type: 'ready'; lab: LabInfo; state: LabState; ttys: TtyInfo[]; editors: OpenEditor[]; resumed: boolean; clock: Clock }
  | { type: 'failed'; problem: ResumeProblem; message: string }
  | { type: 'tty.opened'; req: number; tty: string }
  | { type: 'tty.out'; tty: string; data: string }
  | { type: 'tty.ended'; tty: string }
  | { type: 'editor.open'; editor: OpenEditor }
  | { type: 'editor.status'; session: string; ok: boolean; message?: string }
  | { type: 'editor.closed'; session: string }
  | { type: 'gap'; gap: GapEvent; replayed: boolean }
  /** A reset's result comes with a new world: every terminal of the old one is gone. */
  | { type: 'lab.result'; req: number; result: LabResult; state: LabState }
  | { type: 'clock'; clock: Clock }
  /** The whole attempt: at start, after lab actions and resets, and on `flush`. */
  | { type: 'attempt'; attempt: StoredAttempt }
  /**
   * What the current log gained since the last `attempt` or `attempt.delta`, sent at once after
   * every input so the page holds the latest log when it is closed. `from` is the number of inputs
   * the page should already have; a page that has another count asks for a `flush`.
   */
  | { type: 'attempt.delta'; from: number; inputs: LoggedInput[]; checkpoints: Checkpoint[]; end: Millis }
  /** The world's view model: when the X-ray opens, then at most every VIEW_EVERY ms while it changes. */
  | { type: 'view'; model: ViewModel }
  | { type: 'error'; message: string };

export interface Clock {
  /** Virtual time the learner has spent on the item, over every attempt. */
  elapsed: Millis;
  paused: boolean;
  speed: number;
}
