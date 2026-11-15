// rmdir — remove empty directories. GNU coreutils 9.4.
//   docs: rmdir --help and rmdir(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/rmdir.c main, remove_parents, ignorable_failure
//   reference: coreutils 9.4 rmdir, captured 2026-11-16 (packages/host/transcripts/coreutils/rmdir.t)

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, type Errno } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt } from '../lib/fsutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quoteaf } from '../lib/quote.ts';

/** `rmdir --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: rmdir [OPTION]... DIRECTORY...\nRemove the DIRECTORY(ies), if they are empty.\n\n      --ignore-fail-on-non-empty\n                    ignore each failure to remove a non-empty directory\n  -p, --parents     remove DIRECTORY and its ancestors;\n                    e.g., 'rmdir -p a/b' is similar to 'rmdir a/b a'\n\n  -v, --verbose     output a diagnostic for every directory processed\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/rmdir>\nor available locally via: info '(coreutils) rmdir invocation'\n";

const OPTIONS: OptionSpec[] = [
  { long: 'ignore-fail-on-non-empty' },
  { short: 'p', long: 'parents' },
  { short: 'v', long: 'verbose' },
  { long: 'help' },
  { long: 'version' },
];

interface Run {
  p: ProcApi;
  fs: Fs;
  ignoreNonEmpty: boolean;
  verbose: boolean;
}

/** ignorable_failure: with --ignore-fail-on-non-empty, a failure that means "not empty". */
function ignorable(r: Run, code: Errno, dir: string): boolean {
  if (!r.ignoreNonEmpty) return false;
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return true;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') {
    const names = attempt(() => r.fs.readdir(dir));
    return names.ok && names.value.length > 0;
  }
  return false;
}

function* removeDir(r: Run, dir: string): Op<Errno | undefined> {
  if (r.verbose) yield* r.p.write(1, `${r.p.name}: removing directory, ${quoteaf(dir)}\n`);
  const res = attempt(() => r.fs.rmdir(dir));
  return res.ok ? undefined : res.code;
}

/** remove_parents: after DIR, each ancestor named in it, until one fails. */
function* removeParents(r: Run, path: string): Op<boolean> {
  let dir = path.replace(/(.)\/+$/, '$1');
  for (;;) {
    let slash = dir.lastIndexOf('/');
    if (slash < 0) return true;
    while (slash > 0 && dir[slash] === '/') slash--;
    dir = dir.slice(0, slash + 1);
    const code = yield* removeDir(r, dir);
    if (code === undefined) continue;
    if (ignorable(r, code, dir)) return true;
    yield* warn(r.p, `${code !== 'ENOTDIR' ? 'failed to remove directory' : 'failed to remove'} ${quoteaf(dir)}: ${strerror(code)}`);
    return false;
  }
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  if (args.operands.length === 0) return yield* usageError(p, 'missing operand');
  const r: Run = { p, fs: p.fs(), ignoreNonEmpty: args.has('ignore-fail-on-non-empty'), verbose: args.has('verbose') };
  let ok = true;
  for (const dir of args.operands) {
    const code = yield* removeDir(r, dir);
    if (code !== undefined) {
      if (ignorable(r, code, dir)) continue;
      // A symbolic link with a trailing slash: Linux's rmdir(2) does not follow it.
      if (code === 'ENOTDIR' && dir.endsWith('/')) {
        const st = attempt(() => r.fs.stat(dir));
        if ((!st.ok && st.code !== 'ENOTDIR') || (st.ok && st.value.type === 'dir')) {
          const l = attempt(() => r.fs.lstat(dir.replace(/(.)\/+$/, '$1')));
          if (l.ok && l.value.type === 'symlink') {
            yield* warn(p, `failed to remove ${quoteaf(dir)}: Symbolic link not followed`);
            ok = false;
            continue;
          }
        }
      }
      yield* warn(p, `failed to remove ${quoteaf(dir)}: ${strerror(code)}`);
      ok = false;
    } else if (args.has('parents')) {
      ok = (yield* removeParents(r, dir)) && ok;
    }
  }
  return ok ? 0 : 1;
}

export const rmdirProgram: ProgramSpec = { name: 'rmdir', main };
