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
 * Terminal settings the line discipline acts on: a subset of termios(3) `c_lflag`. `stty sane` on
 * Linux sets all of them, and a new terminal starts that way.
 */
export interface TtyMode {
  /** ICANON: input is assembled into lines, with ERASE, KILL, WERASE and EOF. */
  icanon: boolean;
  /** ECHO: input is echoed, control characters as `^X` (ECHOCTL), erasures visually (ECHOE, ECHOKE). */
  echo: boolean;
  /** ISIG: INTR (Ctrl-C), QUIT (Ctrl-\\) and SUSP (Ctrl-Z) become signals. */
  isig: boolean;
}

/**
 * A terminal (docs/ARCHITECTURE.md §3.6): the line discipline's state, plus the line editor while a
 * program reads a line with editing. Output is not kept: it leaves through the output port.
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
  mode: TtyMode;
  /** Canonical mode: completed input not yet read (lines, or text ended by EOF). */
  input: string;
  /** End-of-file marks (Ctrl-D) in `input`: each makes one read return what precedes it, or end of file. */
  eof: number[];
  /** Canonical mode: the line being typed, which a read cannot see yet. */
  line: string;
  /**
   * Bytes that arrived while the line editor was reading without echo, after it finished its line:
   * the next reader gets them unprocessed (typeahead after Enter in a paste).
   */
  typeahead: string;
  /** The line editor, while a program reads a line with editing (tty/editor.ts). */
  editor?: LineEditorState;
  /** Readline's state that outlives one line: the kill ring and the last search string. */
  readline: { kill: string; lastSearch: string };
  /** Set by `tty.close`: the terminal is gone; reads return end of file and output is dropped. */
  closed?: true;
}

/** What a program asks for when it reads a line with editing (the shell at its prompt). */
export interface EditRequest {
  /** The prompt as decoded, with non-printing parts between \x01 and \x02 (readline's markers). */
  prompt: string;
  /** History, oldest first. */
  history: readonly string[];
  /** Registry name of the completer for Tab (`completion` contributions) and the data it needs. */
  completer?: { name: string; data: Json };
}

/** The line editor's state: plain data, advanced one key at a time by tty/editor.ts. */
export interface LineEditorState {
  /** The reading process. */
  pid: string;
  prompt: string;
  buffer: string;
  /** Cursor position in `buffer` (UTF-16 index, always at a code point boundary). */
  cursor: number;
  history: readonly string[];
  /** History position: `history.length` is the line being typed. */
  hist: number;
  /** Lines changed while browsing history, by position, including the new line (`history.length`). */
  edits: Record<string, string>;
  /** Bytes of an incomplete key sequence. */
  keys: string;
  /** The previous command, for repeated kills, double Tab and repeated yank-last-arg. */
  last?: string;
  /** Repeated yank-last-arg: how far back it reached, and what it inserted. */
  lastArg?: { back: number; start: number; end: number };
  /** Ctrl-R in progress. */
  search?: { query: string; failed: boolean; hist: number; pos: number; saved: { buffer: string; cursor: number; hist: number } };
  /** Waiting for an answer: "Display all N possibilities? (y or n)" or the `--More--` pager. */
  ask?: { kind: 'display'; items: string[]; dirs: boolean[]; filenames: boolean } | { kind: 'more'; lines: string[]; next: number };
  completer?: { name: string; data: Json };
  /** Set when the line is complete: what the read returns (null: end of file). */
  done?: { line: string | null };
}
