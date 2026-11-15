// The shell's session state: plain data, so an interactive shell waiting at its prompt is
// quiescent (docs/ARCHITECTURE.md §3.4) and a subshell receives a copy through its spawn data.

import type { Json } from '@simlab/kernel';

export interface ShellVar {
  value?: string;
  exported?: true;
  /** Creation order; with the name's hash bucket it decides the order of the exported environment. */
  seq: number;
}

export interface ShellState {
  vars: Record<string, ShellVar>;
  /** Next creation sequence number for a variable. */
  varSeq: number;
  aliases: Record<string, string>;
  /** $0 */
  arg0: string;
  /** $1 … */
  positional: string[];
  /** $? */
  status: number;
  pipestatus: number[];
  interactive: boolean;
  login: boolean;
  /** `-c` (string), `script` (a file), `stdin` (commands from standard input). */
  source: 'c' | 'script' | 'stdin';
  history: string[];
  /** The command hash table (bash(1) `hash`): name → path, with the number of uses. */
  hash: Record<string, { path: string; hits: number }>;
  /** $$: the top-level shell's pid, unchanged in subshells. */
  shellPid: string;
  /** $PPID of the top-level shell. */
  ppid: string;
  /** Virtual time the shell started, for SECONDS. */
  startedAt: number;
  /** Started with --noediting: an interactive shell reads lines without readline. */
  noediting?: boolean;
}

/**
 * bash's hash function for its variable table: FNV-1, 32 bits.
 * reference: bash 5.2.21 lists exported variables in the order of this hash modulo 1024 buckets,
 * newest first within a bucket (checked against `env` output for 15 names, 2026-11-16);
 * upstream bash hashlib.c hash_string, variables.h VARIABLES_HASH_BUCKETS.
 */
function fnv1(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h, 16777619) >>> 0;
    h = (h ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

const BUCKETS = 1024;

/** Names of exported, set variables in the order bash passes them to a program. */
export function exportOrder(state: ShellState): string[] {
  const names = Object.keys(state.vars).filter((n) => state.vars[n]?.exported && state.vars[n]?.value !== undefined);
  return names.sort((a, b) => {
    const d = (fnv1(a) % BUCKETS) - (fnv1(b) % BUCKETS);
    if (d !== 0) return d;
    return (state.vars[b]?.seq ?? 0) - (state.vars[a]?.seq ?? 0);
  });
}

/**
 * Changing PATH empties the command hash table (bash 5.2 variables.c sv_path → phash_flush).
 * reference: bash 5.2.21: after `clear; PATH=$HOME/bin`, `clear` is "command not found"
 * (fixtures/reference/bash/readline.json `reverse-search`, the setup line run again).
 */
function pathChanged(state: ShellState, name: string): void {
  if (name === 'PATH') state.hash = {};
}

export function setVar(state: ShellState, name: string, value: string, opts: { export?: boolean } = {}): void {
  pathChanged(state, name);
  const cur = state.vars[name];
  if (cur) {
    cur.value = value;
    if (opts.export) cur.exported = true;
  } else {
    const v: ShellVar = { value, seq: state.varSeq++ };
    if (opts.export) v.exported = true;
    state.vars[name] = v;
  }
}

export function getVar(state: ShellState, name: string): string | undefined {
  return state.vars[name]?.value;
}

export function unsetVar(state: ShellState, name: string): void {
  pathChanged(state, name);
  delete state.vars[name];
}

export function exportVar(state: ShellState, name: string): void {
  const cur = state.vars[name];
  if (cur) cur.exported = true;
  else state.vars[name] = { exported: true, seq: state.varSeq++ };
}

/** A deep copy, for a subshell or a restart point. */
export function cloneState(state: ShellState): ShellState {
  return JSON.parse(JSON.stringify(state)) as ShellState;
}

export function stateToJson(state: ShellState): Json {
  return cloneState(state) as unknown as Json;
}
