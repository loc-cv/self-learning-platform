// ln — make links between files. GNU coreutils 9.4.
//   docs: ln --help and ln(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/ln.c main, do_link, atomic_link; src/relpath.c; gnulib
//             lib/force-link.c (force_linkat, force_symlinkat)
//   reference: coreutils 9.4 ln, captured 2026-11-16 (packages/host/transcripts/coreutils/ln.t)

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, type Errno } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt, baseName, dirName, joinPath } from '../lib/fsutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quoteaf, quotef } from '../lib/quote.ts';
import { canonicalizeMissing, relativePath } from '../lib/pathcanon.ts';

/** `ln --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: ln [OPTION]... [-T] TARGET LINK_NAME\n  or:  ln [OPTION]... TARGET\n  or:  ln [OPTION]... TARGET... DIRECTORY\n  or:  ln [OPTION]... -t DIRECTORY TARGET...\nIn the 1st form, create a link to TARGET with the name LINK_NAME.\nIn the 2nd form, create a link to TARGET in the current directory.\nIn the 3rd and 4th forms, create links to each TARGET in DIRECTORY.\nCreate hard links by default, symbolic links with --symbolic.\nBy default, each destination (name of new link) should not already exist.\nWhen creating hard links, each TARGET must exist.  Symbolic links\ncan hold arbitrary text; if later resolved, a relative link is\ninterpreted in relation to its parent directory.\n\nMandatory arguments to long options are mandatory for short options too.\n      --backup[=CONTROL]      make a backup of each existing destination file\n  -b                          like --backup but does not accept an argument\n  -d, -F, --directory         allow the superuser to attempt to hard link\n                                directories (note: will probably fail due to\n                                system restrictions, even for the superuser)\n  -f, --force                 remove existing destination files\n  -i, --interactive           prompt whether to remove destinations\n  -L, --logical               dereference TARGETs that are symbolic links\n  -n, --no-dereference        treat LINK_NAME as a normal file if\n                                it is a symbolic link to a directory\n  -P, --physical              make hard links directly to symbolic links\n  -r, --relative              with -s, create links relative to link location\n  -s, --symbolic              make symbolic links instead of hard links\n  -S, --suffix=SUFFIX         override the usual backup suffix\n  -t, --target-directory=DIRECTORY  specify the DIRECTORY in which to create\n                                the links\n  -T, --no-target-directory   treat LINK_NAME as a normal file always\n  -v, --verbose               print name of each linked file\n      --help        display this help and exit\n      --version     output version information and exit\n\nThe backup suffix is '~', unless set with --suffix or SIMPLE_BACKUP_SUFFIX.\nThe version control method may be selected via the --backup option or through\nthe VERSION_CONTROL environment variable.  Here are the values:\n\n  none, off       never make backups (even if --backup is given)\n  numbered, t     make numbered backups\n  existing, nil   numbered if numbered backups exist, simple otherwise\n  simple, never   always make simple backups\n\nUsing -s ignores -L and -P.  Otherwise, the last option specified controls\nbehavior when a TARGET is a symbolic link, defaulting to -P.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/ln>\nor available locally via: info '(coreutils) ln invocation'\n";

const OPTIONS: OptionSpec[] = [
  { long: 'backup', arg: 'optional', supported: false },
  { short: 'b', id: 'backup', supported: false },
  { short: 'd', long: 'directory' },
  { short: 'F', id: 'directory' },
  { short: 'f', long: 'force' },
  { short: 'i', long: 'interactive' },
  { short: 'L', long: 'logical' },
  { short: 'n', long: 'no-dereference' },
  { short: 'P', long: 'physical' },
  { short: 'r', long: 'relative' },
  { short: 's', long: 'symbolic' },
  { short: 'S', long: 'suffix', arg: 'required', supported: false },
  { short: 't', long: 'target-directory', arg: 'required' },
  { short: 'T', long: 'no-target-directory' },
  { short: 'v', long: 'verbose' },
  { long: 'help' },
  { long: 'version' },
];

interface Run {
  p: ProcApi;
  fs: Fs;
  symbolic: boolean;
  force: boolean;
  interactive: boolean;
  logical: boolean;
  relative: boolean;
  hardDir: boolean;
  verbose: boolean;
}

/** linkat or symlinkat; an errno or undefined on success. */
function makeLink(r: Run, source: string, dest: string): Errno | undefined {
  // Linux refuses a new name with a trailing slash (ENOENT when it does not exist); the VFS
  // would create it, so check here (reported as an infra gap).
  if (/[^/]\/+$/.test(dest) && !attempt(() => r.fs.lstat(dest.replace(/\/+$/, ''))).ok) {
    const parent = attempt(() => r.fs.stat(dirName(dest)));
    if (parent.ok) return 'ENOENT';
  }
  if (r.symbolic) {
    const s = attempt(() => r.fs.symlink(source, dest));
    return s.ok ? undefined : s.code;
  }
  // AT_SYMLINK_FOLLOW for -L: link to what a symbolic link names.
  let src = source;
  if (r.logical) {
    const real = attempt(() => r.fs.realpath(source));
    if (real.ok) src = real.value;
  }
  const l = attempt(() => r.fs.link(src, dest));
  return l.ok ? undefined : l.code;
}

/** same_nameat: both names are the same entry of the same directory. */
function sameName(fs: Fs, a: string, b: string): boolean {
  if (baseName(a) !== baseName(b)) return false;
  const da = attempt(() => fs.stat(dirName(a)));
  const db = attempt(() => fs.stat(dirName(b)));
  return da.ok && db.ok && da.value.ino === db.value.ino;
}

function* doLink(r: Run, sourceIn: string, dest: string, tried: Errno | undefined | 'untried'): Op<boolean> {
  const { p, fs } = r;
  let source = sourceIn;
  let err: Errno | undefined | 'untried' = tried;
  if (err === 'untried' && !r.relative) err = makeLink(r, source, dest);
  let sourceStats: Stat | undefined;
  if (err !== undefined && !r.symbolic) {
    const st = attempt(() => (r.logical ? fs.stat(source) : fs.lstat(source)));
    if (!st.ok) {
      yield* warn(p, `failed to access ${quoteaf(source)}: ${strerror(st.code)}`);
      return false;
    }
    sourceStats = st.value;
  }
  if (err !== undefined) {
    if (!r.symbolic && !r.hardDir && sourceStats?.type === 'dir') {
      yield* warn(p, `${quotef(source)}: hard link not allowed for directory`);
      return false;
    }
    if (r.relative) source = relativePath(canonicalizeMissing(fs, p.cwd, source), canonicalizeMissing(fs, p.cwd, dirName(dest)));
    let force = r.force || r.interactive;
    if (force) {
      const ds = attempt(() => fs.lstat(dest));
      if (!ds.ok) {
        if (ds.code !== 'ENOENT') {
          yield* warn(p, `failed to access ${quoteaf(dest)}: ${strerror(ds.code)}`);
          return false;
        }
        force = false;
      } else if (ds.value.type === 'dir') {
        yield* warn(p, `${quotef(dest)}: cannot overwrite directory`);
        return false;
      } else {
        const ss = sourceStats ? { ok: true as const, value: sourceStats } : attempt(() => fs.stat(source));
        if (ss.ok && ss.value.ino === ds.value.ino && (ss.value.nlink === 1 || sameName(fs, source, dest))) {
          yield* warn(p, `${quoteaf(source)} and ${quoteaf(dest)} are the same file`);
          return false;
        }
      }
    }
    if (force && r.interactive && (err === 'untried' || err === 'EEXIST')) {
      return yield* p.unsupported({ kind: 'behavior', what: `answering ln's question "${p.name}: replace ${quoteaf(dest)}?"`, hints: ['use ln -f to replace without asking'] });
    }
    // force_linkat / force_symlinkat: try (again) and, with -f, replace an existing destination.
    if (err === 'untried') err = makeLink(r, source, dest);
    if (err === 'EEXIST' && force) {
      const un = attempt(() => fs.unlink(dest));
      err = un.ok ? makeLink(r, source, dest) : un.code;
    }
  }
  if (err === undefined) {
    if (r.verbose) yield* p.write(1, `${quoteaf(dest)} ${r.symbolic ? '-' : '='}> ${quoteaf(source)}\n`);
    return true;
  }
  const e = err as Errno;
  const what = r.symbolic
    ? e !== 'ENAMETOOLONG' && source !== ''
      ? `failed to create symbolic link ${quoteaf(dest)}`
      : `failed to create symbolic link ${quoteaf(dest)} -> ${quoteaf(source)}`
    : e === 'EMLINK'
      ? `failed to create hard link to ${quoteaf(source)}`
      : e === 'EEXIST' || e === 'ENOSPC' || e === 'EROFS'
        ? `failed to create hard link ${quoteaf(dest)}`
        : `failed to create hard link ${quoteaf(dest)} => ${quoteaf(source)}`;
  yield* warn(p, `${what}: ${strerror(e)}`);
  return false;
}

/** openat(O_DIRECTORY [| O_NOFOLLOW]): is `d` a directory to put links in? */
function openDir(fs: Fs, d: string, follow: boolean): Errno | undefined {
  const st = attempt(() => (follow ? fs.stat(d) : fs.lstat(d)));
  if (!st.ok) return st.code;
  if (st.value.type === 'symlink') return 'ELOOP';
  return st.value.type === 'dir' ? undefined : 'ENOTDIR';
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const fs = p.fs();
  let logical = false;
  let targetDir: string | undefined;
  for (const o of args.options) {
    if (o.id === 'logical') logical = true;
    else if (o.id === 'physical') logical = false;
    else if (o.id === 'target-directory') {
      if (targetDir !== undefined) {
        yield* warn(p, 'multiple target directories specified');
        return 1;
      }
      const v = o.value as string;
      const st = attempt(() => fs.stat(v));
      if (!st.ok) {
        yield* warn(p, `failed to access ${quoteaf(v)}: ${strerror(st.code)}`);
        return 1;
      }
      if (st.value.type !== 'dir') {
        yield* warn(p, `target ${quoteaf(v)} is not a directory`);
        return 1;
      }
      targetDir = v;
    }
  }
  const r: Run = {
    p,
    fs,
    symbolic: args.has('symbolic'),
    force: args.has('force'),
    interactive: args.has('interactive'),
    logical,
    relative: args.has('relative'),
    hardDir: args.has('directory'),
    verbose: args.has('verbose'),
  };
  // Using -s ignores -L and -P.
  if (r.symbolic) r.logical = false;
  const files = args.operands;
  if (files.length === 0) return yield* usageError(p, 'missing file operand');
  if (r.relative && !r.symbolic) {
    yield* warn(p, 'cannot do --relative without --symbolic');
    return 1;
  }
  const noTarget = args.has('no-target-directory');
  let n = files.length;
  let linkErr: Errno | undefined | 'untried' = 'untried';
  if (noTarget) {
    if (targetDir !== undefined) {
      yield* warn(p, 'cannot combine --target-directory and --no-target-directory');
      return 1;
    }
    if (n !== 2) {
      if (n < 2) return yield* usageError(p, `missing destination file operand after ${quoteaf(files[0] as string)}`);
      return yield* usageError(p, `extra operand ${quoteaf(files[2] as string)}`);
    }
  } else if (n < 2 && targetDir === undefined) {
    targetDir = '.';
  } else {
    if (n === 2 && targetDir === undefined && !r.relative) linkErr = makeLink(r, files[0] as string, files[1] as string);
    if (linkErr === 'untried' || linkErr === 'EEXIST' || linkErr === 'ENOTDIR' || linkErr === 'EINVAL') {
      const d = targetDir ?? (files[n - 1] as string);
      const e = openDir(fs, d, !args.has('no-dereference'));
      if (e === undefined) {
        if (targetDir === undefined) n -= 1;
        targetDir = d;
      } else if (!(n === 2 && targetDir === undefined)) {
        yield* warn(p, `target ${quoteaf(d)}: ${strerror(e)}`);
        return 1;
      }
    }
  }
  let ok = true;
  if (targetDir !== undefined) {
    for (let i = 0; i < n; i++) {
      const src = files[i] as string;
      const dest = joinPath(targetDir, baseName(src)).replace(/(.)\/+$/, '$1');
      ok = (yield* doLink(r, src, dest, 'untried')) && ok;
    }
  } else {
    ok = yield* doLink(r, files[0] as string, files[1] as string, linkErr);
  }
  return ok ? 0 : 1;
}

export const lnProgram: ProgramSpec = { name: 'ln', main };
