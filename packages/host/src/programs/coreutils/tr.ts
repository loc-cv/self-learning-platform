// tr — translate or delete characters. GNU coreutils 9.4.
//   docs: tr --help and tr(1) of coreutils 9.4
//   upstream: coreutils src/tr.c (main's operand checks, unquote, build_spec_list,
//             find_bracketed_repeat, validate, get_spec_stats, string2_extend, squeeze_filter)
//   reference: coreutils 9.4 tr under LANG=C.UTF-8, captured 2026-11-16
//              (packages/host/transcripts/coreutils/tr.t)
// tr works on bytes: a multibyte character is several bytes, and the classes are the C.UTF-8
// single-byte ones (ASCII). Streams its input line by line.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { fromOctets, toOctets } from '../lib/octets.ts';
import { quote } from '../lib/quote.ts';
import { readSome } from '../lib/textio.ts';

/** `tr --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: tr [OPTION]... STRING1 [STRING2]\nTranslate, squeeze, and/or delete characters from standard input,\nwriting to standard output.  STRING1 and STRING2 specify arrays of\ncharacters ARRAY1 and ARRAY2 that control the action.\n\n  -c, -C, --complement    use the complement of ARRAY1\n  -d, --delete            delete characters in ARRAY1, do not translate\n  -s, --squeeze-repeats   replace each sequence of a repeated character\n                            that is listed in the last specified ARRAY,\n                            with a single occurrence of that character\n  -t, --truncate-set1     first truncate ARRAY1 to length of ARRAY2\n      --help        display this help and exit\n      --version     output version information and exit\n\nARRAYs are specified as strings of characters.  Most represent themselves.\nInterpreted sequences are:\n\n  \\NNN            character with octal value NNN (1 to 3 octal digits)\n  \\\\              backslash\n  \\a              audible BEL\n  \\b              backspace\n  \\f              form feed\n  \\n              new line\n  \\r              return\n  \\t              horizontal tab\n  \\v              vertical tab\n  CHAR1-CHAR2     all characters from CHAR1 to CHAR2 in ascending order\n  [CHAR*]         in ARRAY2, copies of CHAR until length of ARRAY1\n  [CHAR*REPEAT]   REPEAT copies of CHAR, REPEAT octal if starting with 0\n  [:alnum:]       all letters and digits\n  [:alpha:]       all letters\n  [:blank:]       all horizontal whitespace\n  [:cntrl:]       all control characters\n  [:digit:]       all digits\n  [:graph:]       all printable characters, not including space\n  [:lower:]       all lower case letters\n  [:print:]       all printable characters, including space\n  [:punct:]       all punctuation characters\n  [:space:]       all horizontal or vertical whitespace\n  [:upper:]       all upper case letters\n  [:xdigit:]      all hexadecimal digits\n  [=CHAR=]        all characters which are equivalent to CHAR\n\nTranslation occurs if -d is not given and both STRING1 and STRING2 appear.\n-t is only significant when translating.  ARRAY2 is extended to length of\nARRAY1 by repeating its last character as necessary.  Excess characters\nof ARRAY2 are ignored.  Character classes expand in unspecified order;\nwhile translating, [:lower:] and [:upper:] may be used in pairs to\nspecify case conversion.  Squeezing occurs after translation or deletion.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/tr>\nor available locally via: info '(coreutils) tr invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'complement', id: 'complement' },
  { short: 'C', id: 'complement' },
  { short: 'd', long: 'delete' },
  { short: 's', long: 'squeeze-repeats' },
  { short: 't', long: 'truncate-set1' },
  { long: 'help' },
  { long: 'version' },
];

type ClassName = 'alnum' | 'alpha' | 'blank' | 'cntrl' | 'digit' | 'graph' | 'lower' | 'print' | 'punct' | 'space' | 'upper' | 'xdigit';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
const isUpper = (b: number): boolean => b >= 65 && b <= 90;
const isLower = (b: number): boolean => b >= 97 && b <= 122;
const isDigit = (b: number): boolean => b >= 48 && b <= 57;
const isAlnum = (b: number): boolean => isUpper(b) || isLower(b) || isDigit(b);
const isPrint = (b: number): boolean => b >= 32 && b <= 126;

/** The C.UTF-8 single-byte classes, in ascending byte order. */
const CLASSES: Record<ClassName, (b: number) => boolean> = {
  alnum: isAlnum,
  alpha: (b) => isUpper(b) || isLower(b),
  blank: (b) => b === 32 || b === 9,
  cntrl: (b) => b < 32 || b === 127,
  digit: isDigit,
  graph: (b) => b > 32 && b < 127,
  lower: isLower,
  print: isPrint,
  punct: (b) => b > 32 && b < 127 && !isAlnum(b),
  space: (b) => (b >= 9 && b <= 13) || b === 32,
  upper: isUpper,
  xdigit: (b) => isDigit(b) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102),
};

type Elem =
  | { kind: 'char'; c: number }
  | { kind: 'range'; lo: number; hi: number }
  | { kind: 'class'; name: ClassName }
  | { kind: 'equiv'; c: number }
  | { kind: 'repeat'; c: number; count: number | 'fill' };

interface Spec {
  elems: Elem[];
  warnings: string[];
}

/** upstream: tr.c make_printable_char */
const printable = (b: number): string => (isPrint(b) ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`);

/** upstream: tr.c unquote — bytes with a flag for those that came from an escape. */
function unquote(arg: string, warnings: string[]): { b: number[]; esc: boolean[] } {
  const src = toOctets(arg);
  const b: number[] = [];
  const esc: boolean[] = [];
  const NAMED: Record<number, number> = { 0x61: 7, 0x62: 8, 0x66: 12, 0x6e: 10, 0x72: 13, 0x74: 9, 0x76: 11 };
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as number;
    if (c !== 0x5c) {
      b.push(c);
      esc.push(false);
      continue;
    }
    const n = src[i + 1];
    if (n === undefined) {
      warnings.push('warning: an unescaped backslash at end of string is not portable');
      b.push(0x5c);
      esc.push(true);
      continue;
    }
    i++;
    if (NAMED[n] !== undefined) {
      b.push(NAMED[n] as number);
    } else if (n >= 0x30 && n <= 0x37) {
      let v = n - 0x30;
      let digits = 1;
      while (digits < 3 && (src[i + 1] ?? 0) >= 0x30 && (src[i + 1] ?? 0) <= 0x37) {
        const next = v * 8 + ((src[i + 1] as number) - 0x30);
        if (next > 255) {
          // upstream: tr.c unquote, "\400" is "\40" then "0".
          const d = (k: number) => String.fromCharCode(src[k] as number);
          warnings.push(`warning: the ambiguous octal escape \\${d(i - 1)}${d(i)}${d(i + 1)} is being\n\tinterpreted as the 2-byte sequence \\0${d(i - 1)}${d(i)}, ${d(i + 1)}`);
          break;
        }
        v = next;
        digits++;
        i++;
      }
      b.push(v);
    } else b.push(n);
    esc.push(true);
  }
  return { b, esc };
}

type Parsed = { ok: true; spec: Spec } | { ok: false; message: string };

/** upstream: tr.c build_spec_list */
function parseSpec(arg: string): Parsed {
  const warnings: string[] = [];
  const { b, esc } = unquote(arg, warnings);
  const is = (k: number, ch: string): boolean => k < b.length && !esc[k] && b[k] === ch.charCodeAt(0);
  const elems: Elem[] = [];
  const len = b.length;
  for (let i = 0; i < len; ) {
    if (is(i, '[') && i + 1 < len) {
      if (is(i + 1, ':') || is(i + 1, '=')) {
        const delim = b[i + 1] as number;
        // The closing ":]" or "=]".
        let close = -1;
        for (let k = i + 2; k + 1 < len; k++) {
          if (!esc[k] && b[k] === delim && is(k + 1, ']')) {
            close = k;
            break;
          }
        }
        if (close >= 0) {
          const opnd = b.slice(i + 2, close);
          if (opnd.length === 0) {
            return { ok: false, message: delim === 0x3a ? "missing character class name '[::]'" : "missing equivalence class character '[==]'" };
          }
          const text = fromOctets(opnd);
          if (delim === 0x3a) {
            if (!(text in CLASSES)) {
              if (!repeatShape(b, esc, i + 1)) return { ok: false, message: `invalid character class ${quote(opnd.map(printable).join(''))}` };
            } else {
              elems.push({ kind: 'class', name: text as ClassName });
              i = close + 2;
              continue;
            }
          } else {
            if (opnd.length !== 1) {
              if (!repeatShape(b, esc, i + 1)) return { ok: false, message: `${opnd.map(printable).join('')}: equivalence class operand must be a single character` };
            } else {
              elems.push({ kind: 'equiv', c: opnd[0] as number });
              i = close + 2;
              continue;
            }
          }
        }
      }
      // [c*n] or [c*]
      const rep = bracketedRepeat(b, esc, i + 1);
      if (typeof rep === 'string') return { ok: false, message: rep };
      if (rep) {
        elems.push({ kind: 'repeat', c: rep.c, count: rep.count });
        i = rep.close + 1;
        continue;
      }
    }
    if (is(i + 1, '-') && i + 2 < len) {
      const lo = b[i] as number;
      const hi = b[i + 2] as number;
      if (hi < lo) return { ok: false, message: `range-endpoints of '${printable(lo)}-${printable(hi)}' are in reverse collating sequence order` };
      elems.push({ kind: 'range', lo, hi });
      i += 3;
      continue;
    }
    elems.push({ kind: 'char', c: b[i] as number });
    i++;
  }
  return { ok: true, spec: { elems, warnings } };
}

/** upstream: tr.c star_digits_closebracket — "c*digits]" at `k`. */
function repeatShape(b: number[], esc: boolean[], k: number): boolean {
  if (b[k + 1] !== 0x2a || esc[k + 1]) return false;
  let j = k + 2;
  while (j < b.length && isDigit(b[j] as number) && !esc[j]) j++;
  return j < b.length && b[j] === 0x5d && !esc[j];
}

/** upstream: tr.c find_bracketed_repeat — `c*n]` starting at `k`; undefined when not one. */
function bracketedRepeat(b: number[], esc: boolean[], k: number): { c: number; count: number | 'fill'; close: number } | string | undefined {
  if (k + 1 >= b.length || b[k + 1] !== 0x2a || esc[k + 1]) return undefined;
  for (let j = k + 2; j < b.length; j++) {
    if (b[j] === 0x5d && !esc[j]) {
      const digits = fromOctets(b.slice(k + 2, j));
      if (digits === '') return { c: b[k] as number, count: 'fill', close: j };
      const ok = digits.startsWith('0') ? /^[0-7]+$/.test(digits) : /^[0-9]+$/.test(digits);
      const n = ok ? parseInt(digits, digits.startsWith('0') ? 8 : 10) : NaN;
      if (!ok || !Number.isSafeInteger(n)) return `invalid repeat count ${quote(digits)} in [c*n] construct`;
      return { c: b[k] as number, count: n === 0 ? 'fill' : n, close: j };
    }
  }
  return undefined;
}

/** An expanded set: each byte, and for class members the class and whether it starts it. */
interface Expanded {
  bytes: number[];
  cls: (ClassName | undefined)[];
  starts: boolean[];
}

function expand(spec: Spec, fillTo: number | undefined): Expanded {
  const out: Expanded = { bytes: [], cls: [], starts: [] };
  const fixed = spec.elems.reduce((n, e) => n + (e.kind === 'repeat' && e.count === 'fill' ? 0 : sizeOf(e)), 0);
  for (const e of spec.elems) {
    let bytes: number[];
    let cls: ClassName | undefined;
    switch (e.kind) {
      case 'char':
      case 'equiv':
        bytes = [e.c];
        break;
      case 'range':
        bytes = range(e.lo, e.hi);
        break;
      case 'class':
        bytes = range(0, 255).filter(CLASSES[e.name]);
        cls = e.name;
        break;
      case 'repeat': {
        const n = e.count === 'fill' ? Math.max(0, (fillTo ?? 0) - fixed) : e.count;
        bytes = Array.from({ length: n }, () => e.c);
        break;
      }
    }
    bytes.forEach((x, k) => {
      out.bytes.push(x);
      out.cls.push(cls);
      out.starts.push(cls !== undefined && k === 0);
    });
  }
  return out;
}

function sizeOf(e: Elem): number {
  switch (e.kind) {
    case 'char':
    case 'equiv':
      return 1;
    case 'range':
      return e.hi - e.lo + 1;
    case 'class':
      return range(0, 255).filter(CLASSES[e.name]).length;
    case 'repeat':
      return e.count === 'fill' ? 0 : e.count;
  }
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const complement = args.has('complement');
  const del = args.has('delete');
  const squeeze = args.has('squeeze-repeats');
  const truncate = args.has('truncate-set1');
  const ops = args.operands;
  // upstream: tr.c main, operand counts.
  const minOps = 1 + (del === squeeze ? 1 : 0);
  const maxOps = 1 + (Number(del) <= Number(squeeze) ? 1 : 0);
  if (ops.length < minOps) {
    if (ops.length === 0) return yield* usageError(p, 'missing operand');
    const why = squeeze ? 'Two strings must be given when both deleting and squeezing repeats.' : 'Two strings must be given when translating.';
    return yield* usageError(p, `missing operand after ${quote(ops[ops.length - 1] as string)}\n${why}`);
  }
  if (ops.length > maxOps) {
    const extra = `extra operand ${quote(ops[maxOps] as string)}`;
    return yield* usageError(p, ops.length === 2 ? `${extra}\nOnly one string may be given when deleting without squeezing repeats.` : extra);
  }
  const translating = ops.length === 2 && !del;

  const s1 = parseSpec(ops[0] as string);
  if (!s1.ok) {
    yield* warn(p, s1.message);
    return 1;
  }
  const s2 = ops.length === 2 ? parseSpec(ops[1] as string) : undefined;
  if (s2 && !s2.ok) {
    yield* warn(p, s2.message);
    return 1;
  }
  for (const w of [...s1.spec.warnings, ...(s2?.ok ? s2.spec.warnings : [])]) yield* warn(p, w);

  // upstream: tr.c validate
  const fail = function* (message: string): Op<number> {
    yield* warn(p, message);
    return 1;
  };
  if (s1.spec.elems.some((e) => e.kind === 'repeat' && e.count === 'fill')) return yield* fail('the [c*] repeat construct may not appear in string1');
  const spec2 = s2?.ok ? s2.spec : undefined;
  if (spec2) {
    if (spec2.elems.filter((e) => e.kind === 'repeat' && e.count === 'fill').length > 1) return yield* fail('only one [c*] repeat construct may appear in string2');
    if (translating) {
      if (spec2.elems.some((e) => e.kind === 'equiv')) return yield* fail('[=c=] expressions may not appear in string2 when translating');
      if (spec2.elems.some((e) => e.kind === 'class' && e.name !== 'upper' && e.name !== 'lower')) {
        return yield* fail("when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'");
      }
    }
  }

  let set1 = expand(s1.spec, undefined);
  if (complement) {
    const inSet = new Array<boolean>(256).fill(false);
    for (const x of set1.bytes) inSet[x] = true;
    const bytes = range(0, 255).filter((x) => !inSet[x]);
    set1 = { bytes, cls: bytes.map(() => undefined), starts: bytes.map(() => false) };
  }

  const map = range(0, 255);
  const deleteSet = new Array<boolean>(256).fill(false);
  const squeezeSet = new Array<boolean>(256).fill(false);
  if (translating && spec2) {
    let set2 = expand(spec2, set1.bytes.length);
    if (set2.bytes.length === 0 && !truncate && set1.bytes.length > 0) return yield* fail('when not truncating set1, string2 must be non-empty');
    const n1 = truncate ? Math.min(set1.bytes.length, set2.bytes.length) : set1.bytes.length;
    if (set2.bytes.length < n1) {
      if (set2.cls[set2.cls.length - 1] !== undefined) {
        return yield* fail('when translating with string1 longer than string2,\nthe latter string must not end with a character class');
      }
      // upstream: tr.c string2_extend, the last character repeated.
      const lastByte = set2.bytes[set2.bytes.length - 1] as number;
      while (set2.bytes.length < n1) {
        set2 = { bytes: [...set2.bytes, lastByte], cls: [...set2.cls, undefined], starts: [...set2.starts, false] };
      }
    }
    for (let i = 0; i < n1; i++) {
      const c2 = set2.cls[i];
      if (c2 !== undefined && set2.starts[i] && !complement) {
        const c1 = set1.cls[i];
        if (!set1.starts[i] || (c1 !== 'upper' && c1 !== 'lower')) return yield* fail('misaligned [:upper:] and/or [:lower:] construct');
      }
      map[set1.bytes[i] as number] = set2.bytes[i] as number;
    }
    if (squeeze) for (const x of set2.bytes) squeezeSet[x] = true;
  } else {
    if (del) for (const x of set1.bytes) deleteSet[x] = true;
    if (squeeze) {
      const last = del && spec2 ? expand(spec2, undefined).bytes : set1.bytes;
      for (const x of last) squeezeSet[x] = true;
    }
  }

  let prev = -1;
  try {
    for (;;) {
      const chunk = yield* readSome(p, 0, { line: true });
      if (chunk === null) break;
      const out: number[] = [];
      for (const b of toOctets(chunk)) {
        if (deleteSet[b]) continue;
        const c = map[b] as number;
        if (squeezeSet[c] && c === prev) continue;
        out.push(c);
        prev = c;
      }
      yield* p.write(1, fromOctets(out));
    }
  } catch (e) {
    if (!isFsError(e)) throw e;
    yield* warn(p, `read error: ${strerror(e.code)}`);
    return 1;
  }
  return 0;
}

export const trProgram: ProgramSpec = { name: 'tr', main };
