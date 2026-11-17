// The message protocol between the page and the engine worker (docs/ARCHITECTURE.md §2.5, §3.8):
// terminal bytes both ways, control of the lab and of time, and the editor protocol. Every message
// is plain data (structured clone).

import type { Checkpoint, GapEvent, LoggedInput, Millis, SessionLog, ViewModel } from '@simlab/kernel';
import type { EditorRequest } from '@simlab/host';
import type { GradeReport, RenderedFigure } from '@simlab/learn';

/** What the page keeps in browser storage to resume an attempt by replay (§2.8). */
export interface StoredAttempt {
  v: 1;
  /** The attempt's id in the progress log and the name of its input log on the server; the page adds it. */
  id?: string;
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

/**
 * A text of the content: English, and Vietnamese where the item's sidecar has a current
 * translation of it. `gap` says why not, for an item that has a sidecar (docs/LEARNING_MODEL.md §4).
 */
export interface Text {
  en: string;
  vi?: string;
  gap?: 'missing' | 'outdated';
}

/** A block of prose or a figure. A figure is drawn from the English item; `vi` is the same figure with its Vietnamese texts. */
export type PBlock = { text: Text } | { figure: RenderedFigure; vi?: RenderedFigure; gap?: 'missing' | 'outdated' } | { failed: { caption: string; alt: string; problems: string[] } };

/** What the learner says about an attempt; recorded in its log so it survives a reload. */
export type Note =
  /** Confidence before a check, 1 (guessing) to 5 (certain). */
  | { kind: 'confidence'; value: number }
  /** The root cause in the learner's words, before the debrief; empty when skipped. */
  | { kind: 'explanation'; text: string }
  /** The answer to a lesson's prediction prompt: a choice, or free text. */
  | { kind: 'prediction'; step: number; choice?: number; text?: string };

/** A lesson's step as the page shows it (docs/LEARNING_MODEL.md §2.1). */
export type LessonStep =
  | { kind: 'text'; text: Text }
  | { kind: 'figure'; block: PBlock }
  | { kind: 'predict'; prompt: Text; choices?: Text[]; answer?: number; explain: Text }
  | { kind: 'task'; text: Text; hintCount: number };

/** How a card is answered (§2.2), and its expected answer. */
export interface CardInfo {
  way: 'self' | 'choice' | 'command';
  choices?: Text[];
  correct?: number;
  answer: Text;
}

export type ToWorker =
  | { type: 'start'; item: string; seed: number; startTime: Millis; resume?: StoredAttempt }
  | { type: 'tty.open'; req: number; cols: number; rows: number }
  | { type: 'tty.bytes'; tty: string; data: string }
  | { type: 'tty.resize'; tty: string; cols: number; rows: number }
  | { type: 'tty.close'; tty: string }
  | { type: 'editor.save'; session: string; content: string }
  | { type: 'editor.close'; session: string }
  /** `step` names a lesson's guided task for `check` and `hint`. */
  | { type: 'lab'; req: number; action: LabAction; step?: number }
  | { type: 'note'; note: Note }
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
  kind: 'lab' | 'drill' | 'incident' | 'lesson' | 'card';
  title: Text;
  seed: number;
  targetMinutes: number;
  difficulty: number;
  /** Prose and rendered figures (figures of the start world, built when the attempt starts). A card's prompt and figure. */
  ticket: PBlock[];
  hintCount: number;
  /** The checks' titles by id, of every task for a lesson: a report carries the English ones. */
  checkTitles: Record<string, Text>;
  /** Whether the item has a sidecar, and whether every unit in it is current. */
  translation: 'none' | 'partial' | 'full';
  steps?: LessonStep[];
  card?: CardInfo;
  /** False for a card with no world: there is no terminal and nothing to resume. */
  world: boolean;
  /** For gap records: the page does not load the engine packages. */
  engine: { version: string; kubernetes: string };
}

/** The lab's state as the learner has seen it: survives a reload through the log's lab actions. */
/** One guided task of a lesson. */
export interface TaskState {
  hints: Text[];
  passed: boolean;
  report?: GradeReport;
}

export interface LabState {
  hints: Text[];
  /** Every check passed at some point; for a lesson, every guided task did. */
  solved: boolean;
  solutionViewed: boolean;
  debriefSeen: boolean;
  report?: GradeReport;
  /** The last confidence given, and the root cause as the learner wrote it (empty: skipped). */
  confidence?: number;
  explanation?: string;
  /** A lesson's guided tasks and answered predictions, by step. */
  tasks?: Record<number, TaskState>;
  predictions?: Record<number, { choice?: number; text?: string }>;
  /** A lesson's figures drawn again after a task passed (a figure of `now` has changed), by step. */
  figures?: Record<number, PBlock>;
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
  | { action: 'check'; report: GradeReport; step?: number }
  | { action: 'hint'; hint?: { index: number; text: Text }; step?: number }
  /**
   * Prose and figures, rendered when asked for: `now` is the world at that moment. With them what
   * the debrief sets side by side: the commands the learner's shells remember, and the solutions.
   */
  | { action: 'debrief'; blocks: PBlock[]; history: string[]; solutions: SolutionText[] }
  | { action: 'solutions'; solutions: SolutionText[] }
  | { action: 'reset' };

/** A reference solution as commands. */
export interface SolutionText {
  name: Text;
  text: string;
}

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
  | { type: 'lab.result'; req: number; result: LabResult; state: LabState; clock: Clock }
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
