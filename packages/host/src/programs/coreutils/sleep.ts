// sleep — delay for a specified amount of time. GNU coreutils 9.4.
//   docs: sleep --help and sleep(1) of coreutils 9.4
//   upstream: coreutils src/sleep.c main, apply_suffix
//   reference: coreutils 9.4 sleep, captured 2026-11-16 (packages/host/transcripts/coreutils/sleep.t)
// The pause is virtual time: the process blocks on the kernel clock, so Ctrl-C (SIGINT to the
// foreground group) ends it like any other blocked process. `infinity` (or a value too large for
// the clock) waits on a topic nothing publishes, which a world can hold as plain data.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quote } from '../lib/quote.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { parseCFloat } from '../../text/cformat.ts';

/** `sleep --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 NUMBER[SUFFIX]...\n  or:  \u0000 OPTION\nPause for NUMBER seconds.  SUFFIX may be 's' for seconds (the default),\n'm' for minutes, 'h' for hours or 'd' for days.  NUMBER need not be an\ninteger.  Given two or more arguments, pause for the amount of time\nspecified by the sum of their values.\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/sleep>\nor available locally via: info '(coreutils) sleep invocation'\n";

// sleep takes only --help and --version (parse_gnu_standard_options_only): `sleep -1` is an
// invalid option, `sleep -- -1` an invalid interval.
const OPTIONS: OptionSpec[] = [{ long: 'help' }, { long: 'version' }];

const SUFFIX: Record<string, number> = { '': 1, s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };

/**
 * Seconds of one operand: a strtod(3) number (blanks, sign, decimal or hex, `inf`, `infinity`)
 * that is not negative and not NaN, then at most one suffix character. Returns undefined when
 * the interval is invalid.
 */
export function parseInterval(arg: string): number | undefined {
  const m = /^[ \t\n\v\f\r]*[+-]?(?:inf(?:inity)?|nan(?:\([0-9A-Za-z_]*\))?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/i.exec(arg);
  if (!m) return undefined;
  const rest = arg.slice(m[0].length);
  const mult = SUFFIX[rest];
  if (mult === undefined) return undefined;
  const text = m[0].trim();
  let value: number;
  if (/^[+-]?0x/i.test(text)) value = hexFloat(text);
  else value = parseCFloat(text).value;
  if (!(value >= 0)) return undefined;
  return value * mult;
}

/** A C99 hexadecimal floating constant (`0x1.8p1`). */
function hexFloat(text: string): number {
  const m = /^([+-]?)0x([0-9a-f]*)\.?([0-9a-f]*)(?:p([+-]?[0-9]+))?$/i.exec(text) as RegExpExecArray;
  const int = m[2] ?? '';
  const frac = m[3] ?? '';
  let v = 0;
  for (const c of int + frac) v = v * 16 + parseInt(c, 16);
  v = v / 16 ** frac.length;
  v *= 2 ** Number(m[4] ?? '0');
  return m[1] === '-' ? -v : v;
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
  let seconds = 0;
  let ok = true;
  for (const a of args.operands) {
    const s = parseInterval(a);
    if (s === undefined) {
      yield* warn(p, `invalid time interval ${quote(a)}`);
      ok = false;
      continue;
    }
    seconds += s;
  }
  if (!ok) {
    yield* p.write(2, `Try '${p.name} --help' for more information.\n`);
    return 1;
  }
  // The kernel clock counts whole milliseconds: a shorter pause rounds up to one.
  const ms = Math.ceil(seconds * 1000);
  if (!Number.isSafeInteger(p.now + ms)) {
    yield* p.wait(`sleep.forever:${p.machine}:${p.pid}`);
    return 0;
  }
  yield* p.sleep(ms);
  return 0;
}

export const sleepProgram: ProgramSpec = { name: 'sleep', main };
