// mkdir — make directories. GNU coreutils 9.4.
//   docs: mkdir --help and mkdir(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/mkdir.c main, make_ancestor; gnulib lib/mkdir-p.c make_dir_parents,
//             lib/mkancesdirs.c mkancesdirs, lib/dirchownmod.c
//   reference: coreutils 9.4 mkdir, captured 2026-11-16 (packages/host/transcripts/coreutils/mkdir.t)

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, type Errno } from '../../vfs/errno.ts';
import { ACCESS, type Fs } from '../../vfs/fs.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt, fsWithUmask, umaskOf } from '../lib/fsutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { adjustMode, compileMode } from '../lib/modechange.ts';
import { quote, quoteaf } from '../lib/quote.ts';

/** `mkdir --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: mkdir [OPTION]... DIRECTORY...\nCreate the DIRECTORY(ies), if they do not already exist.\n\nMandatory arguments to long options are mandatory for short options too.\n  -m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask\n  -p, --parents     no error if existing, make parent directories as needed,\n                    with their file modes unaffected by any -m option.\n  -v, --verbose     print a message for each created directory\n  -Z                   set SELinux security context of each created directory\n                         to the default type\n      --context[=CTX]  like -Z, or if CTX is specified then set the SELinux\n                         or SMACK security context to CTX\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/mkdir>\nor available locally via: info '(coreutils) mkdir invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'm', long: 'mode', arg: 'required' },
  { short: 'p', long: 'parents' },
  { short: 'v', long: 'verbose' },
  { short: 'Z', id: 'context', supported: false },
  { long: 'context', arg: 'optional', supported: false },
  { long: 'help' },
  { long: 'version' },
];

const S_IWUSR = 0o200;
const S_IXUSR = 0o100;
const S_IRWXUGO = 0o777;
const SPECIAL = 0o7000;

interface Plan {
  parents: boolean;
  verbose: boolean;
  /** Mode of the final directory and the bits the user cares about (mode_bits). */
  mode: number;
  modeBits: number;
  umaskSelf: number;
  umaskAncestor: number;
}

function* announce(p: ProcApi, plan: Plan, dir: string): Op<void> {
  if (plan.verbose) yield* p.write(1, `${p.name}: created directory ${quoteaf(dir)}\n`);
}

/** chdir(2)'s checks on an ancestor just made or found: it must be a searchable directory. */
function chdirCheck(fs: Fs, dir: string): Errno | undefined {
  const st = attempt(() => fs.stat(dir));
  if (!st.ok) return st.code;
  if (st.value.type !== 'dir') return 'ENOTDIR';
  const x = attempt(() => fs.access(dir, ACCESS.X_OK));
  return x.ok ? undefined : x.code;
}

/** mkancesdirs: makes the ancestors of `file`. Returns undefined when they exist, else the prefix that failed and why. */
function* makeAncestors(p: ProcApi, plan: Plan, file: string): Op<{ prefix: string; code: Errno } | undefined> {
  const anc = fsWithUmask(p, plan.umaskAncestor);
  let sep = -1;
  let component = 0;
  for (let i = 0; i < file.length; i++) {
    const c = file[i] as string;
    const next = file[i + 1];
    if (next === '/') {
      if (c !== '/') sep = i + 1;
    } else if (c === '/' && next !== undefined && sep >= 0) {
      const comp = file.slice(component, sep);
      if (comp !== '.') {
        const prefix = file.slice(0, sep);
        let mkdirErr: Errno | undefined;
        if (comp !== '..') {
          const r = attempt(() => anc.mkdir(prefix, S_IRWXUGO));
          if (r.ok) yield* announce(p, plan, prefix);
          else mkdirErr = r.code;
        }
        const cd = chdirCheck(anc, prefix);
        if (cd !== undefined) return { prefix, code: mkdirErr !== undefined && cd === 'ENOENT' ? mkdirErr : cd };
      }
      component = i + 1;
    }
  }
  return undefined;
}

function* makeDir(p: ProcApi, plan: Plan, dir: string): Op<boolean> {
  if (plan.parents) {
    const failed = yield* makeAncestors(p, plan, dir);
    if (failed) {
      yield* warn(p, `cannot create directory ${quote(failed.prefix)}: ${strerror(failed.code)}`);
      return false;
    }
  }
  const fs = fsWithUmask(p, plan.umaskSelf);
  const keepSpecial = ((plan.modeBits & 0o6000) | (plan.mode & 0o1000)) === 0;
  const mkdirMode = keepSpecial ? plan.mode : plan.mode & ~0o022;
  const made = attempt(() => fs.mkdir(dir, mkdirMode));
  if (made.ok) {
    yield* announce(p, plan, dir);
    const umaskMustBeOk = (plan.mode & plan.modeBits & S_IRWXUGO) === 0;
    if (keepSpecial && umaskMustBeOk) return true;
    // dirchownmod: set the bits the user asked for that mkdir(2) and the umask left out.
    const st = fs.stat(dir);
    if ((st.mode ^ plan.mode) & plan.modeBits) {
      const ch = attempt(() => fs.chmod(dir, plan.mode | (st.mode & 0o7777 & ~plan.modeBits)));
      if (!ch.ok) {
        yield* warn(p, `cannot change permissions of ${quote(dir)}: ${strerror(ch.code)}`);
        return false;
      }
    }
    return true;
  }
  if (plan.parents && made.code !== 'ENOENT') {
    const st = attempt(() => fs.stat(dir));
    if (st.ok && st.value.type === 'dir') return true;
    if (!st.ok && made.code === 'EEXIST' && st.code !== 'ENOENT' && st.code !== 'ENOTDIR') {
      yield* warn(p, `cannot stat ${quote(dir)}: ${strerror(st.code)}`);
      return false;
    }
  }
  yield* warn(p, `cannot create directory ${quote(dir)}: ${strerror(made.code)}`);
  return false;
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

  const umask = umaskOf(p);
  const parents = args.has('parents');
  const specified = args.value('mode');
  const plan: Plan = {
    parents,
    verbose: args.has('verbose'),
    mode: S_IRWXUGO,
    modeBits: 0,
    umaskSelf: umask,
    umaskAncestor: umask & ~(S_IWUSR | S_IXUSR),
  };
  if (specified !== undefined) {
    const change = compileMode(specified);
    if (!change) {
      yield* warn(p, `invalid mode ${quote(specified)}`);
      return 1;
    }
    const adjusted = adjustMode(S_IRWXUGO, true, umask, change);
    plan.mode = adjusted.mode;
    plan.modeBits = adjusted.bits;
    plan.umaskSelf = umask & ~plan.mode;
  }
  // Only the permission and special bits of mode take part.
  plan.mode &= S_IRWXUGO | SPECIAL;
  let status = 0;
  for (const dir of args.operands) {
    if (!(yield* makeDir(p, plan, dir))) status = 1;
  }
  return status;
}

export const mkdirProgram: ProgramSpec = { name: 'mkdir', main };
