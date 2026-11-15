// pwd — print name of current/working directory. GNU coreutils 9.4 (not the bash builtin, which
// runs unless the binary is named: `env pwd`, `/bin/pwd`).
//   docs: pwd --help and pwd(1) of coreutils 9.4
//   upstream: coreutils src/pwd.c main, logical_getcwd
//   reference: coreutils 9.4 pwd, captured 2026-11-16 (packages/host/transcripts/coreutils/pwd.t)
// -P (the default) prints the directory with every symbolic link resolved, as getcwd(3) does. -L
// prints $PWD when it is absolute, has no . or .. component and names the working directory.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError } from '../../vfs/errno.ts';
import { parseArgs, warn } from '../lib/io.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `pwd --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION]...\nPrint the full filename of the current working directory.\n\n  -L, --logical   use PWD from environment, even if it contains symlinks\n  -P, --physical  avoid all symlinks\n      --help        display this help and exit\n      --version     output version information and exit\n\nIf no option is specified, -P is assumed.\n\nNOTE: your shell may have its own version of pwd, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/pwd>\nor available locally via: info '(coreutils) pwd invocation'\n";

const OPTIONS: OptionSpec[] = [{ short: 'L', long: 'logical' }, { short: 'P', long: 'physical' }, { long: 'help' }, { long: 'version' }];

/** $PWD if it may stand for the working directory (upstream: logical_getcwd). */
function logicalCwd(p: ProcApi): string | undefined {
  const wd = p.env['PWD'];
  if (wd === undefined || !wd.startsWith('/')) return undefined;
  if (wd.split('/').some((c) => c === '.' || c === '..')) return undefined;
  try {
    const fs = p.fs();
    return fs.stat(wd).ino === fs.stat('.').ino ? wd : undefined;
  } catch (e) {
    if (isFsError(e)) return undefined;
    throw e;
  }
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let logical = p.env['POSIXLY_CORRECT'] !== undefined;
  for (const o of args.options) logical = o.id === 'logical' ? true : o.id === 'physical' ? false : logical;
  if (args.operands.length > 0) yield* warn(p, 'ignoring non-option arguments');
  const wd = logical ? logicalCwd(p) : undefined;
  if (wd !== undefined) {
    yield* p.write(1, `${wd}\n`);
    return 0;
  }
  let physical: string;
  try {
    physical = p.fs().realpath('.');
  } catch (e) {
    if (!isFsError(e)) throw e;
    return yield* p.unsupported({ kind: 'behavior', what: 'pwd in a directory that cannot be resolved' });
  }
  yield* p.write(1, `${physical}\n`);
  return 0;
}

export const pwdProgram: ProgramSpec = { name: 'pwd', main };
