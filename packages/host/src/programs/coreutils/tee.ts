// tee — read from standard input and write to standard output and files. GNU coreutils 9.4.
//   docs: tee --help and tee(1) of coreutils 9.4
//   upstream: coreutils src/tee.c (main, tee_files)
//   reference: coreutils 9.4 tee, captured 2026-11-16 (packages/host/transcripts/coreutils/tee.t)
// Copies each chunk as it arrives, to standard output first and then to each file in order. An
// operand "-" is a file named "-". A file that cannot be opened is reported and skipped; the
// others are still written, and the status is 1.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { SIGINT } from '../../proc/signals.ts';
import { isFsError, strerror, UnsupportedError } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { parseArgs, warn } from '../lib/io.ts';
import { quotef } from '../lib/quote.ts';
import { readSome } from '../lib/textio.ts';

/** `tee --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: tee [OPTION]... [FILE]...\nCopy standard input to each FILE, and also to standard output.\n\n  -a, --append              append to the given FILEs, do not overwrite\n  -i, --ignore-interrupts   ignore interrupt signals\n  -p                        operate in a more appropriate MODE with pipes.\n      --output-error[=MODE]   set behavior on write error.  See MODE below\n      --help        display this help and exit\n      --version     output version information and exit\n\nMODE determines behavior with write errors on the outputs:\n  warn           diagnose errors writing to any output\n  warn-nopipe    diagnose errors writing to any output not a pipe\n  exit           exit on error writing to any output\n  exit-nopipe    exit on error writing to any output not a pipe\nThe default MODE for the -p option is 'warn-nopipe'.\nWith \"nopipe\" MODEs, exit immediately if all outputs become broken pipes.\nThe default operation when --output-error is not specified, is to\nexit immediately on error writing to a pipe, and diagnose errors\nwriting to non pipe outputs.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/tee>\nor available locally via: info '(coreutils) tee invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'a', long: 'append' },
  { short: 'i', long: 'ignore-interrupts' },
  { short: 'p', id: 'p', supported: false },
  { long: 'output-error', arg: 'optional', supported: false },
  { long: 'help' },
  { long: 'version' },
];

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const append = args.has('append');
  // upstream: tee.c, -i ignores SIGINT.
  if (args.has('ignore-interrupts')) p.trap(SIGINT, 'ignore');

  let status = 0;
  const outs: { fd: number; name: string }[] = [{ fd: 1, name: 'standard output' }];
  for (const name of args.operands) {
    try {
      const fd = p.open(name, { write: true, create: true, ...(append ? { append: true } : { truncate: true }) });
      outs.push({ fd, name });
    } catch (e) {
      if (e instanceof UnsupportedError) return yield* p.unsupported({ kind: 'behavior', what: e.what });
      if (!isFsError(e)) throw e;
      yield* warn(p, `${quotef(name)}: ${strerror(e.code)}`);
      status = 1;
    }
  }
  for (;;) {
    let chunk: string | null;
    try {
      chunk = yield* readSome(p, 0);
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `read error: ${strerror(e.code)}`);
      status = 1;
      break;
    }
    if (chunk === null) break;
    for (const o of outs) {
      if (o.fd < 0) continue;
      try {
        yield* p.write(o.fd, chunk);
      } catch (e) {
        if (!isFsError(e)) throw e;
        yield* warn(p, `${quotef(o.name)}: ${strerror(e.code)}`);
        status = 1;
        o.fd = -1;
      }
    }
  }
  for (const o of outs) if (o.fd > 1) p.close(o.fd);
  return status;
}

export const teeProgram: ProgramSpec = { name: 'tee', main };
