// Input log and replay (docs/ARCHITECTURE.md §2.8). A session is a header, a log of inputs stamped
// with virtual time and occasional world hashes. Replaying the log into a fresh world must give the
// same world; the checkpoints detect a replay that diverges.

import type { Json } from './json.ts';
import type { Kernel } from './kernel.ts';
import type { Input } from './registry.ts';
import type { Millis } from './civil.ts';

export interface SessionHeader {
  /** Content item id, absent for free play. */
  item?: string;
  topology: string;
  seed: number;
  /** Resolved parameters, for readability; recomputed on replay. */
  params?: Record<string, Json>;
  /** Becomes `clock.start`. */
  startTime: Millis;
  engine: string;
  /** Version pins of the domains in play, e.g. `{ kubernetes: 'v1.37.2' }`. Kept generic: the kernel names no domain. */
  versions?: Record<string, string>;
  /** Hash of the item source. */
  contentHash?: string;
}

export type LoggedInput = Input & { t: Millis };

export interface Checkpoint {
  t: Millis;
  /** How many inputs had been delivered when the hash was taken. */
  inputs: number;
  hash: string;
}

export interface SessionLog {
  v: 1;
  header: SessionHeader;
  inputs: LoggedInput[];
  /** Virtual time the session reached; replay runs to here after the last input. */
  end: Millis;
  checkpoints: Checkpoint[];
}

export interface SessionRecorder {
  readonly kernel: Kernel;
  /** Delivers an input at the kernel's current time and appends it to the log. */
  deliver(input: Input): void;
  /** Runs the events already due, then appends the world hash to the log. */
  checkpoint(): void;
  /** The log so far, with `end` set to the current virtual time. */
  log(): SessionLog;
}

/**
 * Logs the inputs delivered to `kernel`. With `from`, the recorder continues that log: the kernel
 * must be the world its replay reached (session resume, §2.8), and new inputs and checkpoints are
 * appended after the logged ones.
 */
export function createRecorder(kernel: Kernel, header: SessionHeader, from?: SessionLog): SessionRecorder {
  if (from && kernel.now < from.end) throw new RangeError(`the kernel is at ${kernel.now}, before the end of the log it continues (${from.end})`);
  const inputs: LoggedInput[] = from ? from.inputs.slice() : [];
  const checkpoints: Checkpoint[] = from ? from.checkpoints.slice() : [];
  return {
    kernel,
    deliver(input) {
      kernel.input(input);
      inputs.push({ ...input, t: kernel.now } as LoggedInput);
    },
    checkpoint() {
      kernel.runUntil(kernel.now);
      checkpoints.push({ t: kernel.now, inputs: inputs.length, hash: kernel.hash() });
    },
    log: () => ({
      v: 1,
      header: { ...header },
      inputs: inputs.slice(),
      end: kernel.now,
      checkpoints: checkpoints.slice(),
    }),
  };
}

export interface Divergence {
  checkpoint: Checkpoint;
  actual: string;
}

export interface ReplayResult {
  kernel: Kernel;
  /** The first checkpoint whose hash did not match, if any. Replay stops there. */
  diverged?: Divergence;
}

/**
 * Replays a log into the kernel `boot` builds from the header (a fresh world with the topology
 * applied). For each input: run until its time, deliver it; verify each checkpoint at the point it
 * was taken; finally run until `end`.
 */
export function replay(log: SessionLog, boot: (header: SessionHeader) => Kernel): ReplayResult {
  const kernel = boot(log.header);
  let delivered = 0;
  let cp = 0;
  const verify = (): Divergence | undefined => {
    for (;;) {
      const next = log.checkpoints[cp];
      if (next === undefined || next.inputs !== delivered) return undefined;
      // A checkpoint taken before the next input: its time lies between the two inputs.
      const following = log.inputs[delivered];
      if (following !== undefined && next.t > following.t) return undefined;
      kernel.runUntil(next.t);
      const actual = kernel.hash();
      cp++;
      if (actual !== next.hash) return { checkpoint: next, actual };
    }
  };
  let diverged = verify();
  for (const logged of log.inputs) {
    if (diverged) break;
    const { t, ...input } = logged;
    kernel.runUntil(t);
    kernel.input(input as Input);
    delivered++;
    diverged = verify();
  }
  if (!diverged) kernel.runUntil(log.end);
  return diverged ? { kernel, diverged } : { kernel };
}

export interface ReplayCursor {
  readonly kernel: Kernel;
  /** How many of the log's inputs have been delivered. */
  readonly delivered: number;
  /** The next input to deliver, if any. */
  readonly pending: LoggedInput | undefined;
  /** Runs to the next input's time and delivers it. False when none is left. */
  deliverNext(): boolean;
  /**
   * Runs the log forward to `t`: every input stamped at or before `t` is delivered at its time,
   * then the clock runs to `t` (never past the log's `end`, never backward).
   */
  seek(t: Millis): void;
}

/**
 * Steps through a log on `kernel`, which must be the world the log started from. For reading a
 * past moment of a session (the timeline, the debrief's replay): the kernel it runs on is a
 * second world, never the session's. No checkpoint is verified here; `replay` does that.
 */
export function createReplayCursor(log: SessionLog, kernel: Kernel, from = 0): ReplayCursor {
  // `from`: the kernel already holds the first `from` inputs (a cursor continued on a longer log).
  let delivered = from;
  const deliverNext = (): boolean => {
    const logged = log.inputs[delivered];
    if (logged === undefined) return false;
    const { t, ...input } = logged;
    kernel.runUntil(Math.max(t, kernel.now));
    kernel.input(input as Input);
    delivered++;
    return true;
  };
  return {
    kernel,
    get delivered() {
      return delivered;
    },
    get pending() {
      return log.inputs[delivered];
    },
    deliverNext,
    seek(t) {
      const to = Math.min(t, log.end);
      for (let next = log.inputs[delivered]; next !== undefined && next.t <= to; next = log.inputs[delivered]) deliverNext();
      if (to > kernel.now) kernel.runUntil(to);
    },
  };
}
