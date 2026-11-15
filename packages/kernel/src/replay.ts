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

export function createRecorder(kernel: Kernel, header: SessionHeader): SessionRecorder {
  const inputs: LoggedInput[] = [];
  const checkpoints: Checkpoint[] = [];
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
