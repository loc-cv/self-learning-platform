// grep — print lines that match patterns. GNU grep 3.11.
//   docs: grep --help and grep(1) of grep 3.11
//   upstream: grep 3.11 src/grep.c main, grep_command_line_arg, grepfile, grepdesc, grepdirent,
//             skipped_file, context_length_arg, get_nondigit_option, setmatcher
//   reference: grep 3.11, captured 2026-11-16 (packages/host/transcripts/grep/*.t)
// Standard input is read as it arrives, so `tail -f log | grep x` prints each match when the line
// comes in. Directories are traversed in sorted order (real grep uses the directory's own order,
// docs/FIDELITY.md). -P, -T and -X print the `[sim]` notice.

import { getMachine } from '../../machine.ts';
import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import type { Inode } from '../../vfs/types.ts';
import { isFsError, strerror, type FsError } from '../../vfs/errno.ts';
import { getopt } from '../lib/getopt.ts';
import { readAll } from '../lib/io.ts';
import { quote } from '../lib/quote.ts';
import { colorsFromEnv, sgrEnd, sgrStart, type Colors } from './colors.ts';
import { excludeFileRules, excluded, type ExcludeRule } from './exclude.ts';
import { compilePatterns, type PatternLine } from './matcher.ts';
import { HELP, OPTIONS, USAGE } from './options.ts';
import { createOutput, searchInput, type Output, type RunState, type SearchConfig } from './search.ts';

const INTMAX = Number.MAX_SAFE_INTEGER;

/** xstrtoimax with no suffixes: optional blanks and sign, decimal digits; overflow saturates. */
function parseIntmax(s: string): number | undefined {
  const m = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/.exec(s);
  if (!m) return undefined;
  const n = Math.min(Number(m[2]), INTMAX);
  return m[1] === '-' ? -n : n;
}

/** The inode behind descriptor `n`, when it is an open file. */
function fdInode(p: ProcApi, n: number): { ino: string; type: Inode['type'] } | undefined {
  const fd = p.fd(n);
  if (fd?.kind !== 'file') return undefined;
  const m = getMachine(p.ctx, p.machine);
  const f = m.files[fd.file];
  const i = f ? m.vfs.inodes[f.inode] : undefined;
  return f && i ? { ino: f.inode, type: i.type } : undefined;
}

/** gnulib argmatch: an exact value or an unambiguous abbreviation of one. */
function argmatch(value: string, valid: readonly string[]): string | 'invalid' | 'ambiguous' {
  if (valid.includes(value)) return value;
  const c = valid.filter((v) => v.startsWith(value));
  return c.length === 1 ? (c[0] as string) : c.length === 0 ? 'invalid' : 'ambiguous';
}

interface Options {
  matcher?: 'G' | 'E' | 'F';
  keys: PatternLine[];
  keysGiven: boolean;
  icase: boolean;
  word: boolean;
  line: boolean;
  eol: string;
  suppressErrors: boolean;
  invert: boolean;
  maxCount: number;
  byteOffset: boolean;
  lineNumbers: boolean;
  lineBuffered: boolean;
  /** -H 1, -h -1, neither 0. */
  filenameOption: number;
  label: string;
  onlyMatching: boolean;
  quiet: boolean;
  binaryFiles: 'binary' | 'text' | 'without-match';
  directories: 'read' | 'recurse' | 'skip';
  devices: 'read' | 'skip' | 'read-command-line';
  /** -r or -R was given (not just -d recurse): no operand means `.`. */
  recursiveFlag: boolean;
  dereference: boolean;
  fileRules: ExcludeRule[];
  dirRules: ExcludeRule[];
  listFiles: 'none' | 'matching' | 'nonmatching';
  countMatches: boolean;
  nullAfterName: boolean;
  before: number;
  after: number;
  context: number;
  groupSeparator: string | undefined;
  color: 0 | 1 | 2;
  showHelp: boolean;
  /** The version option as typed, when given. */
  showVersion: string | undefined;
}

/** Ends grep with status 2 and `grep: message` (die). */
class Die {
  readonly message: string;
  readonly status: number;
  constructor(message: string, status = 2) {
    this.message = message;
    this.status = status;
  }
}

function* readPatternFile(p: ProcApi, name: string): Op<string> {
  if (name === '-') return yield* readAll(p, 0);
  try {
    p.openAt(3, name, { read: true });
  } catch (e) {
    if (isFsError(e)) throw new Die(`${name}: ${strerror(e.code)}`);
    throw e;
  }
  try {
    return yield* readAll(p, 3);
  } catch (e) {
    if (isFsError(e)) throw new Die(`${name}: ${strerror(e.code)}`);
    throw e;
  } finally {
    p.close(3);
  }
}

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
};

function* readOptions(p: ProcApi, parsed: { id: string; value?: string; name: string }[]): Op<Options> {
  const o: Options = {
    keys: [],
    keysGiven: false,
    icase: false,
    word: false,
    line: false,
    eol: '\n',
    suppressErrors: false,
    invert: false,
    maxCount: -1,
    byteOffset: false,
    lineNumbers: false,
    lineBuffered: false,
    filenameOption: 0,
    label: '(standard input)',
    onlyMatching: false,
    quiet: false,
    binaryFiles: 'binary',
    directories: 'read',
    devices: 'read-command-line',
    recursiveFlag: false,
    dereference: false,
    fileRules: [],
    dirRules: [],
    listFiles: 'none',
    countMatches: false,
    nullAfterName: false,
    before: -1,
    after: -1,
    context: -1,
    groupSeparator: '--',
    color: 0,
    showHelp: false,
    showVersion: undefined,
  };
  /** upstream: grep.c context_length_arg */
  const contextArg = (s: string): number => {
    const n = parseIntmax(s);
    if (n === undefined || n < 0) throw new Die(`${s}: invalid context length argument`);
    return n;
  };
  const setMatcher = (m: 'G' | 'E' | 'F'): void => {
    if (o.matcher !== undefined && o.matcher !== m) throw new Die('conflicting matchers specified');
    o.matcher = m;
  };
  for (let k = 0; k < parsed.length; k++) {
    const opt = parsed[k] as { id: string; value?: string; name: string };
    const v = opt.value ?? '';
    switch (opt.id) {
      case 'basic-regexp':
        setMatcher('G');
        break;
      case 'extended-regexp':
        setMatcher('E');
        break;
      case 'fixed-strings':
        setMatcher('F');
        break;
      case 'after-context':
        o.after = contextArg(v);
        break;
      case 'before-context':
        o.before = contextArg(v);
        break;
      case 'context':
        o.context = contextArg(v);
        break;
      case 'digit': {
        // -NUM: digits in one argument form one number (get_nondigit_option).
        let digits = opt.name.slice(1);
        while (parsed[k + 1]?.id === 'digit') {
          const more = digits + (parsed[k + 1] as { name: string }).name.slice(1);
          if (!p.argv.slice(1).some((a) => /^-[^-]/.test(a) && a.includes(more))) break;
          digits = more;
          k++;
        }
        o.context = contextArg(digits.replace(/^0+(?=.)/, ''));
        break;
      }
      case 'binary-files':
        if (v === 'binary' || v === 'text' || v === 'without-match') o.binaryFiles = v;
        else throw new Die('unknown binary-files type');
        break;
      case 'byte-offset':
        o.byteOffset = true;
        break;
      case 'color': {
        const c = opt.value?.toLowerCase();
        if (c === undefined || c === 'auto' || c === 'tty' || c === 'if-tty') o.color = 2;
        else if (c === 'always' || c === 'yes' || c === 'force') o.color = 1;
        else if (c === 'never' || c === 'no' || c === 'none') o.color = 0;
        else o.showHelp = true;
        break;
      }
      case 'count':
        o.countMatches = true;
        break;
      case 'devices':
        if (v === 'read') o.devices = 'read';
        else if (v === 'skip') o.devices = 'skip';
        else throw new Die('unknown devices method');
        break;
      case 'directories': {
        const d = argmatch(v, ['read', 'recurse', 'skip']);
        if (d === 'invalid' || d === 'ambiguous') {
          // upstream: gnulib argmatch.c argmatch_invalid, argmatch_valid; grep's ARGMATCH_DIE is usage (EXIT_FAILURE).
          throw new Die(
            `${d} argument ${quote(v)} for ${quote('--directories')}\nValid arguments are:\n  - ${quote('read')}\n  - ${quote('recurse')}\n  - ${quote('skip')}\n${USAGE.trimEnd()}`,
            1,
          );
        }
        o.directories = d as Options['directories'];
        break;
      }
      case 'dereference-recursive':
        o.dereference = true;
        o.directories = 'recurse';
        o.recursiveFlag = true;
        break;
      case 'recursive':
        o.directories = 'recurse';
        o.recursiveFlag = true;
        break;
      case 'exclude':
        o.fileRules.push({ pattern: v, include: false });
        break;
      case 'include':
        o.fileRules.push({ pattern: v, include: true });
        break;
      case 'exclude-from':
        o.fileRules.push(...excludeFileRules(yield* readPatternFile(p, v)));
        break;
      case 'exclude-dir':
        o.dirRules.push({ pattern: v.length > 1 ? v.replace(/\/+$/, '') || '/' : v, include: false });
        break;
      case 'file': {
        const text = yield* readPatternFile(p, v);
        splitLines(text).forEach((line, i) => o.keys.push({ text: line, origin: { file: v, line: i + 1 } }));
        o.keysGiven = true;
        break;
      }
      case 'files-with-matches':
        o.listFiles = 'matching';
        break;
      case 'files-without-match':
        o.listFiles = 'nonmatching';
        break;
      case 'group-separator':
        o.groupSeparator = v;
        break;
      case 'no-group-separator':
        o.groupSeparator = undefined;
        break;
      case 'help':
        o.showHelp = true;
        break;
      case 'ignore-case':
        o.icase = true;
        break;
      case 'no-ignore-case':
        o.icase = false;
        break;
      case 'label':
        o.label = v;
        break;
      case 'line-buffered':
        o.lineBuffered = true;
        break;
      case 'line-number':
        o.lineNumbers = true;
        break;
      case 'line-regexp':
        o.line = true;
        break;
      case 'max-count': {
        const n = parseIntmax(v);
        if (n === undefined) throw new Die('invalid max count');
        o.maxCount = n;
        break;
      }
      case 'no-filename':
        o.filenameOption = -1;
        break;
      case 'with-filename':
        o.filenameOption = 1;
        break;
      case 'no-messages':
        o.suppressErrors = true;
        break;
      case 'null':
        o.nullAfterName = true;
        break;
      case 'null-data':
        o.eol = '\0';
        break;
      case 'only-matching':
        o.onlyMatching = true;
        break;
      case 'quiet':
        o.quiet = true;
        break;
      case 'regexp':
        v.split('\n').forEach((text) => o.keys.push({ text }));
        o.keysGiven = true;
        break;
      case 'invert-match':
        o.invert = true;
        break;
      case 'text':
        o.binaryFiles = 'text';
        break;
      case 'I':
        o.binaryFiles = 'without-match';
        break;
      case 'binary':
        // O_BINARY is 0 on GNU/Linux: -U has no effect there.
        break;
      case 'unix-byte-offsets':
        yield* p.write(2, `${p.name}: warning: --unix-byte-offsets (-u) is obsolete\n`);
        break;
      case 'version':
        o.showVersion ??= opt.name;
        break;
      case 'word-regexp':
        o.word = true;
        break;
    }
  }
  return o;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const r = getopt(p.argv.slice(1), { options: OPTIONS, stopAtOperand: p.env['POSIXLY_CORRECT'] !== undefined });
  if (!r.ok) {
    if ('unsupported' in r) return yield* p.unsupported({ kind: 'flag', what: `the flag ${r.unsupported}` });
    yield* p.write(2, `${p.name}: ${r.error}\n${USAGE}`);
    return 2;
  }
  let o: Options;
  try {
    o = yield* readOptions(p, r.options);
  } catch (e) {
    if (!(e instanceof Die)) throw e;
    yield* p.write(2, `${p.name}: ${e.message}\n`);
    return e.status;
  }
  if (o.showVersion !== undefined) return yield* p.unsupported({ kind: 'flag', what: `the flag ${o.showVersion}` });
  if (o.showHelp) {
    yield* p.write(1, HELP);
    return 0;
  }
  const operands = [...r.operands];
  if (!o.keysGiven) {
    if (operands.length === 0) {
      yield* p.write(2, USAGE);
      return 2;
    }
    (operands.shift() as string).split('\n').forEach((text) => o.keys.push({ text }));
  }
  // grep 3.11 drops duplicate patterns before compiling them.
  const seen = new Set<string>();
  const keys = o.keys.filter((k) => {
    if (seen.has(k.text)) return false;
    seen.add(k.text);
    return true;
  });
  if (o.maxCount === 0) return 1;
  const maxCount = o.maxCount < 0 ? Infinity : o.maxCount;

  // upstream: grep.c main — what standard output is decides -q-like behavior and colors.
  let devNullOutput = false;
  let outIno: string | undefined;
  const stdout = fdInode(p, 1);
  if (!o.quiet && stdout) {
    if (stdout.type === 'file') outIno = stdout.ino;
    else {
      try {
        devNullOutput = p.fs().stat('/dev/null').ino === stdout.ino;
      } catch (e) {
        if (!isFsError(e)) throw e;
      }
    }
  }
  let listFiles = o.listFiles;
  let countMatches = o.countMatches;
  let doneOnMatch = false;
  if (o.quiet || devNullOutput) listFiles = 'none';
  if (o.quiet || devNullOutput || listFiles !== 'none') {
    countMatches = false;
    doneOnMatch = true;
  }
  const outQuiet = countMatches || doneOnMatch;
  const after = o.after < 0 ? o.context : o.after;
  const before = o.before < 0 ? o.context : o.before;

  const term = p.env['TERM'];
  const color = o.color === 2 ? !o.quiet && !devNullOutput && term !== undefined && term !== 'dumb' && p.isatty(1) : o.color === 1;
  let colors: Colors | undefined;
  if (color) {
    const c = colorsFromEnv(p.env);
    colors = c.colors;
    if (c.warning) yield* p.write(2, `${p.name}: ${c.warning}\n`);
  }

  const compiled = compilePatterns(keys, { syntax: o.matcher === 'E' ? 'extended' : o.matcher === 'F' ? 'fixed' : 'basic', icase: o.icase, word: o.word, line: o.line });
  for (const d of compiled.diagnostics) yield* p.write(2, `${p.name}: ${d.message}\n`);
  if (!compiled.matcher) return 2;

  const cfg: SearchConfig = {
    matcher: compiled.matcher,
    invert: o.invert,
    onlyMatching: o.onlyMatching,
    countMatches,
    listFiles,
    exitOnMatch: o.quiet,
    doneOnMatch,
    outQuiet,
    before,
    after,
    maxCount,
    lineNumbers: o.lineNumbers,
    byteOffset: o.byteOffset,
    nullAfterName: o.nullAfterName,
    eol: o.eol,
    colors,
    groupSeparator: o.groupSeparator,
    binaryFiles: o.binaryFiles,
    suppressErrors: o.suppressErrors,
  };
  const out = createOutput(p, o.lineBuffered || p.isatty(1));
  const run: RunState = { used: false, errseen: false };
  // With -R, devices met while recursing are read too.
  const devices = o.dereference && o.devices === 'read-command-line' ? 'read' : o.devices;
  const skipDevices = (commandLine: boolean): boolean => devices === 'skip' || (devices === 'read-command-line' && !commandLine);
  let omitDotSlash = false;
  let files = operands;
  if (files.length === 0) {
    if (o.recursiveFlag && o.directories === 'recurse') {
      files = ['.'];
      omitDotSlash = true;
    } else files = ['-'];
  }
  // upstream: grep.c main — out_file; -1: decided by whether the operand is a directory.
  let outFile = o.filenameOption === 0 && operands.length <= 1 ? (o.directories === 'recurse' ? -1 : 0) : o.filenameOption >= 0 ? 1 : 0;

  const g: Grep = { p, o, cfg, out, run, colors, outIno, skipDevices, omitDotSlash, outFile: () => outFile, setOutFile: (v) => (outFile = v) };
  let status = true;
  for (const f of files) {
    if (f === '-') status = (yield* grepDesc(g, 0, o.label, true, undefined)) && status;
    else status = (yield* grepFile(g, f, f, true, true)) && status;
    yield* out.sync();
  }
  yield* out.flush();
  return run.errseen ? 2 : status ? 1 : 0;
}

interface Grep {
  p: ProcApi;
  o: Options;
  cfg: SearchConfig;
  out: Output;
  run: RunState;
  colors: Colors | undefined;
  outIno: string | undefined;
  skipDevices(commandLine: boolean): boolean;
  omitDotSlash: boolean;
  outFile(): number;
  setOutFile(v: number): void;
}

function* suppressible(g: Grep, name: string, e: FsError): Op<void> {
  if (!g.o.suppressErrors) yield* g.out.error(`${name}: ${strerror(e.code)}`);
  g.run.errseen = true;
}

/** upstream: grep.c grepfile — opens `path` (shown as `name`); true when nothing was selected. */
function* grepFile(g: Grep, path: string, name: string, follow: boolean, commandLine: boolean): Op<boolean> {
  const { p } = g;
  let type: 'file' | 'dir' | 'char' | 'symlink';
  let ino: string;
  try {
    p.openAt(3, path, { read: true });
    const st = p.fs().stat(path);
    type = st.type;
    ino = st.ino;
  } catch (e) {
    if (!isFsError(e)) throw e;
    yield* suppressible(g, name, e);
    return true;
  }
  try {
    return yield* grepDesc(g, 3, name, commandLine, { type, ino, path, follow });
  } finally {
    if (p.fd(3)) p.close(3);
  }
}

/** upstream: grep.c grepdesc */
function* grepDesc(g: Grep, fd: number, name: string, commandLine: boolean, file: { type: string; ino: string; path: string; follow: boolean } | undefined): Op<boolean> {
  const { o, cfg, out, run, colors } = g;
  if (file) {
    if (g.skipDevices(commandLine) && file.type === 'char') return true;
    // upstream: grep.c skipped_file, for a command-line operand.
    if (commandLine) {
      const skip = file.type !== 'dir' ? excluded(o.fileRules, name, false) : o.directories === 'skip' || (!g.omitDotSlash && excluded(o.dirRules, name, false));
      if (skip) return true;
    }
  }
  if (g.outFile() < 0) g.setOutFile(file?.type === 'dir' ? 1 : 0);
  if (file && o.directories === 'recurse' && file.type === 'dir') {
    g.p.close(fd);
    return yield* walk(g, file.path, file.ino);
  }
  if (file && ((o.directories === 'skip' && file.type === 'dir') || (g.skipDevices(commandLine) && file.type === 'char'))) return true;
  const ino = file ? file.ino : fdInode(g.p, 0)?.ino;
  const regular = file ? file.type === 'file' : fdInode(g.p, 0)?.type === 'file';
  if (!cfg.outQuiet && cfg.listFiles === 'none' && cfg.maxCount > 1 && regular && ino !== undefined && ino === g.outIno) {
    if (!o.suppressErrors) yield* out.error(`${name}: input file is also the output`);
    run.errseen = true;
    return true;
  }
  const count = yield* searchInput(g.p, cfg, run, out, { fd, name, withName: g.outFile() > 0 });
  const fnStart = colors ? sgrStart(colors, colors.fn) : '';
  const fnEnd = colors ? sgrEnd(colors, colors.fn) : '';
  if (cfg.countMatches) {
    let line = '';
    if (g.outFile() > 0) line += fnStart + name + fnEnd + (cfg.nullAfterName ? '\0' : colors ? sgrStart(colors, colors.se) + ':' + sgrEnd(colors, colors.se) : ':');
    out.write(`${line}${count}\n`);
  }
  const status = count === 0;
  if (cfg.listFiles === (status ? 'nonmatching' : 'matching')) out.write(fnStart + name + fnEnd + (cfg.nullAfterName ? '\0' : '\n'));
  return status;
}

/**
 * Recursion as fts(3) does it for grep: preorder, symlinks met on the way skipped (-r) or followed
 * (-R), devices skipped, --exclude-dir and --include/--exclude on base names.
 * upstream: grep.c grepdirent; gnulib fts.c (FTS_DC for a directory loop)
 */
function* walk(g: Grep, root: string, rootIno: string): Op<boolean> {
  const { p, o } = g;
  let status = true;
  const shown = (path: string): string => (g.omitDotSlash && path.length > 1 ? path.slice(2) : path);
  const visit = function* (dir: string, ancestors: string[]): Op<void> {
    let names: string[];
    try {
      names = p.fs().readdir(dir);
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* suppressible(g, shown(dir), e);
      return;
    }
    for (const n of names) {
      const path = dir.endsWith('/') ? dir + n : `${dir}/${n}`;
      let st;
      try {
        st = o.dereference ? p.fs().stat(path) : p.fs().lstat(path);
      } catch (e) {
        if (!isFsError(e)) throw e;
        // A dangling symlink with -R: grep tries to open it and reports why it cannot.
        yield* suppressible(g, shown(path), e);
        continue;
      }
      if (excluded(st.type === 'dir' ? o.dirRules : o.fileRules, n, true)) continue;
      if (st.type === 'symlink') continue;
      if (st.type === 'dir') {
        if (ancestors.includes(st.ino)) {
          if (!o.suppressErrors) yield* g.out.error(`${shown(path)}: warning: recursive directory loop`);
          continue;
        }
        yield* visit(path, [...ancestors, st.ino]);
        continue;
      }
      if (st.type === 'char' && g.skipDevices(false)) continue;
      status = (yield* grepFile(g, path, shown(path), o.dereference, false)) && status;
      yield* g.out.sync();
    }
  };
  yield* visit(root, [rootIno]);
  return status;
}

export const grepProgram: ProgramSpec = { name: 'grep', main };
