// dirname — strip last component from file name. GNU coreutils 9.4.
//   docs: dirname --help and dirname(1) of coreutils 9.4
//   upstream: coreutils src/dirname.c main; gnulib dir_len
//   reference: coreutils 9.4 dirname, captured 2026-11-16 (packages/host/transcripts/coreutils/dirname.t)
// Pure string operations: the names need not exist.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { parseArgs, usageError } from '../lib/io.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `dirname --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION] NAME...\nOutput each NAME with its last non-slash component and trailing slashes\nremoved; if NAME contains no /'s, output '.' (meaning the current directory).\n\n  -z, --zero     end each output line with NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nExamples:\n  \u0000 /usr/bin/          -> \"/usr\"\n  \u0000 dir1/str dir2/str  -> \"dir1\" followed by \"dir2\"\n  \u0000 stdio.h            -> \".\"\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/dirname>\nor available locally via: info '(coreutils) dirname invocation'\n";

const OPTIONS: OptionSpec[] = [{ short: 'z', long: 'zero' }, { long: 'help' }, { long: 'version' }];

/** Everything before the last component, without trailing slashes; `.` when there is no slash. */
export function dirName(name: string): string {
  const trimmed = name.replace(/\/+$/, '');
  if (trimmed === '') return name.startsWith('/') ? '/' : '.';
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return '.';
  const dir = trimmed.slice(0, slash).replace(/\/+$/, '');
  return dir === '' ? '/' : dir;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  if (args.operands.length === 0) return yield* usageError(p, 'missing operand');
  const end = args.has('zero') ? '\0' : '\n';
  yield* p.write(1, args.operands.map((n) => dirName(n) + end).join(''));
  return 0;
}

export const dirnameProgram: ProgramSpec = { name: 'dirname', main };
