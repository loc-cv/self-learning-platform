// chmod — change file mode bits. GNU coreutils 9.4.
//   docs: chmod --help and chmod(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/chmod.c main, process_file, describe_change, mode_changed;
//             gnulib lib/modechange.c (programs/lib/modechange.ts)
//   reference: coreutils 9.4 chmod, captured 2026-11-16 (packages/host/transcripts/coreutils/chmod.t)
// Recursion visits a directory before its entries (fts preorder) and reads it after changing its
// mode, so `chmod -R 000 d` cannot read d afterwards, as on Linux. Entries are visited in name
// order; the real order is the file system's directory order.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import { getopt, type OptionSpec } from '../lib/getopt.ts';
import { attempt, ftsTrim, joinPath, rootIno, rootWarning, umaskOf } from '../lib/fsutil.ts';
import { usageError, warn } from '../lib/io.ts';
import { adjustMode, compileMode, modeFromReference, octal4, permString, type ModeChange } from '../lib/modechange.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';

/** `chmod --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: chmod [OPTION]... MODE[,MODE]... FILE...\n  or:  chmod [OPTION]... OCTAL-MODE FILE...\n  or:  chmod [OPTION]... --reference=RFILE FILE...\nChange the mode of each FILE to MODE.\nWith --reference, change the mode of each FILE to that of RFILE.\n\n  -c, --changes          like verbose but report only when a change is made\n  -f, --silent, --quiet  suppress most error messages\n  -v, --verbose          output a diagnostic for every file processed\n      --no-preserve-root  do not treat '/' specially (the default)\n      --preserve-root    fail to operate recursively on '/'\n      --reference=RFILE  use RFILE's mode instead of specifying MODE values.\n                         RFILE is always dereferenced if a symbolic link.\n  -R, --recursive        change files and directories recursively\n      --help        display this help and exit\n      --version     output version information and exit\n\nEach MODE is of the form '[ugoa]*([-+=]([rwxXst]*|[ugo]))+|[-+=][0-7]+'.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/chmod>\nor available locally via: info '(coreutils) chmod invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'changes' },
  { short: 'R', long: 'recursive' },
  { long: 'no-preserve-root' },
  { long: 'preserve-root' },
  { short: 'f', long: 'quiet', id: 'silent' },
  { long: 'silent' },
  { long: 'reference', arg: 'required' },
  { short: 'v', long: 'verbose' },
  { long: 'help' },
  { long: 'version' },
];

/** Characters getopt takes as the start of a mode ("r::w::x::…" in chmod's short options). */
const MODE_CHARS = new Set([...'rwxXstugoa,+=01234567']);
const FLAG_CHARS = new Set([...'Rcfv']);

/**
 * chmod takes `-w`, `-rwx` and the like as modes: getopt sees a mode letter as an option with an
 * optional argument, and chmod appends the whole argument to the mode. Separates those arguments
 * from the rest; options before the mode letter in the same argument still count.
 */
function splitModeArgs(argv: readonly string[]): { rest: string[]; mode: string | undefined } {
  const rest: string[] = [];
  let mode: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    // A separate argument of --reference is not a mode.
    if (/^--r/.test(a) && 'reference'.startsWith(a.slice(2)) && !a.includes('=')) {
      rest.push(a);
      if (i + 1 < argv.length) rest.push(argv[++i] as string);
      continue;
    }
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 1) {
      let k = 1;
      while (k < a.length && FLAG_CHARS.has(a[k] as string)) k++;
      if (k < a.length && MODE_CHARS.has(a[k] as string)) {
        mode = mode === undefined ? a : `${mode},${a}`;
        if (k > 1) rest.push(a.slice(0, k));
        continue;
      }
    }
    rest.push(a);
  }
  return { rest, mode };
}

interface Run {
  p: ProcApi;
  fs: Fs;
  change: ModeChange[];
  umask: number;
  recurse: boolean;
  silent: boolean;
  verbosity: 'off' | 'changes' | 'high';
  surprises: boolean;
  root: string | undefined;
}

type Status = 'no-stat' | 'not-applied' | 'no-change' | 'failed' | 'succeeded';

function* describe(r: Run, file: string, status: Status, oldMode: number, newMode: number): Op<void> {
  const q = quoteaf(file);
  let line: string;
  if (status === 'not-applied') line = `neither symbolic link ${q} nor referent has been changed`;
  else if (status === 'no-stat') line = `${q} could not be accessed`;
  else if (status === 'no-change') line = `mode of ${q} retained as ${octal4(newMode)} (${permString(newMode)})`;
  else {
    const verb = status === 'succeeded' ? `mode of ${q} changed` : `failed to change mode of ${q}`;
    line = `${verb} from ${octal4(oldMode)} (${permString(oldMode)}) to ${octal4(newMode)} (${permString(newMode)})`;
  }
  yield* r.p.write(1, `${line}\n`);
}

/** process_file for one entry; returns its success and whether to descend into it. */
function* processEntry(r: Run, file: string, st: Stat | null, err: string | undefined): Op<{ ok: boolean; descend: boolean }> {
  let status: Status = 'no-stat';
  if (err !== undefined) {
    if (!r.silent) yield* warn(r.p, err);
  } else status = 'not-applied';
  const s = st as Stat;
  if (status === 'not-applied' && r.root !== undefined && s.type === 'dir' && s.ino === r.root && r.recurse) {
    for (const line of rootWarning(file)) yield* warn(r.p, line);
    return { ok: false, descend: false };
  }
  let oldMode = 0;
  let newMode = 0;
  if (status === 'not-applied' && s.type !== 'symlink') {
    oldMode = s.mode;
    newMode = adjustMode(oldMode, s.type === 'dir', r.umask, r.change).mode;
    const done = attempt(() => r.fs.chmod(file, newMode));
    if (done.ok) status = 'succeeded';
    else {
      if (!r.silent) yield* warn(r.p, `changing permissions of ${quoteaf(file)}: ${strerror(done.code)}`);
      status = 'failed';
    }
  }
  if (r.verbosity !== 'off') {
    if (status === 'succeeded') {
      // mode_changed: chmod(2) may have dropped set-ID bits silently; compare with what is there.
      let actual = newMode;
      if (newMode & 0o7000) {
        const now = attempt(() => r.fs.stat(file));
        if (now.ok) actual = now.value.mode;
      }
      if (((oldMode ^ actual) & 0o7777) === 0) status = 'no-change';
    }
    if (status === 'succeeded' || r.verbosity === 'high') yield* describe(r, file, status, oldMode, newMode);
  }
  if ((status === 'no-change' || status === 'failed' || status === 'succeeded') && r.surprises) {
    const naive = adjustMode(oldMode, s.type === 'dir', 0, r.change).mode;
    if (newMode & ~naive) {
      yield* warn(r.p, `${quotef(file)}: new permissions are ${permString(newMode)}, not ${permString(naive)}`);
      status = 'failed';
    }
  }
  return { ok: status !== 'no-stat' && status !== 'failed', descend: st !== null && st.type === 'dir' };
}

function* walk(r: Run, file: string, top: boolean): Op<boolean> {
  let st: Stat | null = null;
  let err: string | undefined;
  const got = attempt(() => (top ? r.fs.stat(file) : r.fs.lstat(file)));
  if (got.ok) st = got.value;
  else if (top && got.code === 'ENOENT' && attempt(() => r.fs.lstat(file)).ok) err = `cannot operate on dangling symlink ${quoteaf(file)}`;
  else err = `cannot access ${quoteaf(file)}: ${strerror(got.code)}`;
  const res = yield* processEntry(r, file, st, err);
  let ok = res.ok;
  if (r.recurse && res.descend) {
    const names = attempt(() => r.fs.readdir(file));
    if (!names.ok) {
      if (!r.silent) yield* warn(r.p, `cannot read directory ${quoteaf(file)}: ${strerror(names.code)}`);
      return false;
    }
    for (const n of names.value) ok = (yield* walk(r, joinPath(file, n), false)) && ok;
  }
  return ok;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const { rest, mode: modeArgs } = splitModeArgs(p.argv.slice(1));
  const parsed = getopt(rest, { options: OPTIONS, stopAtOperand: p.env['POSIXLY_CORRECT'] !== undefined });
  if (!parsed.ok) {
    if ('unsupported' in parsed) return yield* p.unsupported({ kind: 'flag', what: `the flag ${parsed.unsupported}` });
    return yield* usageError(p, parsed.error);
  }
  const ids = parsed.options.map((o) => o.id);
  if (ids.includes('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (ids.includes('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let recurse = false;
  let silent = false;
  let preserveRoot = false;
  let verbosity: Run['verbosity'] = 'off';
  let reference: string | undefined;
  for (const o of parsed.options) {
    if (o.id === 'recursive') recurse = true;
    else if (o.id === 'silent') silent = true;
    else if (o.id === 'changes') verbosity = 'changes';
    else if (o.id === 'verbose') verbosity = 'high';
    else if (o.id === 'preserve-root') preserveRoot = true;
    else if (o.id === 'no-preserve-root') preserveRoot = false;
    else if (o.id === 'reference') reference = o.value;
  }
  const operands = [...parsed.operands];
  let mode = modeArgs;
  let modeIsOperand = false;
  if (reference !== undefined) {
    if (mode !== undefined) {
      return yield* usageError(p, 'cannot combine mode and --reference options');
    }
  } else if (mode === undefined && operands.length > 0) {
    mode = operands.shift() as string;
    modeIsOperand = true;
  }
  if (operands.length === 0) {
    const last = p.argv[p.argv.length - 1] as string;
    if (modeIsOperand) return yield* usageError(p, `missing operand after ${quote(last)}`);
    return yield* usageError(p, 'missing operand');
  }
  const fs = p.fs();
  let change: ModeChange[];
  if (reference !== undefined) {
    const ref = attempt(() => fs.stat(reference as string));
    if (!ref.ok) {
      yield* warn(p, `failed to get attributes of ${quoteaf(reference)}: ${strerror(ref.code)}`);
      return 1;
    }
    change = modeFromReference(ref.value.mode);
  } else {
    const compiled = compileMode(mode as string);
    if (!compiled) return yield* usageError(p, `invalid mode: ${quote(mode as string)}`);
    change = compiled;
  }
  const r: Run = {
    p,
    fs,
    change,
    umask: reference !== undefined ? 0 : umaskOf(p),
    recurse,
    silent,
    verbosity,
    surprises: modeArgs !== undefined,
    root: recurse && preserveRoot ? rootIno(fs) : undefined,
  };
  let ok = true;
  for (const file of operands) ok = (yield* walk(r, ftsTrim(file), true)) && ok;
  return ok ? 0 : 1;
}

export const chmodProgram: ProgramSpec = { name: 'chmod', main };
