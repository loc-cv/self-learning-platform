// env — run a program in a modified environment. GNU coreutils 9.4.
//   docs: env --help and env(1) of coreutils 9.4
//   upstream: coreutils src/env.c main, unset_envvars
//   reference: coreutils 9.4 env, captured 2026-11-16 (packages/host/transcripts/coreutils/env.t)
// Options stop at the first operand; then a lone `-` means -i, NAME=VALUE operands are set in
// order, and the rest is the command, found through PATH like execvp(3). Without a command the
// resulting environment is printed in its order. env's own failures exit 125.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { execvp } from '../lib/execvp.ts';
import { quote, quoteaf } from '../lib/quote.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `env --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\nSet each NAME to VALUE in the environment and run COMMAND.\n\nMandatory arguments to long options are mandatory for short options too.\n  -i, --ignore-environment  start with an empty environment\n  -0, --null           end each output line with NUL, not newline\n  -u, --unset=NAME     remove variable from the environment\n  -C, --chdir=DIR      change working directory to DIR\n  -S, --split-string=S  process and split S into separate arguments;\n                        used to pass multiple arguments on shebang lines\n      --block-signal[=SIG]    block delivery of SIG signal(s) to COMMAND\n      --default-signal[=SIG]  reset handling of SIG signal(s) to the default\n      --ignore-signal[=SIG]   set handling of SIG signal(s) to do nothing\n      --list-signal-handling  list non default signal handling to stderr\n  -v, --debug          print verbose information for each processing step\n      --help        display this help and exit\n      --version     output version information and exit\n\nA mere - implies -i.  If no COMMAND, print the resulting environment.\n\nSIG may be a signal name like 'PIPE', or a signal number like '13'.\nWithout SIG, all known signals are included.  Multiple signals can be\ncomma-separated.  An empty SIG argument is a no-op.\n\nExit status:\n  125  if the env command itself fails\n  126  if COMMAND is found but cannot be invoked\n  127  if COMMAND cannot be found\n  -    the exit status of COMMAND otherwise\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/env>\nor available locally via: info '(coreutils) env invocation'\n";

/** EXIT_CANCELED, EXIT_CANNOT_INVOKE, EXIT_ENOENT (coreutils src/system.h). */
const CANCELED = 125;
const CANNOT_INVOKE = 126;
const ENOENT_STATUS = 127;

const OPTIONS: OptionSpec[] = [
  { short: 'i', long: 'ignore-environment' },
  { short: '0', long: 'null' },
  { short: 'u', long: 'unset', arg: 'required' },
  { short: 'C', long: 'chdir', arg: 'required' },
  { short: 'S', long: 'split-string', arg: 'required', supported: false },
  { long: 'block-signal', arg: 'optional', supported: false },
  { long: 'default-signal', arg: 'optional', supported: false },
  { long: 'ignore-signal', arg: 'optional', supported: false },
  { long: 'list-signal-handling', supported: false },
  { short: 'v', long: 'debug', supported: false },
  { long: 'help' },
  { long: 'version' },
];

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS, stopAtOperand: true }, CANCELED);
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const operands = [...args.operands];
  let ignore = args.has('ignore-environment');
  if (operands[0] === '-') {
    ignore = true;
    operands.shift();
  }
  const env: Record<string, string> = {};
  if (!ignore) {
    Object.assign(env, p.env);
    for (const name of args.values('unset')) {
      // unsetenv(3): EINVAL for an empty name or one containing '='.
      if (name === '' || name.includes('=')) {
        yield* warn(p, `cannot unset ${quote(name)}: ${strerror('EINVAL')}`);
        return CANCELED;
      }
      delete env[name];
    }
  }
  while (operands.length > 0 && (operands[0] as string).includes('=')) {
    const a = operands.shift() as string;
    const eq = a.indexOf('=');
    const name = a.slice(0, eq);
    // putenv(3) replaces a variable in place; a new one goes last.
    env[name] = a.slice(eq + 1);
  }
  const nul = args.has('null');
  const dir = args.value('chdir');
  if (nul && operands.length > 0) return yield* usageError(p, 'cannot specify --null (-0) with command', CANCELED);
  if (dir !== undefined && operands.length === 0) return yield* usageError(p, 'must specify command with --chdir (-C)', CANCELED);
  if (operands.length === 0) {
    let out = '';
    for (const [k, v] of Object.entries(env)) out += `${k}=${v}${nul ? '\0' : '\n'}`;
    yield* p.write(1, out);
    return 0;
  }
  if (dir !== undefined) {
    // chdir(2): the target must be a directory the process may search.
    try {
      const fs = p.fs();
      if (fs.stat(dir).type !== 'dir') {
        yield* warn(p, `cannot change directory to ${quoteaf(dir)}: ${strerror('ENOTDIR')}`);
        return CANCELED;
      }
      fs.access(dir, 1);
      p.setCwd(fs.realpath(dir));
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `cannot change directory to ${quoteaf(dir)}: ${strerror(e.code)}`);
      return CANCELED;
    }
  }
  const command = operands[0] as string;
  const r = execvp(p, command, operands, env);
  if (!r.ok) {
    yield* warn(p, `${quote(command)}: ${strerror(r.code)}`);
    return r.code === 'ENOENT' ? ENOENT_STATUS : CANNOT_INVOKE;
  }
  return p.exec({ program: r.program, argv: r.argv, env });
}

export const envProgram: ProgramSpec = { name: 'env', main };
