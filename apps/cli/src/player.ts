// The terminal player's core, without the real terminal: a world from a topology, one terminal
// on it, the interactive time driver (virtual time follows the wall clock), the recorder that
// logs every input with its virtual time, and the editor protocol answered by a real editor.
// play.ts connects it to the user's terminal; tests drive it with a fake clock.

import { createInteractiveDriver, createRecorder, replay, type Entry, type GapEvent, type Json, type Kernel, type Ports, type SessionHeader, type SessionLog } from '@simlab/kernel';
import type { EditorRequest, HostSlice } from '@simlab/host';
import { boot, header } from './world.ts';

export interface PlayerIo {
  /** Bytes for the user's terminal. */
  write(data: string): void;
  /** A message from the player itself (not from the simulated machine). */
  note(message: string): void;
  /** Edits the content in a real editor and returns the result; blocks until the editor exits. */
  edit(req: EditorRequest): string;
  gap(record: GapEvent): void;
  /** A monotonic clock in milliseconds. */
  now(): number;
}

/** How a player gets its world: a header for the log and a function that builds the world. */
export interface PlayerWorld {
  header: SessionHeader;
  start(ports: Ports): { kernel: Kernel; entry: Entry };
}

export interface PlayerOptions {
  topology: string;
  seed: number;
  cols: number;
  rows: number;
  /** Virtual time per real time; default 1. */
  speed?: number;
  /** A world other than the bare topology: a content item's session (`npm run lab`). */
  world?: PlayerWorld;
}

export interface Player {
  readonly kernel: Kernel;
  readonly tty: string;
  /** Bytes typed by the user. */
  keys(data: string): void;
  /** Lets virtual time catch up with the wall clock. */
  tick(): void;
  resize(cols: number, rows: number): void;
  /** The shell of the terminal has exited (`exit`, Ctrl-D). */
  readonly ended: boolean;
  /** Takes a final checkpoint and returns the session log. */
  finish(): SessionLog;
  /** Logs a `learn.action` input (hint shown, check pressed), which changes nothing in the world. */
  action(action: string, data?: Json): void;
}

export const TTY = 'tty1';

/**
 * The player's terminal id: `tty1`, or the first one free. A content item's setup logs in through
 * terminals of its own (docs/SCENARIO_FORMAT.md §6.2), whose closed records stay in the world.
 */
export function freeTty(world: { slices: Record<string, unknown> }): string {
  const ttys = (world.slices['host'] as HostSlice).ttys;
  let n = 1;
  while (ttys[`tty${n}`]) n++;
  return `tty${n}`;
}

export function createPlayer(opts: PlayerOptions, io: PlayerIo): Player {
  const pending: { session: string; request: EditorRequest }[] = [];
  const h = opts.world?.header ?? header(opts.topology, opts.seed);
  const start = opts.world?.start ?? ((ports: Ports) => {
    const b = boot(h, ports);
    return { kernel: b.kernel, entry: b.info.entry };
  });
  let tty = TTY;
  const { kernel, entry } = start({
    output(r) {
      if (r.kind === 'tty') {
        if (r.tty === tty) io.write(r.data);
      } else if (r.kind === 'editor.open') {
        if (r.tty === tty) pending.push({ session: r.session, request: r.request as unknown as EditorRequest });
      } else if (!r.ok) io.note(r.message ?? 'the file could not be saved');
    },
    gap: (g) => io.gap(g),
  });
  const recorder = createRecorder(kernel, h);
  const driver = createInteractiveDriver(recorder, { speed: opts.speed ?? 1 });
  let last = io.now();
  const elapsed = (): number => {
    const t = io.now();
    const d = Math.max(0, t - last);
    last = t;
    return d;
  };

  /** Editor requests are answered after the kernel call that raised them has returned. */
  const answerEditors = (): void => {
    while (pending.length > 0) {
      const e = pending.shift() as (typeof pending)[number];
      const content = io.edit(e.request);
      // The time spent in the editor passes in the simulated world too.
      if (content !== e.request.content) driver.deliver({ kind: 'editor.save', session: e.session, content }, elapsed());
      driver.deliver({ kind: 'editor.close', session: e.session }, elapsed());
    }
  };

  tty = freeTty(kernel.world);
  driver.deliver({ kind: 'tty.open', tty, machine: entry.machine, user: entry.user, cols: opts.cols, rows: opts.rows }, 0);
  answerEditors();

  const shellPid = (): string | undefined => (kernel.world.slices['host'] as HostSlice).ttys[tty]?.session;
  return {
    kernel,
    tty,
    keys(data) {
      driver.deliver({ kind: 'tty.bytes', tty, data }, elapsed());
      answerEditors();
    },
    tick() {
      driver.tick(elapsed());
      answerEditors();
    },
    resize(cols, rows) {
      driver.deliver({ kind: 'tty.resize', tty, cols, rows }, elapsed());
      answerEditors();
    },
    get ended() {
      const host = kernel.world.slices['host'] as HostSlice;
      const pid = shellPid();
      const p = pid === undefined ? undefined : host.machines[entry.machine]?.procs[pid];
      return !p || p.state !== 'running';
    },
    finish() {
      driver.tick(elapsed());
      recorder.checkpoint();
      return recorder.log();
    },
    action(action, data) {
      driver.deliver(data === undefined ? { kind: 'learn.action', action } : { kind: 'learn.action', action, data }, elapsed());
    },
  };
}

export interface ReplayOutcome {
  /** The world hash the replay reached. */
  hash: string;
  /** The hash the recording ended with (its last checkpoint). */
  recorded: string | undefined;
  /** Set when a checkpoint did not match: the replay stopped there. */
  divergedAt?: number;
}

/**
 * Replays a recorded session into a fresh world, writing its terminal output. `start` builds the
 * world for headers that name a content item.
 */
export function replaySession(log: SessionLog, write: (data: string) => void, start?: (h: SessionHeader, ports: Ports) => Kernel): ReplayOutcome {
  const opened = log.inputs.find((i) => i.kind === 'tty.open');
  const tty = opened?.kind === 'tty.open' ? opened.tty : TTY;
  const ports: Ports = {
    output(r) {
      if (r.kind === 'tty' && r.tty === tty) write(r.data);
    },
  };
  const result = replay(log, (h) => (start ? start(h, ports) : boot(h, ports).kernel));
  const out: ReplayOutcome = { hash: result.kernel.hash(), recorded: log.checkpoints[log.checkpoints.length - 1]?.hash };
  if (result.diverged) out.divergedAt = result.diverged.checkpoint.t;
  return out;
}
