// whoami — print effective user name. GNU coreutils 9.4.
//   docs: whoami --help and whoami(1) of coreutils 9.4
//   upstream: coreutils src/whoami.c main (getpwuid(geteuid()))
//   reference: coreutils 9.4 whoami, captured 2026-11-16 (packages/host/transcripts/coreutils/whoami.t)

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { userByUid } from '../../users.ts';
import { parseArgs, usageError } from '../lib/io.ts';
import { quote } from '../lib/quote.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `whoami --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION]...\nPrint the user name associated with the current effective user ID.\nSame as id -un.\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/whoami>\nor available locally via: info '(coreutils) whoami invocation'\n";

const OPTIONS: OptionSpec[] = [{ long: 'help' }, { long: 'version' }];

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  if (args.operands.length > 0) return yield* usageError(p, `extra operand ${quote(args.operands[0] as string)}`);
  const user = userByUid(p.ctx, p.machine, p.cred.uid);
  if (!user) return yield* p.unsupported({ kind: 'behavior', what: 'whoami for a user ID without a name' });
  yield* p.write(1, `${user.name}\n`);
  return 0;
}

export const whoamiProgram: ProgramSpec = { name: 'whoami', main };
