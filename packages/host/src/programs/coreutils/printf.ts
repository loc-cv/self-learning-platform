// printf — format and print data. GNU coreutils 9.4 (not the bash builtin, which runs unless the
// binary is named: `env printf`, `/usr/bin/printf`, `xargs printf`).
//   docs: printf --help and printf(1) of coreutils 9.4
//   upstream: coreutils src/printf.c main, print_formatted, print_direc, print_esc, STRTOX,
//             verify_numeric
//   reference: coreutils 9.4 printf, captured 2026-11-16 (packages/host/transcripts/coreutils/printf.t)
// Differences from the builtin: messages name argv[0] and quote the argument (‘abc’: expected a
// numeric value), %b and %q take no flags or width, an invalid directive ends printf, \c exits
// with status 0, floats are long doubles (lib/longdouble.ts), %s widths count bytes. Messages
// flush the output before them, as gnulib's error() flushes stdout.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { byteChar, decodeBytes } from '../../text/bytes.ts';
import { formatInteger, type ConvSpec } from '../../text/cformat.ts';
import { formatLongDouble, fromBigInt, parseLongDoublePrefix, type LongDouble } from '../lib/longdouble.ts';
import { quote, quotef } from '../lib/quote.ts';

/** `printf --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 FORMAT [ARGUMENT]...\n  or:  \u0000 OPTION\nPrint ARGUMENT(s) according to FORMAT, or execute according to OPTION:\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nFORMAT controls the output as in C printf.  Interpreted sequences are:\n\n  \\\"      double quote\n  \\\\      backslash\n  \\a      alert (BEL)\n  \\b      backspace\n  \\c      produce no further output\n  \\e      escape\n  \\f      form feed\n  \\n      new line\n  \\r      carriage return\n  \\t      horizontal tab\n  \\v      vertical tab\n  \\NNN    byte with octal value NNN (1 to 3 digits)\n  \\xHH    byte with hexadecimal value HH (1 to 2 digits)\n  \\uHHHH  Unicode (ISO/IEC 10646) character with hex value HHHH (4 digits)\n  \\UHHHHHHHH  Unicode character with hex value HHHHHHHH (8 digits)\n  %%      a single %\n  %b      ARGUMENT as a string with '\\' escapes interpreted,\n          except that octal escapes are of the form \\0 or \\0NNN\n  %q      ARGUMENT is printed in a format that can be reused as shell input,\n          escaping non-printable characters with the proposed POSIX $'' syntax.\n\nand all C format specifications ending with one of diouxXfeEgGcs, with\nARGUMENTs converted to proper type first.  Variable widths are handled.\n\nNOTE: your shell may have its own version of printf, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/printf>\nor available locally via: info '(coreutils) printf invocation'\n";

const INTMAX_MAX = (1n << 63n) - 1n;
const INTMAX_MIN = -(1n << 63n);
const UINTMAX_MAX = (1n << 64n) - 1n;
const INT_MAX = 2147483647n;
const INT_MIN = -2147483648n;

/** Ends printf at once with a status (a fatal error, or \c). */
class Stop extends Error {
  readonly status: number;
  constructor(status: number) {
    super('printf stop');
    this.status = status;
  }
}

/** strerror(ERANGE) of glibc, as printf printed it (captured 2026-11-16). */
const ERANGE_TEXT = 'Numerical result out of range';

/** UTF-8 bytes of a string, each as a placeholder character (text/bytes.ts). */
function bytesOf(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    const bs = c < 0x80 ? [c] : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)] : c < 0x10000 ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)] : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    for (const b of bs) out.push(byteChar(b));
  }
  return out;
}

/** %s and %c: precision and width count bytes, as printf(3) does. */
function formatBytes(s: string, spec: ConvSpec): string {
  let bytes = bytesOf(s);
  if (spec.precision !== undefined) bytes = bytes.slice(0, spec.precision);
  const body = bytes.join('');
  const pad = ' '.repeat(Math.max(0, (spec.width ?? 0) - bytes.length));
  return spec.flags.includes('-') ? body + pad : pad + body;
}

interface Parsed<T> {
  value: T;
  /** All of the string was a number, only a prefix, or none of it. */
  ok: 'full' | 'partial' | 'none';
  range: boolean;
}

/** strtoimax/strtoumax(3) with base 0. */
function strtoint(s: string, unsigned: boolean): Parsed<bigint> {
  const m = /^[ \t\n\v\f\r]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(s);
  if (!m) return { value: 0n, ok: s === '' ? 'full' : 'none', range: true };
  const d = m[2] as string;
  let v = /^0[xX]/.test(d) ? BigInt(d) : d.length > 1 && d.startsWith('0') ? BigInt(`0o${d.slice(1)}`) : BigInt(d);
  let range = true;
  if (unsigned) {
    if (v > UINTMAX_MAX) {
      v = UINTMAX_MAX;
      range = false;
    } else if (m[1] === '-') v = v === 0n ? 0n : (1n << 64n) - v;
  } else {
    if (m[1] === '-') v = -v;
    if (v > INTMAX_MAX || v < INTMAX_MIN) {
      v = v > 0n ? INTMAX_MAX : INTMAX_MIN;
      range = false;
    }
  }
  return { value: v, ok: m[0].length === s.length ? 'full' : 'partial', range };
}

/** LDBL_MAX is just below 2^16384: a larger magnitude overflows strtold(3) to infinity with ERANGE. */
function strtold(s: string): Parsed<LongDouble> {
  const r = parseLongDoublePrefix(s);
  if (!r) return { value: fromBigInt(0n), ok: s === '' ? 'full' : 'none', range: true };
  let value = r.value;
  let range = true;
  if (value.kind === 'finite' && value.m !== 0n && value.e + 64 > 16384) {
    value = { kind: 'inf', neg: value.neg };
    range = false;
  }
  return { value, ok: r.length === s.length ? 'full' : 'partial', range };
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const prog = p.argv[0] ?? p.name;
  let argv = p.argv.slice(1);
  if (argv.length === 1) {
    if (argv[0] === '--help') {
      yield* p.write(1, HELP.split('\u0000').join(prog));
      return 0;
    }
    if (argv[0] === '--version') return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  }
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) {
    yield* p.write(2, `${prog}: missing operand\nTry '${prog} --help' for more information.\n`);
    return 1;
  }
  const posix = p.env['POSIXLY_CORRECT'] !== undefined;
  const format = argv[0] as string;
  let args = argv.slice(1);
  let status = 0;
  let out = '';

  const flush = function* (): Op<void> {
    if (out !== '') yield* p.write(1, decodeBytes(out));
    out = '';
  };
  const error = function* (msg: string): Op<void> {
    yield* flush();
    yield* p.write(2, `${prog}: ${msg}\n`);
  };
  const fatal = function* (msg: string): Op<never> {
    yield* error(msg);
    throw new Stop(1);
  };

  /** STRTOX: a leading quote gives the next character's code (a warning if more follows). */
  const numeric = function* <T>(s: string, parse: (s: string) => Parsed<T>, fromCode: (c: number) => T): Op<T> {
    if ((s.startsWith('"') || s.startsWith("'")) && s.length > 1) {
      const ch = String.fromCodePoint(s.codePointAt(1) as number);
      const rest = s.slice(1 + ch.length);
      if (rest !== '' && !posix) yield* error(`warning: ${rest}: character(s) following character constant have been ignored`);
      return fromCode(ch.codePointAt(0) as number);
    }
    const r = parse(s);
    if (!r.range) {
      yield* error(`${quote(s)}: ${ERANGE_TEXT}`);
      status = 1;
    } else if (r.ok !== 'full') {
      yield* error(r.ok === 'none' ? `${quote(s)}: expected a numeric value` : `${quote(s)}: value not completely converted`);
      status = 1;
    }
    return r.value;
  };
  const intArg = (s: string, unsigned: boolean): Op<bigint> => numeric(s, (x) => strtoint(x, unsigned), (c) => BigInt(c));

  /** print_esc: one escape at fmt[i] (a backslash); returns the index after it. */
  const escape = function* (fmt: string, i: number, octal0: boolean): Op<number> {
    let j = i + 1;
    const e = fmt[j];
    if (e === 'x') {
      let v = 0;
      let n = 0;
      for (j++; n < 2 && /[0-9a-fA-F]/.test(fmt[j] ?? ''); n++, j++) v = v * 16 + parseInt(fmt[j] as string, 16);
      if (n === 0) yield* fatal('missing hexadecimal number in escape');
      out += byteChar(v);
      return j;
    }
    if (e !== undefined && e >= '0' && e <= '7') {
      if (octal0 && e === '0') j++;
      let v = 0;
      for (let n = 0; n < 3 && /[0-7]/.test(fmt[j] ?? ''); n++, j++) v = v * 8 + Number(fmt[j]);
      out += byteChar(v & 0xff);
      return j;
    }
    if (e !== undefined && '"\\abcefnrtv'.includes(e)) {
      const map: Record<string, string> = { '"': '"', '\\': '\\', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
      if (e === 'c') {
        yield* flush();
        throw new Stop(0);
      }
      out += map[e];
      return j + 1;
    }
    if (e === 'u' || e === 'U') {
      let v = 0;
      j++;
      for (let n = e === 'u' ? 4 : 8; n > 0; n--, j++) {
        if (!/[0-9a-fA-F]/.test(fmt[j] ?? '')) yield* fatal('missing hexadecimal number in escape');
        v = v * 16 + parseInt(fmt[j] as string, 16);
      }
      if ((v >= 0xd800 && v <= 0xdfff) || v > 0x10ffff) yield* fatal(`invalid universal character name \\${e}${v.toString(16).padStart(e === 'u' ? 4 : 8, '0')}`);
      out += String.fromCodePoint(v);
      return j;
    }
    out += '\\';
    if (e !== undefined) {
      out += e;
      j++;
    }
    return j;
  };

  /** print_formatted: one pass over the format; returns how many arguments it used. */
  const pass = function* (): Op<number> {
    const before = args.length;
    const next = (): string | undefined => {
      const a = args[0];
      if (a !== undefined) args = args.slice(1);
      return a;
    };
    for (let i = 0; i < format.length; ) {
      const c = format[i] as string;
      if (c === '\\') {
        i = yield* escape(format, i, false);
        continue;
      }
      if (c !== '%') {
        out += c;
        i++;
        continue;
      }
      const start = i++;
      if (format[i] === '%') {
        out += '%';
        i++;
        continue;
      }
      if (format[i] === 'b') {
        i++;
        const a = next();
        if (a !== undefined) {
          for (let k = 0; k < a.length; ) {
            if (a[k] === '\\') k = yield* escape(a, k, true);
            else out += a[k++];
          }
        }
        continue;
      }
      if (format[i] === 'q') {
        i++;
        const a = next();
        if (a !== undefined) out += quotef(a);
        continue;
      }
      const ok = new Set([...'aAcdeEfFgGiosuxX']);
      let flags = '';
      for (;;) {
        const f = format[i];
        if (f === 'I' || f === "'") ['a', 'A', 'c', 'e', 'E', 'o', 's', 'x', 'X'].forEach((k) => ok.delete(k));
        else if (f === '#') ['c', 'd', 'i', 's', 'u'].forEach((k) => ok.delete(k));
        else if (f === '0') ['c', 's'].forEach((k) => ok.delete(k));
        else if (f !== '-' && f !== '+' && f !== ' ') break;
        flags += f;
        i++;
      }
      const spec: ConvSpec = { flags, conv: '' };
      if (format[i] === '*') {
        i++;
        const a = next();
        let w = 0n;
        if (a !== undefined) {
          w = yield* intArg(a, false);
          if (w < INT_MIN || w > INT_MAX) yield* fatal(`invalid field width: ${quote(a)}`);
        }
        if (w < 0n) {
          spec.flags += '-';
          spec.width = Number(-w);
        } else spec.width = Number(w);
      } else {
        let w = '';
        while (/[0-9]/.test(format[i] ?? '')) w += format[i++];
        if (w !== '') spec.width = Number(w);
      }
      if (format[i] === '.') {
        i++;
        ok.delete('c');
        if (format[i] === '*') {
          i++;
          const a = next();
          let pr = 0n;
          if (a !== undefined) {
            pr = yield* intArg(a, false);
            if (pr > INT_MAX) yield* fatal(`invalid precision: ${quote(a)}`);
          }
          // A negative precision is taken as omitted.
          if (pr >= 0n) spec.precision = Number(pr);
        } else {
          let pr = '';
          while (/[0-9]/.test(format[i] ?? '')) pr += format[i++];
          spec.precision = pr === '' ? 0 : Number(pr);
        }
      }
      while ('lLhjtz'.includes(format[i] ?? 'x')) i++;
      const conv = format[i];
      if (conv === undefined || !ok.has(conv)) yield* fatal(`${format.slice(start, i + 1)}: invalid conversion specification`);
      i++;
      spec.conv = conv as string;
      const arg = next() ?? '';
      switch (conv) {
        case 'd':
        case 'i':
        case 'o':
        case 'u':
        case 'x':
        case 'X':
        {
          // The argument first: its error flushes the output so far.
          const v = yield* intArg(arg, conv !== 'd' && conv !== 'i');
          out += formatInteger(v, spec);
          break;
        }
        case 'a':
        case 'A':
          yield* flush();
          return yield* p.unsupported({ kind: 'flag-value', what: 'the printf conversion %a' });
        case 'c': {
          // The first byte of the argument (NUL for an empty one), padded to the width.
          const b = arg === '' ? '\0' : (bytesOf(arg)[0] as string);
          const pad = ' '.repeat(Math.max(0, (spec.width ?? 0) - 1));
          out += spec.flags.includes('-') ? b + pad : pad + b;
          break;
        }
        case 's':
          out += formatBytes(arg, spec);
          break;
        default: {
          const v = yield* numeric(arg, strtold, (c) => fromBigInt(BigInt(c)));
          out += formatLongDouble(v, spec);
        }
      }
    }
    return before - args.length;
  };

  try {
    let used: number;
    do {
      used = yield* pass();
    } while (used > 0 && args.length > 0);
    if (args.length > 0) yield* error(`warning: ignoring excess arguments, starting with ${quote(args[0] as string)}`);
    yield* flush();
  } catch (e) {
    if (e instanceof Stop) return e.status;
    throw e;
  }
  return status;
}

export const printfProgram: ProgramSpec = { name: 'printf', main };
