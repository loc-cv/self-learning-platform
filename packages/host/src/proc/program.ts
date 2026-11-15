// The program interface (docs/ARCHITECTURE.md §3.4). A program is a synchronous generator: it
// performs blocking effects by yielding syscalls through the `ProcApi` helpers (used with
// `yield*`), and everything that cannot block (file system calls, opening descriptors, spawning)
// through plain methods. It returns its exit status.

import type { Contribution, Ctx, GapKind, Json, Millis, Random, TraceInput } from '@simlab/kernel';
import type { Fs } from '../vfs/fs.ts';
import type { Cred } from '../vfs/types.ts';
import type { ExitStatus, Fd, Proc } from './types.ts';

/** Registry kind of programs. */
export const PROGRAM = 'program';

export type Syscall =
  | { op: 'read'; fd: number; max?: number; line?: boolean }
  | { op: 'write'; fd: number; data: string }
  | { op: 'sleep'; ms: Millis }
  | { op: 'wait'; topic: string; timeout?: Millis }
  | { op: 'waitpid'; pid: string };

export type Op<T> = Generator<Syscall, T, unknown>;

export interface ProgramSpec extends Contribution {
  main(p: ProcApi): Generator<Syscall, number, unknown>;
  /** Recreates the program from `Proc.resume` at its restart point (§3.4). */
  restart?(p: ProcApi, resume: Json): Generator<Syscall, number, unknown>;
}

export interface SpawnRequest {
  /** Registry name of the program to run; an unregistered name runs the "not simulated" stub. */
  program: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Child descriptor → a parent descriptor number, or a descriptor value. Default: all of the parent's. */
  fds?: Record<string, number | Fd>;
  /** Process group: `new` makes the child a group leader. Default: the parent's. */
  pgid?: 'new' | string;
  /** `new` makes the child a session leader (a terminal's shell). */
  sid?: 'new';
  cred?: Cred;
  umask?: number;
  tty?: string;
  /** Handed to the child as `ProcApi.spawnData`. */
  data?: Json;
}

export interface OpenRequest {
  read?: boolean;
  write?: boolean;
  create?: boolean;
  truncate?: boolean;
  append?: boolean;
  exclusive?: boolean;
  mode?: number;
}

export interface GapRequest {
  kind: GapKind;
  /** The unsupported thing in the user's terms: `the flag -Z`, `the "for" loop`. */
  what: string;
  /** Lines pointing at what is supported instead. */
  hints?: string[];
  /** Overrides the program name in the notice (the shell reports as `bash`). */
  program?: string;
}

export interface ProcApi {
  readonly pid: string;
  readonly machine: string;
  /** The kernel context, for host functions that take one (users, machine lookups). */
  readonly ctx: Ctx;
  readonly argv: readonly string[];
  /** Base name of argv[0]: the name a program uses in its messages. */
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly now: Millis;
  /** The current process record. */
  readonly proc: Proc;
  readonly spawnData: Json | undefined;
  readonly cred: Cred;
  /** The file system as this process sees it: its credentials, working directory and umask. */
  fs(): Fs;
  random(stream: string): Random;
  trace(record: TraceInput): void;

  read(fd: number, opts?: { max?: number; line?: boolean }): Op<string | null>;
  write(fd: number, data: string): Op<void>;
  sleep(ms: Millis): Op<void>;
  wait(topic: string, timeout?: Millis): Op<'published' | 'timeout'>;
  waitpid(pid: string): Op<ExitStatus>;
  /** Prints the `[sim]` notice, records the gap and ends the program with status 250. */
  unsupported(gap: GapRequest): Op<never>;

  spawn(req: SpawnRequest): string;
  /** open(2) and install at the lowest free descriptor; returns it. Throws `FsError`. */
  open(path: string, flags: OpenRequest): number;
  /** Opens and installs at descriptor `n`, closing what `n` held. */
  openAt(n: number, path: string, flags: OpenRequest): void;
  close(n: number): void;
  /** Installs at descriptor `n` the read end of a pipe that holds `data` and has no writer. */
  openData(n: number, data: string): void;
  /** dup2(2). Throws EBADF when `from` is not open. */
  dup2(from: number, to: number): void;
  /** pipe(2): returns [read end, write end]. */
  pipe(): [number, number];
  fd(n: number): Fd | undefined;
  isatty(n: number): boolean;
  /** Size of the controlling terminal. */
  winsize(): { cols: number; rows: number } | undefined;
  /** tcsetpgrp(3) on the controlling terminal. */
  setForeground(pgid: string): void;
  kill(pid: string, sig: number): void;
  killGroup(pgid: string, sig: number): void;
  /** Sets the working directory; the caller has checked it (chdir(2) checks are the shell's job). */
  setCwd(path: string): void;
  setEnv(env: Record<string, string>): void;
  setUmask(mask: number): void;
  /** Marks the process as at a restart point (data) or not (undefined). */
  setResume(data: Json | undefined): void;
  trap(sig: number, disposition: 'ignore' | 'interrupt' | 'default'): void;
  /** Ends the program now with `code`. */
  exit(code: number): never;
  /** Replaces this process's program (execve(2)); does not return. */
  exec(req: { program: string; argv: string[]; env: Record<string, string>; data?: Json }): never;
}
