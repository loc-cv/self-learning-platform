// Processes, descriptors, open files, streams and terminals as world data
// (docs/ARCHITECTURE.md §3.3–§3.6). Every record here is a frozen value in a table; a change stores
// a new record. Program coroutine frames are not here: they live in the runtime (runtime.ts).

import type { Json, Millis } from '@simlab/kernel';

export type ExitStatus = { code: number } | { signal: number };

/** A file descriptor: what one slot of a process's descriptor table refers to. */
export type Fd =
  | { kind: 'stream'; stream: string; end: 'read' | 'write' }
  | { kind: 'tty'; tty: string }
  | { kind: 'file'; file: string };

/** What a blocked process waits for, as data (§3.4). */
export interface WaitState {
  /** Topic the process is subscribed to, with the waiter id to withdraw. */
  topic?: string;
  waiter?: string;
  /** Pending wake-up event (a sleep or a timeout). */
  timer?: string;
}

export interface Proc {
  pid: string;
  ppid: string;
  pgid: string;
  sid: string;
  uid: number;
  gid: number;
  groups: number[];
  argv: string[];
  /** Registry name of the program the process runs. */
  image: string;
  cwd: string;
  env: Record<string, string>;
  umask: number;
  /** Controlling terminal. */
  tty?: string;
  startedAt: Millis;
  state: 'running' | 'zombie';
  exit?: ExitStatus;
  /** Descriptor number (as a string) → descriptor. */
  fds: Record<string, Fd>;
  wait?: WaitState;
  /** A signal waiting to be acted on at the next run slice. */
  signal?: number;
  /**
   * Dispositions other than the default, by signal number: ignored, or turned into an
   * `Interrupted` error thrown at the blocked syscall. Reset at spawn, as execve(2) resets caught
   * signals (ignoring is inherited by a subshell through its own request).
   */
  traps?: Record<string, 'ignore' | 'interrupt'>;
  /** For a program at a restart point: what `restart` needs to recreate it (§3.4). */
  resume?: Json;
  /** Data handed to the program by its parent at spawn (a subshell's command, for one). */
  spawnData?: Json;
}

/** An open file description (open(2)): shared by descriptors duplicated from one open. */
export interface OpenFile {
  id: string;
  inode: string;
  /** Offset in UTF-16 code units of the stored text. */
  offset: number;
  read: boolean;
  write: boolean;
  append: boolean;
  /** Descriptors that refer to this description, across processes. */
  refs: number;
}

/** A pipe (pipe(7)): bytes written at one end are read at the other, in order. */
export interface Stream {
  id: string;
  machine: string;
  /** Unread data. */
  data: string;
  /** A writer blocks while `data` is at least this long. */
  capacity: number;
  /** Open read ends and write ends, across processes. */
  readers: number;
  writers: number;
}

/**
 * A terminal. Phase 02 models only what the shell and programs need: input queued as bytes, end of
 * file from Ctrl-D, Ctrl-C as SIGINT to the foreground process group, and output with `onlcr`.
 * Phase 03 adds the line editor, echo and modes (§3.6).
 */
export interface Tty {
  id: string;
  machine: string;
  cols: number;
  rows: number;
  /** Session leader pid. */
  session: string;
  /** Foreground process group. */
  foreground: string;
  /** Input received and not yet read. */
  input: string;
  /** End-of-file marks (Ctrl-D) waiting: each makes one read return what precedes it, or end of file. */
  eof: number[];
}
