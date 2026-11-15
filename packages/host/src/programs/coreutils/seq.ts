// seq — print a sequence of numbers. GNU coreutils 9.4.
//   docs: seq --help and seq(1) of coreutils 9.4
//   upstream: coreutils src/seq.c main, scan_arg, get_default_format, long_double_format,
//             print_numbers, seq_fast
//   reference: coreutils 9.4 seq, captured 2026-11-16 (packages/host/transcripts/coreutils/seq.t)
// Numbers are long doubles (lib/longdouble.ts), each value computed as FIRST + i * INCREMENT.
// Without -f, operands written in fixed point give a %.PRECf format, PREC being the larger
// precision of FIRST and INCREMENT; -w pads to the widest of FIRST and LAST. Non-negative integer
// operands without -f, -w or a longer separator take seq_fast, exact for any size. Output is
// written in buffers, so `seq 1 inf | head` flows in virtual time.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { getopt, type OptionSpec } from '../lib/getopt.ts';
import { usageError, warn } from '../lib/io.ts';
import { quote } from '../lib/quote.ts';
import { add, cmp, formatLongDouble, fromBigInt, isZero, mul, parseLongDouble, type FloatSpec, type LongDouble } from '../lib/longdouble.ts';

/** `seq --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION]... LAST\n  or:  \u0000 [OPTION]... FIRST LAST\n  or:  \u0000 [OPTION]... FIRST INCREMENT LAST\nPrint numbers from FIRST to LAST, in steps of INCREMENT.\n\nMandatory arguments to long options are mandatory for short options too.\n  -f, --format=FORMAT      use printf style floating-point FORMAT\n  -s, --separator=STRING   use STRING to separate numbers (default: \\n)\n  -w, --equal-width        equalize width by padding with leading zeroes\n      --help        display this help and exit\n      --version     output version information and exit\n\nIf FIRST or INCREMENT is omitted, it defaults to 1.  That is, an\nomitted INCREMENT defaults to 1 even when LAST is smaller than FIRST.\nThe sequence of numbers ends when the sum of the current number and\nINCREMENT would become greater than LAST.\nFIRST, INCREMENT, and LAST are interpreted as floating point values.\nINCREMENT is usually positive if FIRST is smaller than LAST, and\nINCREMENT is usually negative if FIRST is greater than LAST.\nINCREMENT must not be 0; none of FIRST, INCREMENT and LAST may be NaN.\nFORMAT must be suitable for printing one argument of type 'double';\nit defaults to %.PRECf if FIRST, INCREMENT, and LAST are all fixed point\ndecimal numbers with maximum precision PREC, and to %g otherwise.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/seq>\nor available locally via: info '(coreutils) seq invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'f', long: 'format', arg: 'required' },
  { short: 's', long: 'separator', arg: 'required' },
  { short: 'w', long: 'equal-width' },
  { long: 'help' },
  { long: 'version' },
];

/** stdio's buffer for a pipe or file (st_blksize). */
const BUFFER = 4096;
/** seq.c SEQ_FAST_STEP_LIMIT. */
const FAST_STEP_LIMIT = 200n;

interface Operand {
  value: LongDouble;
  width: number;
  /** Digits after the point; Infinity when not fixed point (INT_MAX upstream). */
  precision: number;
}

class SeqError extends Error {}

/** upstream scan_arg: the value, and the width and precision of the number as written. */
function scanArg(arg: string): Operand {
  const value = parseLongDouble(arg);
  if (!value) throw new SeqError(`invalid floating point argument: ${quote(arg)}`);
  if (value.kind === 'nan') throw new SeqError(`invalid ${quote('not-a-number')} argument: ${quote(arg)}`);
  // Spaces and '+' are not output, so they do not count.
  const a = arg.replace(/^[ \t\n\v\f\r+]+/, '');
  let width = 0;
  let precision = Number.POSITIVE_INFINITY;
  const dp = a.indexOf('.');
  if (dp < 0 && !a.includes('p')) precision = 0;
  if (!/[xX]/.test(a) && value.kind === 'finite') {
    let fraction = 0;
    width = a.length;
    if (dp >= 0) {
      const after = a.slice(dp + 1);
      fraction = after.search(/[eE]/) < 0 ? after.length : after.search(/[eE]/);
      precision = fraction;
      // "#." prints as "#", ".#" and "-.#" as "0.#" and "-0.#".
      width += fraction === 0 ? -1 : dp === 0 || !/[0-9]/.test(a[dp - 1] as string) ? 1 : 0;
    }
    let e = a.indexOf('e');
    if (e < 0) e = a.indexOf('E');
    if (e >= 0) {
      let exponent = Number.parseInt(a.slice(e + 1), 10) || 0;
      precision += exponent < 0 ? -exponent : -Math.min(precision, exponent);
      width -= a.length - e;
      if (exponent < 0) {
        if (dp >= 0) {
          if (e === dp + 1) width++;
        } else width++;
        exponent = -exponent;
      } else {
        if (dp >= 0 && precision === 0 && fraction > 0) width--;
        exponent = -Math.min(precision, exponent);
      }
      width += exponent;
    }
  }
  return { value, width, precision };
}

/** A FORMAT split around its one directive, as upstream long_double_format checks it. */
interface Layout {
  prefix: string;
  spec: FloatSpec;
  suffix: string;
}

const literal = (s: string): string => s.replace(/%%/g, '%');

function parseFormat(fmt: string): Layout {
  let i = 0;
  for (; !(fmt[i] === '%' && fmt[i + 1] !== '%'); i += fmt[i] === '%' ? 2 : 1) {
    if (i >= fmt.length) throw new SeqError(`format ${quote(fmt)} has no % directive`);
  }
  const start = i++;
  let flags = '';
  while ("-+#0 '".includes(fmt[i] ?? 'x')) flags += fmt[i++];
  let width = '';
  while (/[0-9]/.test(fmt[i] ?? '')) width += fmt[i++];
  let precision: string | undefined;
  if (fmt[i] === '.') {
    i++;
    precision = '';
    while (/[0-9]/.test(fmt[i] ?? '')) precision += fmt[i++];
  }
  if (fmt[i] === 'L') i++;
  const conv = fmt[i];
  if (conv === undefined) throw new SeqError(`format ${quote(fmt)} ends in %`);
  if (!'efgaEFGA'.includes(conv)) throw new SeqError(`format ${quote(fmt)} has unknown %${conv} directive`);
  for (let k = i + 1; k < fmt.length; k += fmt[k] === '%' ? 2 : 1) {
    if (fmt[k] === '%' && fmt[k + 1] !== '%') throw new SeqError(`format ${quote(fmt)} has too many % directives`);
  }
  const spec: FloatSpec = { flags, conv, ...(width !== '' ? { width: Number(width) } : {}), ...(precision !== undefined ? { precision: Number(precision || '0') } : {}) };
  return { prefix: literal(fmt.slice(0, start)), spec, suffix: literal(fmt.slice(i + 1)) };
}

/** upstream get_default_format. */
function defaultLayout(first: Operand, step: Operand, last: Operand, equalWidth: boolean): Layout {
  const prec = Math.max(first.precision, step.precision);
  if (Number.isFinite(prec) && Number.isFinite(last.precision)) {
    if (equalWidth) {
      const firstWidth = first.width + (prec - first.precision) + (first.precision === 0 && prec > 0 ? 1 : 0);
      let lastWidth = last.width + (prec - last.precision);
      if (last.precision > 0 && prec === 0) lastWidth--;
      if (last.precision === 0 && prec > 0) lastWidth++;
      return { prefix: '', spec: { flags: '0', width: Math.max(firstWidth, lastWidth), precision: prec, conv: 'f' }, suffix: '' };
    }
    return { prefix: '', spec: { flags: '', precision: prec, conv: 'f' }, suffix: '' };
  }
  return { prefix: '', spec: { flags: '', conv: 'g' }, suffix: '' };
}

const allDigits = (s: string): boolean => /^[0-9]+$/.test(s);

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const argv = p.argv.slice(1);
  // Options end at the first operand, and an argument that looks like a negative number is one
  // (upstream checks argv[optind] for "-" followed by a digit or "." before each getopt call).
  let stop = 0;
  while (stop < argv.length) {
    const a = argv[stop] as string;
    if (a === '--' || !a.startsWith('-') || a === '-' || /^-[.0-9]/.test(a)) break;
    if (a.startsWith('--')) {
      stop += !a.includes('=') && /^--(f|fo|for|form|forma|format|s|se|sep|sepa|separ|separa|separat|separato|separator)$/.test(a) ? 2 : 1;
      continue;
    }
    const k = a.slice(1).search(/[fs]/);
    stop += k >= 0 && k === a.length - 2 ? 2 : 1;
  }
  const r = getopt(argv.slice(0, stop), { options: OPTIONS, stopAtOperand: true });
  if (!r.ok) {
    if ('unsupported' in r) return yield* p.unsupported({ kind: 'flag', what: `the flag ${r.unsupported}` });
    return yield* usageError(p, r.error);
  }
  const has = (id: string): boolean => r.options.some((o) => o.id === id);
  const last = (id: string): string | undefined => [...r.options].reverse().find((o) => o.id === id)?.value;
  if (has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let rest = argv.slice(stop);
  if (rest[0] === '--' ) rest = rest.slice(1);
  const operands = [...r.operands, ...rest];
  const format = last('format');
  const separator = last('separator') ?? '\n';
  const equalWidth = has('equal-width');
  if (operands.length === 0) return yield* usageError(p, 'missing operand');
  if (operands.length > 3) return yield* usageError(p, `extra operand ${quote(operands[3] as string)}`);

  let layout: Layout | undefined;
  let first: Operand = { value: fromBigInt(1n), width: 1, precision: 0 };
  let step: Operand = { value: fromBigInt(1n), width: 1, precision: 0 };
  let lastOp: Operand;
  try {
    if (format !== undefined) layout = parseFormat(format);
  } catch (e) {
    if (!(e instanceof SeqError)) throw e;
    // A bad FORMAT ends seq at once, without the "Try" line.
    yield* warn(p, e.message);
    return 1;
  }
  if (layout?.spec.conv.toLowerCase() === 'a') return yield* p.unsupported({ kind: 'flag-value', what: 'the %a format' });
  try {
    lastOp = scanArg(operands[0] as string);
    if (operands.length >= 2) {
      first = lastOp;
      lastOp = scanArg(operands[1] as string);
      if (operands.length === 3) {
        step = lastOp;
        if (isZero(step.value)) throw new SeqError(`invalid Zero increment value: ${quote(operands[1] as string)}`);
        lastOp = scanArg(operands[2] as string);
      }
    }
  } catch (e) {
    if (!(e instanceof SeqError)) throw e;
    return yield* usageError(p, e.message);
  }
  if (layout && equalWidth) return yield* usageError(p, 'format string may not be specified when printing equal width strings');

  let buffer = '';
  const emit = function* (s: string): Op<void> {
    buffer += s;
    if (buffer.length >= BUFFER) {
      yield* p.write(1, buffer);
      buffer = '';
    }
  };

  if (format === undefined && !equalWidth && separator.length === 1 && operands.every(allDigits)) {
    const [a, b, c] = operands.map((o) => BigInt(o));
    const from = operands.length >= 2 ? (a as bigint) : 1n;
    const to = operands.length === 1 ? (a as bigint) : operands.length === 2 ? (b as bigint) : (c as bigint);
    const inc = operands.length === 3 ? (b as bigint) : 1n;
    if (inc > 0n && inc <= FAST_STEP_LIMIT) {
      // seq_fast: decimal strings, exact for any size.
      if (from <= to) {
        for (let x = from; x <= to; x += inc) yield* emit(`${x}${x + inc <= to ? separator : '\n'}`);
      }
      yield* p.write(1, buffer);
      return 0;
    }
  }

  layout ??= defaultLayout(first, step, lastOp, equalWidth);
  const fmt = (x: LongDouble): string => formatLongDouble(x, layout.spec);
  const out = (x: LongDouble): string => layout.prefix + fmt(x) + layout.suffix;
  const down = cmp(step.value, fromBigInt(0n)) < 0;
  const beyond = (x: LongDouble): boolean => (down ? cmp(x, lastOp.value) < 0 : cmp(lastOp.value, x) < 0);
  if (!beyond(first.value)) {
    let x = first.value;
    for (let i = 1n; ; i++) {
      const x0 = x;
      yield* emit(out(x));
      x = add(first.value, mul(fromBigInt(i), step.value));
      if (beyond(x)) {
        // The number just past LAST is printed if it prints as LAST and differently from the one
        // before: rounding must not lose the last value (seq 0 0.000001 0.000003).
        const shown = parseLongDouble(fmt(x));
        if (!(shown && cmp(shown, lastOp.value) === 0 && fmt(x0) !== fmt(x))) break;
        yield* emit(separator);
        yield* emit(out(x));
        break;
      }
      yield* emit(separator);
    }
    yield* emit('\n');
  }
  yield* p.write(1, buffer);
  return 0;
}

export const seqProgram: ProgramSpec = { name: 'seq', main };
