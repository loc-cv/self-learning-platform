// The printf builtin. docs: bash(1) 5.2 printf; printf(1)
// reference: bash 5.2.21 output and errors, captured 2026-11-16 (packages/host/transcripts/shell/printf.t)
// The format is reused as long as arguments remain; a missing argument is an empty string or 0.

import type { Builtin, Shell } from '../shell.ts';
import { setVar } from '../state.ts';
import { expandEchoEscapes } from './core.ts';
import { formatFloat, formatInteger, formatString, parseCFloat, parseCInteger, type ConvSpec } from '../../text/cformat.ts';
import type { Op } from '../../proc/program.ts';
import { byteChar, decodeBytes } from '../../text/bytes.ts';

/** Escapes in the format string itself (\NNN without a leading 0, unlike %b). */
function formatEscape(fmt: string, i: number): { text: string; next: number } {
  const e = fmt[i + 1];
  const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", '?': '?' };
  if (e === undefined) return { text: '\\', next: i + 1 };
  if (e in simple) return { text: simple[e] as string, next: i + 2 };
  if (/[0-7]/.test(e)) {
    let j = i + 1;
    let d = '';
    while (d.length < 3 && /[0-7]/.test(fmt[j] ?? '')) d += fmt[j++];
    return { text: byteChar(parseInt(d, 8) & 0xff), next: j };
  }
  if (e === 'x' && /[0-9a-fA-F]/.test(fmt[i + 2] ?? '')) {
    let j = i + 2;
    let d = '';
    while (d.length < 2 && /[0-9a-fA-F]/.test(fmt[j] ?? '')) d += fmt[j++];
    return { text: byteChar(parseInt(d, 16)), next: j };
  }
  if ((e === 'u' || e === 'U') && /[0-9a-fA-F]/.test(fmt[i + 2] ?? '')) {
    let j = i + 2;
    let d = '';
    while (d.length < (e === 'u' ? 4 : 8) && /[0-9a-fA-F]/.test(fmt[j] ?? '')) d += fmt[j++];
    return { text: String.fromCodePoint(parseInt(d, 16)), next: j };
  }
  return { text: `\\${e}`, next: i + 2 };
}

/** %q: quotes for reuse as shell input, with backslashes (bash's sh_backslash_quote). */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for
  if (/[\x00-\x1f\x7f]/.test(s)) {
    // eslint-disable-next-line no-control-regex -- see above
    const body = s.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, (c) => {
      const named: Record<string, string> = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x1b': '\\E' };
      return named[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`;
    });
    return `$'${body}'`;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (" \t'\"\\|&;()<>!{}*[]?^$`,".includes(c) || ((c === '#' || c === '~' || c === '=') && i === 0)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

export const printf: Builtin = function* (sh: Shell, argv: string[]): Op<number> {
  let i = 1;
  let target: string | undefined;
  if (argv[i] === '-v') {
    target = argv[i + 1];
    if (target === undefined) {
      yield* sh.diag('printf: -v: option requires an argument');
      yield* sh.err('printf: usage: printf [-v var] format [arguments]\n');
      return 2;
    }
    i += 2;
  } else if (argv[i]?.startsWith('-') && argv[i] !== '--' && argv[i] !== '-' && (argv[i]?.length ?? 0) > 1) {
    yield* sh.diag(`printf: ${argv[i]?.slice(0, 2)}: invalid option`);
    yield* sh.err('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  if (argv[i] === '--') i++;
  const fmt = argv[i];
  if (fmt === undefined) {
    yield* sh.err('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  const args = argv.slice(i + 1);
  let ai = 0;
  let status = 0;
  let out = '';
  const errors: string[] = [];
  const nextArg = (): string | undefined => (ai < args.length ? args[ai++] : undefined);

  const intArg = (): bigint => {
    const a = nextArg();
    if (a === undefined) return 0n;
    const r = parseCInteger(a);
    if (!r.ok || !r.range) {
      errors.push(!r.range ? `printf: ${a}: Numerical result out of range` : `printf: ${a}: invalid number`);
      status = 1;
    }
    return r.value;
  };
  const floatArg = (): number => {
    const a = nextArg();
    if (a === undefined) return 0;
    const r = parseCFloat(a);
    if (!r.ok) {
      errors.push(`printf: ${a}: invalid number`);
      status = 1;
    }
    return r.value;
  };

  let stop = false;
  do {
    const startAi = ai;
    for (let k = 0; k < fmt.length && !stop; ) {
      const c = fmt[k] as string;
      if (c === '\\') {
        const e = formatEscape(fmt, k);
        out += e.text;
        k = e.next;
        continue;
      }
      if (c !== '%') {
        out += c;
        k++;
        continue;
      }
      if (fmt[k + 1] === '%') {
        out += '%';
        k += 2;
        continue;
      }
      let j = k + 1;
      let flags = '';
      while ("-+ #0'".includes(fmt[j] ?? 'x')) flags += fmt[j++];
      const spec: ConvSpec = { flags, conv: '' };
      if (fmt[j] === '*') {
        const w = Number(intArg());
        if (w < 0) {
          spec.flags += '-';
          spec.width = -w;
        } else spec.width = w;
        j++;
      } else {
        let w = '';
        while (/[0-9]/.test(fmt[j] ?? '')) w += fmt[j++];
        if (w !== '') spec.width = Number(w);
      }
      if (fmt[j] === '.') {
        j++;
        if (fmt[j] === '*') {
          spec.precision = Math.max(0, Number(intArg()));
          j++;
        } else {
          let p = '';
          while (/[0-9]/.test(fmt[j] ?? '')) p += fmt[j++];
          spec.precision = p === '' ? 0 : Number(p);
        }
      }
      // upstream: bash builtins/printf.def LENMODS "hjlLtz"
      while ('hjlLtz'.includes(fmt[j] ?? 'x')) j++;
      const conv = fmt[j];
      if (conv === undefined) {
        yield* sh.out(out);
        yield* sh.diag(`printf: \`${fmt.slice(k, j)}': missing format character`);
        return 1;
      }
      spec.conv = conv;
      k = j + 1;
      switch (conv) {
        case 'd':
        case 'i':
        case 'o':
        case 'u':
        case 'x':
        case 'X':
          out += formatInteger(intArg(), spec);
          break;
        case 'f':
        case 'F':
        case 'e':
        case 'E':
        case 'g':
        case 'G':
          out += formatFloat(floatArg(), spec);
          break;
        case 'a':
        case 'A':
          yield* sh.out(out);
          return yield* sh.notice('the printf conversion %a', 'flag-value', argv.join(' '));
        case 'c':
          out += formatString([...(nextArg() ?? '')][0] ?? '', spec);
          break;
        case 's':
          out += formatString(nextArg() ?? '', spec);
          break;
        case 'b': {
          const r = expandEchoEscapes(nextArg() ?? '');
          out += formatString(r.text, spec);
          if (r.stop) stop = true;
          break;
        }
        case 'q':
          out += formatString(shellQuote(nextArg() ?? ''), spec);
          break;
        default:
          yield* sh.out(out);
          yield* sh.diag(`printf: \`${conv}': invalid format character`);
          return 1;
      }
    }
    // Reuse the format while arguments remain and the format consumed some.
    if (ai === startAi) break;
  } while (ai < args.length && !stop);

  // bash 5.2.21 prints conversion errors before the output it formatted (`printf "%d\n" abc`
  // shows the error, then 0), captured 2026-11-16.
  for (const e of errors) yield* sh.diag(e);
  out = decodeBytes(out);
  if (target !== undefined) setVar(sh.state, target, out);
  else yield* sh.out(out);
  return status;
};
