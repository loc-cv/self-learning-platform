// bash's half of Tab completion: what the word at the cursor can become. readline's half (finding
// the word, quoting, the common prefix, lists) is tty/complete.ts.
//   docs: bash(1) 5.2 READLINE "Completing" and "Programmable Completion": a word in command
//         position completes aliases, reserved words, builtins and executables in PATH; a word
//         starting with `$` completes variable names, with `~` user names; anything else file names.
//   reference: bash 5.2.21, fixtures/reference/bash/readline.json (`complete-*` cases): command
//         completion marks a match that names a directory, which is how the builtin `.` shows as
//         `./`; file name completion lists hidden files too (match-hidden-files on) but not `.`
//         and `..` for an empty word.
//
// bash-completion, which Ubuntu's ~/.bashrc loads, replaces some of this per command. Until
// startup files are read (phase 22a) its behaviour is reproduced by completers: a program's own
// `complete` (ProgramSpec) and the builtin completers below.

import type { Json } from '@simlab/kernel';
import type { CompleterSpec, CompletionRequest, CompletionResult } from '../tty/complete.ts';
import { dequote } from '../tty/complete.ts';
import { getMachine } from '../machine.ts';
import { getProc } from '../proc/runtime.ts';
import { PROGRAM, type ProgramCompletion, type ProgramSpec } from '../proc/program.ts';
import { passwdEntries } from '../users.ts';
import { ACCESS, createFs, type Fs } from '../vfs/fs.ts';
import { BASH_BUILTINS, BASH_KEYWORDS } from './shell.ts';
import type { ShellState } from './state.ts';

interface BashCompletionData {
  vars: string[];
  aliases: string[];
  path: string;
}

/** What the shell hands the completer with each prompt: names it knows that the file system does not. */
export function completionData(state: ShellState): Json {
  const vars = Object.keys(state.vars).filter((n) => state.vars[n]?.value !== undefined).sort();
  return { vars, aliases: Object.keys(state.aliases).sort(), path: state.vars['PATH']?.value ?? '' };
}

const sortUnique = (xs: string[]): string[] => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Characters after which the next word is a command name. */
function inCommandPosition(before: string): boolean {
  const t = before.replace(/[ \t]+$/, '');
  if (t === '') return true;
  if (/(^|[^\\])[;|&(`{]$/.test(t) || t.endsWith('$(')) return true;
  const last = t.split(/[ \t;|&(]/).pop() ?? '';
  return ['then', 'do', 'else', 'elif', '!', 'time'].includes(last) && /(^|[;|&(\s])\S+$/.test(t);
}

function fsOf(req: CompletionRequest): Fs {
  const p = getProc(getMachine(req.ctx, req.machine), req.pid);
  return createFs(req.ctx, req.machine, { cred: { uid: p.uid, gid: p.gid, groups: p.groups }, cwd: p.cwd, umask: p.umask });
}

function isDir(fs: Fs, path: string): boolean {
  try {
    return fs.stat(path).type === 'dir';
  } catch {
    return false;
  }
}

function homeOf(req: CompletionRequest, user: string): string | undefined {
  if (user === '') {
    const p = getProc(getMachine(req.ctx, req.machine), req.pid);
    return p.env['HOME'] ?? passwdEntries(req.ctx, req.machine).find((e) => e.uid === p.uid)?.home;
  }
  return passwdEntries(req.ctx, req.machine).find((e) => e.name === user)?.home;
}

/** File names that start with `word` (readline's rl_filename_completion_function). */
export function fileMatches(req: CompletionRequest, word: string, keep: (path: string, dir: boolean) => boolean = () => true): CompletionResult {
  const fs = fsOf(req);
  const slash = word.lastIndexOf('/');
  const dirPart = slash < 0 ? '' : word.slice(0, slash + 1);
  const base = slash < 0 ? word : word.slice(slash + 1);
  let lookup = dirPart === '' ? '.' : dirPart;
  const tilde = /^~([^/]*)\//.exec(dirPart);
  if (tilde) {
    const home = homeOf(req, tilde[1] as string);
    if (home === undefined) return { matches: [] };
    lookup = home + dirPart.slice(tilde[0].length - 1);
  }
  let names: string[];
  try {
    names = fs.readdir(lookup);
  } catch {
    return { matches: [] };
  }
  if (base === '.' || base === '..') names = ['.', '..', ...names];
  const matches: string[] = [];
  const dirs: boolean[] = [];
  for (const n of names) {
    if (!n.startsWith(base)) continue;
    const full = lookup.endsWith('/') ? lookup + n : `${lookup}/${n}`;
    const dir = isDir(fs, full);
    if (!keep(full, dir)) continue;
    matches.push(dirPart + n);
    dirs.push(dir);
  }
  return { matches, dirs, filenames: true };
}

function commandMatches(req: CompletionRequest, data: BashCompletionData): CompletionResult {
  const word = req.word;
  const fs = fsOf(req);
  if (word.includes('/')) {
    // A path in command position: directories and executables only.
    return fileMatches(req, word, (path, dir) => {
      if (dir) return true;
      try {
        fs.access(path, ACCESS.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
  const names: string[] = [...data.aliases, ...BASH_KEYWORDS, ...BASH_BUILTINS].filter((n) => n.startsWith(word));
  for (const dir of data.path.split(':')) {
    const d = dir === '' ? '.' : dir;
    let entries: string[];
    try {
      entries = fs.readdir(d);
    } catch {
      continue;
    }
    for (const n of entries) {
      if (!n.startsWith(word)) continue;
      const full = `${d}/${n}`;
      try {
        if (fs.stat(full).type === 'dir') continue;
        fs.access(full, ACCESS.X_OK);
        names.push(n);
      } catch {
        // not executable
      }
    }
  }
  const matches = sortUnique(names);
  return { matches, dirs: matches.map((m) => isDir(fs, m)), filenames: true };
}

/** Builtins with a completer of their own, as bash-completion defines them. */
const BUILTIN_COMPLETERS: Record<string, (req: CompletionRequest, c: ProgramCompletion) => CompletionResult> = {
  // bash-completion 2.11 `complete -F _cd -o nospace cd pushd`: directories only (_filedir -d).
  cd: (req, c) => ({ ...fileMatches(req, c.cur, (_p, dir) => dir), nospace: true }),
  pushd: (req, c) => ({ ...fileMatches(req, c.cur, (_p, dir) => dir), nospace: true }),
};

/** The words of the command the cursor is in, up to the cursor, without quoting. */
function commandWords(line: string, start: number): { words: string[]; cword: number } {
  let seg = 0;
  let q: string | undefined;
  for (let i = 0; i < start; i++) {
    const ch = line[i] as string;
    if (q) {
      if (ch === q) q = undefined;
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') q = ch;
    else if (';|&('.includes(ch)) seg = i + 1;
  }
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  q = undefined;
  for (let i = seg; i < start; i++) {
    const ch = line[i] as string;
    if (!q && (ch === ' ' || ch === '\t')) {
      if (inWord) words.push(dequote(cur));
      cur = '';
      inWord = false;
      continue;
    }
    inWord = true;
    cur += ch;
    if (q) {
      if (ch === q) q = undefined;
    } else if (ch === '\\' && i + 1 < start) cur += line[++i];
    else if (ch === "'" || ch === '"') q = ch;
  }
  if (inWord) words.push(dequote(cur));
  return { words, cword: words.length };
}

function programCompletion(req: CompletionRequest, data: BashCompletionData): CompletionResult | undefined {
  const { words, cword } = commandWords(req.line, req.start);
  const name = words[0];
  if (name === undefined) return undefined;
  const c: ProgramCompletion = { ctx: req.ctx, machine: req.machine, pid: req.pid, words: [...words, req.word], cword, cur: req.word };
  const builtin = BUILTIN_COMPLETERS[name];
  if (builtin && !data.aliases.includes(name)) return builtin(req, c);
  // The program an external command runs: the stub its PATH entry points at.
  const fs = fsOf(req);
  for (const dir of name.includes('/') ? [''] : data.path.split(':')) {
    const path = name.includes('/') ? name : `${dir === '' ? '.' : dir}/${name}`;
    let program: string | undefined;
    try {
      const ino = fs.checkExec(path);
      program = ino.type === 'program' ? ino.program : undefined;
    } catch {
      continue;
    }
    if (program === undefined) return undefined;
    const spec = req.ctx.registry.get<ProgramSpec>(PROGRAM, program);
    return spec?.complete?.(c);
  }
  return undefined;
}

function complete(req: CompletionRequest): CompletionResult {
  const data = req.data as unknown as BashCompletionData;
  const word = req.word;
  const before = req.line.slice(0, req.start);
  const varm = /^(\$\{?)([A-Za-z_][A-Za-z0-9_]*)?$/.exec(word);
  if (varm) {
    const brace = varm[1] === '${';
    const prefix = varm[2] ?? '';
    return { matches: data.vars.filter((v) => v.startsWith(prefix)).map((v) => (brace ? `\${${v}}` : `$${v}`)) };
  }
  const user = /^~([^/]*)$/.exec(word);
  if (user) {
    const names = sortUnique(passwdEntries(req.ctx, req.machine).map((e) => e.name).filter((n) => n.startsWith(user[1] as string)));
    return { matches: names.map((n) => `~${n}`), dirs: names.map(() => true), filenames: true };
  }
  if (inCommandPosition(before)) return commandMatches(req, data);
  return programCompletion(req, data) ?? fileMatches(req, word);
}

export const bashCompleter: CompleterSpec = { name: 'bash', complete };
