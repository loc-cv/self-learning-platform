// rm — remove files or directories. GNU coreutils 9.4.
//   docs: rm --help and rm(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/rm.c main, diagnose_leading_hyphen; src/remove.c rm_fts, prompt,
//             excise, write_protected_non_symlink; src/root-dev-ino.h
//   reference: coreutils 9.4 rm, captured 2026-11-16 (packages/host/transcripts/coreutils/rm.t);
//              `rm -rf /` was not run: its refusal is upstream's ROOT_DEV_INO_WARN, whose strings
//              are in the workstation's /usr/bin/rm (`strings`, 2026-11-16) and are captured
//              from chmod -R and chown -R, which share it.
// Prompts (-i, --interactive, -I for many files, and rm's own question before removing a
// write-protected file when standard input is a terminal) are not simulated: they print the
// notice. Entries of a directory are removed in name order; the real order is the file system's.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, type Errno } from '../../vfs/errno.ts';
import { ACCESS, type Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import { getopt, type OptionSpec } from '../lib/getopt.ts';
import { attempt, ftsTrim, fileTypeName, joinPath, rootIno, rootWarning } from '../lib/fsutil.ts';
import { usageError, warn } from '../lib/io.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';

/** `rm --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: rm [OPTION]... [FILE]...\nRemove (unlink) the FILE(s).\n\n  -f, --force           ignore nonexistent files and arguments, never prompt\n  -i                    prompt before every removal\n  -I                    prompt once before removing more than three files, or\n                          when removing recursively; less intrusive than -i,\n                          while still giving protection against most mistakes\n      --interactive[=WHEN]  prompt according to WHEN: never, once (-I), or\n                          always (-i); without WHEN, prompt always\n      --one-file-system  when removing a hierarchy recursively, skip any\n                          directory that is on a file system different from\n                          that of the corresponding command line argument\n      --no-preserve-root  do not treat '/' specially\n      --preserve-root[=all]  do not remove '/' (default);\n                              with 'all', reject any command line argument\n                              on a separate device from its parent\n  -r, -R, --recursive   remove directories and their contents recursively\n  -d, --dir             remove empty directories\n  -v, --verbose         explain what is being done\n      --help        display this help and exit\n      --version     output version information and exit\n\nBy default, rm does not remove directories.  Use the --recursive (-r or -R)\noption to remove each listed directory, too, along with all of its contents.\n\nTo remove a file whose name starts with a '-', for example '-foo',\nuse one of these commands:\n  rm -- -foo\n\n  rm ./-foo\n\nNote that if you use rm to remove a file, it might be possible to recover\nsome of its contents, given sufficient expertise and/or time.  For greater\nassurance that the contents are truly unrecoverable, consider using shred(1).\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/rm>\nor available locally via: info '(coreutils) rm invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'f', long: 'force' },
  { short: 'i', id: 'i' },
  { short: 'I', id: 'I' },
  { long: 'interactive', arg: 'optional' },
  { long: 'one-file-system', supported: false },
  { long: 'no-preserve-root' },
  { long: 'preserve-root', arg: 'optional' },
  { short: 'r', long: 'recursive' },
  { short: 'R', id: 'recursive' },
  { short: 'd', long: 'dir' },
  { short: 'v', long: 'verbose' },
  { long: 'help' },
  { long: 'version' },
];

type Interactive = 'never' | 'sometimes' | 'always';

interface Run {
  p: ProcApi;
  fs: Fs;
  recursive: boolean;
  emptyDirs: boolean;
  ignoreMissing: boolean;
  interactive: Interactive;
  verbose: boolean;
  stdinTty: boolean;
  root: string | undefined;
}

/** dot_or_dotdot of the last component, which keeps its trailing slashes (`./` counts). */
function dotOrDotdot(path: string): boolean {
  const stripped = path.replace(/\/+$/, '');
  const last = stripped === '' ? path : path.slice(stripped.lastIndexOf('/') + 1);
  if (last[0] !== '.') return false;
  const sep = last[last[1] === '.' ? 2 : 1];
  return sep === undefined || sep === '/';
}

/** The question rm would ask before acting on `path`, if it would ask one. upstream: remove.c prompt */
function promptFor(r: Run, path: string, st: Stat, isDir: boolean, descending: boolean): string | undefined {
  if (r.interactive === 'never') return undefined;
  if (st.type === 'symlink' && r.interactive !== 'always') return undefined;
  let writeProtected = false;
  if (!r.ignoreMissing && (r.interactive === 'always' || r.stdinTty) && st.type !== 'symlink') {
    writeProtected = !attempt(() => r.fs.access(path, ACCESS.W_OK)).ok;
  }
  if (!writeProtected && r.interactive !== 'always') return undefined;
  const q = quoteaf(path);
  const wp = writeProtected ? 'write-protected ' : '';
  if (isDir && descending) {
    const names = attempt(() => r.fs.readdir(path));
    if (names.ok && names.value.length > 0) return `${r.p.name}: descend into ${wp}directory ${q}? `;
  }
  return `${r.p.name}: remove ${wp}${fileTypeName(st)} ${q}? `;
}

function* ask(r: Run, question: string): Op<never> {
  return yield* r.p.unsupported({
    kind: 'behavior',
    what: `answering rm's question "${question.trim()}"`,
    hints: ['use rm -f to remove without asking'],
  });
}

/** excise: unlink or rmdir, then -v's line. */
function* excise(r: Run, path: string, isDir: boolean, readError?: Errno): Op<boolean> {
  const res = attempt(() => (isDir ? r.fs.rmdir(path) : r.fs.unlink(path)));
  if (res.ok) {
    if (r.verbose) yield* r.p.write(1, isDir ? `removed directory ${quoteaf(path)}\n` : `removed ${quoteaf(path)}\n`);
    return true;
  }
  if (r.ignoreMissing && res.code === 'ENOENT') return true;
  let code = res.code;
  if (readError !== undefined && (code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'ENOTDIR' || code === 'EEXIST')) code = readError;
  yield* warn(r.p, `cannot remove ${quoteaf(path)}: ${strerror(code)}`);
  return false;
}

/** rm_fts over one command-line argument or tree entry. Returns false when it or anything in it stayed. */
function* remove(r: Run, path: string, top: boolean): Op<boolean> {
  const got = attempt(() => r.fs.lstat(path));
  // FTS_NS: rm still tries, and reports what unlink says.
  if (!got.ok) return yield* excise(r, path, false);
  const st = got.value;
  if (st.type !== 'dir') {
    const q = promptFor(r, path, st, false, false);
    if (q !== undefined) return yield* ask(r, q);
    return yield* excise(r, path, false);
  }
  let emptyDir = false;
  if (!r.recursive) {
    if (!r.emptyDirs) {
      yield* warn(r.p, `cannot remove ${quoteaf(path)}: ${strerror('EISDIR')}`);
      return false;
    }
    // -d: an empty directory goes; one that cannot be read gets an rmdir attempt.
    const names = attempt(() => r.fs.readdir(path));
    if (!names.ok) return yield* excise(r, path, true, names.code);
    if (names.value.length > 0) {
      yield* warn(r.p, `cannot remove ${quoteaf(path)}: ${strerror('ENOTEMPTY')}`);
      return false;
    }
    emptyDir = true;
  }
  if (top) {
    if (dotOrDotdot(path)) {
      yield* warn(r.p, `refusing to remove ${quoteaf('.')} or ${quoteaf('..')} directory: skipping ${quoteaf(path)}`);
      return false;
    }
    if (r.root !== undefined && st.ino === r.root) {
      for (const line of rootWarning(path)) yield* warn(r.p, line);
      return false;
    }
  }
  const q = promptFor(r, path, st, true, true);
  if (q !== undefined) return yield* ask(r, q);
  if (emptyDir) return yield* excise(r, path, true);
  const names = attempt(() => r.fs.readdir(path));
  if (!names.ok) return yield* excise(r, path, true, names.code);
  let ok = true;
  for (const n of names.value) ok = (yield* remove(r, joinPath(path, n), false)) && ok;
  // A directory something stayed in is left alone, without another message.
  if (!ok) return false;
  return yield* excise(r, path, true);
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const parsed = getopt(p.argv.slice(1), { options: OPTIONS, stopAtOperand: p.env['POSIXLY_CORRECT'] !== undefined });
  if (!parsed.ok) {
    if ('unsupported' in parsed) return yield* p.unsupported({ kind: 'flag', what: `the flag ${parsed.unsupported}` });
    yield* warn(p, parsed.error);
    // diagnose_leading_hyphen: point at an existing file whose name looks like an option.
    const fs = p.fs();
    const hyphen = p.argv.slice(1).find((a) => a.length > 1 && a.startsWith('-') && attempt(() => fs.lstat(a)).ok);
    if (hyphen !== undefined) yield* p.write(2, `Try '${p.argv[0] as string} ./${quotef(hyphen)}' to remove the file ${quoteaf(hyphen)}.\n`);
    return yield* usageErrorTail(p);
  }
  const ids = parsed.options.map((o) => o.id);
  const args = { options: parsed.options, operands: parsed.operands, has: (id: string) => ids.includes(id) };
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let interactive: Interactive = 'sometimes';
  let ignoreMissing = false;
  let promptOnce = false;
  let preserveRoot = true;
  for (const o of args.options) {
    switch (o.id) {
      case 'force':
        interactive = 'never';
        ignoreMissing = true;
        promptOnce = false;
        break;
      case 'i':
        interactive = 'always';
        ignoreMissing = false;
        promptOnce = false;
        break;
      case 'I':
        interactive = 'sometimes';
        ignoreMissing = false;
        promptOnce = true;
        break;
      case 'interactive': {
        const when = o.value === undefined ? 'always' : matchWhen(o.value);
        if (when === undefined) {
          yield* p.write(2, `${p.name}: invalid argument ${quote(o.value as string)} for ${quote('--interactive')}\nValid arguments are:\n  - ‘never’, ‘no’, ‘none’\n  - ‘once’\n  - ‘always’, ‘yes’\n`);
          return yield* usageErrorTail(p);
        }
        if (when === 'never') {
          interactive = 'never';
          promptOnce = false;
        } else if (when === 'once') {
          interactive = 'sometimes';
          ignoreMissing = false;
          promptOnce = true;
        } else {
          interactive = 'always';
          ignoreMissing = false;
          promptOnce = false;
        }
        break;
      }
      case 'no-preserve-root':
        if (!p.argv.includes('--no-preserve-root')) {
          yield* warn(p, 'you may not abbreviate the --no-preserve-root option');
          return 1;
        }
        preserveRoot = false;
        break;
      case 'preserve-root':
        if (o.value !== undefined) {
          if (o.value === 'all') return yield* p.unsupported({ kind: 'flag', what: 'the flag --preserve-root=all' });
          yield* warn(p, `unrecognized --preserve-root argument: ${quoteaf(o.value)}`);
          return 1;
        }
        preserveRoot = true;
        break;
    }
  }
  const files = args.operands;
  if (files.length === 0) {
    if (ignoreMissing) return 0;
    return yield* usageError(p, 'missing operand');
  }
  const fs = p.fs();
  const recursive = args.has('recursive');
  if (interactive === 'always') return yield* p.unsupported({ kind: 'flag', what: 'interactive removal (-i, --interactive)', hints: ['use rm -f to remove without asking'] });
  if (promptOnce && (recursive || files.length > 3)) {
    const n = files.length;
    const q = recursive ? `remove ${n} argument${n === 1 ? '' : 's'} recursively?` : `remove ${n} arguments?`;
    return yield* p.unsupported({ kind: 'behavior', what: `answering rm's question "${p.name}: ${q}"`, hints: ['use rm -f to remove without asking'] });
  }
  const r: Run = {
    p,
    fs,
    recursive,
    emptyDirs: args.has('dir'),
    ignoreMissing,
    interactive,
    verbose: args.has('verbose'),
    stdinTty: p.isatty(0),
    root: recursive && preserveRoot ? rootIno(fs) : undefined,
  };
  let ok = true;
  for (const f of files) ok = (yield* remove(r, ftsTrim(f), true)) && ok;
  return ok ? 0 : 1;
}

const WHEN: [string, 'never' | 'once' | 'always'][] = [
  ['never', 'never'],
  ['no', 'never'],
  ['none', 'never'],
  ['once', 'once'],
  ['always', 'always'],
  ['yes', 'always'],
];

/** argmatch over --interactive's words, abbreviations included. */
function matchWhen(arg: string): 'never' | 'once' | 'always' | undefined {
  const exact = WHEN.find(([w]) => w === arg);
  if (exact) return exact[1];
  const c = WHEN.filter(([w]) => w.startsWith(arg));
  if (arg === '' || c.length === 0) return undefined;
  const v = (c[0] as [string, 'never' | 'once' | 'always'])[1];
  return c.every(([, x]) => x === v) ? v : undefined;
}

function* usageErrorTail(p: ProcApi): Op<number> {
  yield* p.write(2, `Try '${p.name} --help' for more information.\n`);
  return 1;
}

export const rmProgram: ProgramSpec = { name: 'rm', main };
