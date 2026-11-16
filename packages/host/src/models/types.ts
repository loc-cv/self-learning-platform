// Behavior models (PLAN.md §6.3, docs/BEHAVIOR_MODELS.md): nothing really executes, so a program
// that "runs" in a container (and, from phase 25a, in a systemd unit) is a model. A model is a pure
// state machine over plain data: given the process's resolved argv and environment it says what
// the process writes, when it wakes up next, whether it exits, execs another program or waits, and
// how it answers signals. The caller (the container runtime) owns time: it stores the model's state
// in world data, schedules the wake-ups and writes the output where the process's streams go.
//
// Models are contributed through the registry under BEHAVIOR_MODEL, one per program, keyed by the
// name the image's file table maps an executable to (`sh`, `sleep`, `nginx`).

import type { Contribution, Json, Millis } from '@simlab/kernel';

/** Registry contribution kind of program models. */
export const BEHAVIOR_MODEL = 'host.behavior-model';

/** A resolved executable: what execve(2) would run. */
export interface Executable {
  /** Absolute path as found (after the PATH search), not following symlinks: `/bin/sh`. */
  path: string;
  /** The program model that implements it; `unmodeled` when the file exists but no model does. */
  model: string;
  /**
   * Which implementation the file is, for models whose texts differ between them: `busybox`
   * (applets of a multi-call binary), `gnu` (coreutils), `dash`, `bash`.
   */
  variant: string;
}

/** Everything a model may read. Pure: the same input gives the same step. */
export interface ProcessInput {
  /** argv as passed to execve: argv[0] is what the caller wrote (`sh`, `/bin/sh`). */
  argv: string[];
  /** The environment, in the order the process received it. */
  env: [string, string][];
  /** The executable being run. */
  exe: Executable;
  pid: number;
  /**
   * PID 1 of its PID namespace. The kernel does not deliver signals whose action is the default to
   * such a process (pid_namespaces(7)), so an init without handlers ignores SIGTERM.
   */
  init: boolean;
  hostname: string;
  /** Online CPUs the process sees (sysconf(_SC_NPROCESSORS_ONLN): the machine's, not the cgroup limit). */
  cpus: number;
  /** Virtual time now, ms since the epoch. */
  now: Millis;
  /** execvp(3)'s lookup with this process's PATH; undefined when no such file exists. */
  which(name: string): Executable | undefined;
  /** A file of the process's filesystem that a model reads (scripts, configuration); undefined if absent. */
  file(path: string): string | undefined;
}

export type OutputStream = 'stdout' | 'stderr';

export interface Output {
  /** Delay from the step's start; non-decreasing within a step and at most the next wake. */
  after?: Millis;
  stream: OutputStream;
  /** Bytes as text; lines end in `\n`, a trailing partial line continues in the next output. */
  text: string;
}

export interface Listener {
  port: number;
  protocol: 'tcp' | 'udp';
}

/** A gap the model hit: input it cannot simulate (docs/FIDELITY.md, the gap log). */
export interface ModelGap {
  what: string;
  detail?: string;
}

export type Next =
  /** Call `resume` after `wake` ms with this state. */
  | { wake: Millis; state: Json }
  /** Keep running with nothing to do until a signal arrives. */
  | { wait: true; state: Json }
  /** Exit with this status, `after` ms from the step's start. */
  | { exit: number; after?: Millis }
  /** Replace the process image (execve), `after` ms from the step's start. */
  | { exec: { exe: Executable; argv: string[]; env?: [string, string][] }; after?: Millis };

export interface ModelStep {
  output?: Output[];
  next: Next;
  /** Sockets it listens on from now on; absent keeps the previous list. */
  listen?: Listener[];
  gaps?: ModelGap[];
}

/** Catchable signals the runtime delivers. SIGKILL never reaches a model. */
export type Signal = 'SIGTERM' | 'SIGINT' | 'SIGQUIT' | 'SIGHUP' | 'SIGUSR1' | 'SIGUSR2' | 'SIGWINCH';

/** Signal numbers on Linux x86-64 (signal(7)): exit status 128+n when a signal kills a process. */
export const SIGNAL_NUMBERS: Readonly<Record<Signal | 'SIGKILL', number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGTERM: 15,
  SIGWINCH: 28,
};

/** Signals whose default action is to ignore them (signal(7)). */
const IGNORED_BY_DEFAULT: ReadonlySet<string> = new Set(['SIGWINCH', 'SIGCHLD', 'SIGURG']);

export interface ProgramModel extends Contribution {
  /** The name the file tables use: `sh`, `sleep`, `nginx`. */
  name: string;
  start(p: ProcessInput): ModelStep;
  /** After a `wake`. */
  resume(p: ProcessInput, state: Json): ModelStep;
  /**
   * A signal arrives while the model runs. `'default'` means the program installed no handler: the
   * runtime then applies the default action (terminate with 128+n, ignore for an init process).
   */
  signal?(p: ProcessInput, state: Json, signal: Signal): ModelStep | 'default';
}

/** The default action of `signal` for a process without a handler: terminated, or nothing. */
export function defaultSignalAction(signal: Signal, init: boolean): { exit: number } | undefined {
  if (init || IGNORED_BY_DEFAULT.has(signal)) return undefined;
  return { exit: 128 + SIGNAL_NUMBERS[signal] };
}
