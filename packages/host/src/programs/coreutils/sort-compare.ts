// The comparisons of GNU sort 9.4 in the C.UTF-8 locale: key extraction, the ordering options and
// the last-resort comparison. The locale's collation is code point order (which is the byte order
// of UTF-8); its single-byte ctype is ASCII, so -f folds, and -d and -i keep, ASCII characters only.
//   upstream: coreutils src/sort.c (begfield, limfield, keycompare, compare, numcompare,
//             general_numcompare, human_numcompare, find_unit_order, getmonth),
//             gnulib lib/strnumcmp-in.h, lib/filevercmp.c (filenvercmp)
//   reference: coreutils 9.4 sort under LANG=C.UTF-8, captured 2026-11-16
//              (packages/host/transcripts/coreutils/sort.t)
// Character positions in keys (-k2.3) count bytes, as sort does; a position inside a multibyte
// character is rounded to the next character.

import { charOctets } from '../lib/octets.ts';

export interface Key {
  /** Fields to skip before the key starts, or 'line' for the start of the line. */
  sword: number | 'line';
  /** Bytes to skip in the start field. */
  schar: number;
  /** Fields before the end field, or 'line' for the end of the line. */
  eword: number | 'line';
  /** Bytes of the end field to include; 0 means the whole field. */
  echar: number;
  skipsblanks: boolean;
  skipeblanks: boolean;
  ignore?: 'nondictionary' | 'nonprinting';
  translate: boolean;
  numeric: boolean;
  generalNumeric: boolean;
  human: boolean;
  month: boolean;
  version: boolean;
  random: boolean;
  reverse: boolean;
}

export function newKey(): Key {
  return {
    sword: 'line',
    schar: 0,
    eword: 'line',
    echar: 0,
    skipsblanks: false,
    skipeblanks: false,
    translate: false,
    numeric: false,
    generalNumeric: false,
    human: false,
    month: false,
    version: false,
    random: false,
    reverse: false,
  };
}

/** No ordering option at all (reverse aside): such a key inherits the global options. upstream: sort.c default_key_compare */
export function isDefaultKey(k: Key): boolean {
  return !(k.ignore || k.translate || k.skipsblanks || k.skipeblanks || k.numeric || k.generalNumeric || k.human || k.month || k.version || k.random);
}

export interface Order {
  keys: Key[];
  /** -t: the field separator; undefined for blank-to-non-blank transitions. */
  tab: string | undefined;
  reverse: boolean;
  unique: boolean;
  stable: boolean;
}

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n';

/** Advances `n` bytes from index `i`, not past `lim`. */
function advanceBytes(s: string, i: number, n: number, lim: number): number {
  let left = n;
  while (left > 0 && i < lim) {
    const cp = s.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    left -= charOctets(ch);
    i += ch.length;
  }
  return Math.min(i, lim);
}

function begfield(s: string, key: Key, tab: string | undefined): number {
  const lim = s.length;
  let i = 0;
  let sword = key.sword === 'line' ? 0 : key.sword;
  if (tab !== undefined) {
    while (i < lim && sword-- > 0) {
      while (i < lim && s[i] !== tab) i++;
      if (i < lim) i++;
    }
  } else {
    while (i < lim && sword-- > 0) {
      while (i < lim && isBlank(s[i])) i++;
      while (i < lim && !isBlank(s[i])) i++;
    }
  }
  if (key.skipsblanks) while (i < lim && isBlank(s[i])) i++;
  return advanceBytes(s, i, key.schar, lim);
}

function limfield(s: string, key: Key, tab: string | undefined): number {
  const lim = s.length;
  let i = 0;
  let eword = key.eword === 'line' ? 0 : key.eword;
  const echar = key.echar;
  if (echar === 0) eword++;
  if (tab !== undefined) {
    while (i < lim && eword-- > 0) {
      while (i < lim && s[i] !== tab) i++;
      if (i < lim && (eword > 0 || echar !== 0)) i++;
    }
  } else {
    while (i < lim && eword-- > 0) {
      while (i < lim && isBlank(s[i])) i++;
      while (i < lim && !isBlank(s[i])) i++;
    }
  }
  if (echar !== 0) {
    if (key.skipeblanks) while (i < lim && isBlank(s[i])) i++;
    i = advanceBytes(s, i, echar, lim);
  }
  return i;
}

/** The text of `key` in `line`. */
export function keyText(line: string, key: Key, tab: string | undefined): string {
  const lim = key.eword === 'line' ? line.length : limfield(line, key, tab);
  let beg: number;
  if (key.sword !== 'line') beg = begfield(line, key, tab);
  else {
    beg = 0;
    if (key.skipsblanks) while (beg < lim && isBlank(line[beg])) beg++;
  }
  return lim <= beg ? '' : line.slice(beg, lim);
}

/** Code point order: UTF-16 code unit order fixed up for characters beyond U+FFFF. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      // Surrogates (U+10000 and up) sort after U+E000–U+FFFF.
      x = x < 0xe000 ? x + 0x2000 : x - 0x800;
      y = y < 0xe000 ? y + 0x2000 : y - 0x800;
    }
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** strnumcmp with '.' as the decimal point and no thousands separator, after leading blanks. */
export function numcompare(a: string, b: string): number {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  if (pa.sign !== pb.sign) return sign(pa.sign - pb.sign);
  let mag: number;
  if (pa.int.length !== pb.int.length) mag = pa.int.length < pb.int.length ? -1 : 1;
  else if (pa.int !== pb.int) mag = pa.int < pb.int ? -1 : 1;
  else if (pa.frac !== pb.frac) mag = pa.frac < pb.frac ? -1 : 1;
  else mag = 0;
  return pa.sign < 0 ? -mag : mag;
}

/** The number at the start of `s`: sign (-1, 0, 1), integer digits without leading zeros, fraction without trailing zeros. */
function parseDecimal(s: string): { sign: number; int: string; frac: string } {
  let i = 0;
  while (isBlank(s[i])) i++;
  let neg = false;
  if (s[i] === '-') {
    neg = true;
    i++;
  }
  const intStart = i;
  while (i < s.length && (s[i] as string) >= '0' && (s[i] as string) <= '9') i++;
  const int = s.slice(intStart, i).replace(/^0+/, '');
  let frac = '';
  if (s[i] === '.') {
    const fs = ++i;
    while (i < s.length && (s[i] as string) >= '0' && (s[i] as string) <= '9') i++;
    frac = s.slice(fs, i).replace(/0+$/, '');
  }
  const zero = int === '' && frac === '';
  return { sign: zero ? 0 : neg ? -1 : 1, int, frac };
}

/** strtold's prefix: the value, or undefined when no conversion is possible. */
export function strtold(s: string): number | undefined {
  const m = /^[ \t\n\v\f\r]*([+-]?)(?:(inf(?:inity)?)|(nan)(?:\([0-9A-Za-z_]*\))?|0[xX]((?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?)|((?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?))/i.exec(s);
  if (!m) return undefined;
  const neg = m[1] === '-';
  let v: number;
  if (m[2] !== undefined) v = Infinity;
  else if (m[3] !== undefined) v = NaN;
  else if (m[4] !== undefined) {
    const [mant, exp] = m[4].split(/[pP]/) as [string, string | undefined];
    const [ip, fp = ''] = mant.split('.') as [string, string | undefined];
    v = (parseInt(ip || '0', 16) + (fp === '' ? 0 : parseInt(fp, 16) / 16 ** fp.length)) * 2 ** Number(exp ?? 0);
  } else v = Number(m[5]);
  return neg ? -v : v;
}

/** upstream: sort.c general_numcompare — conversion errors first, then NaNs, then numbers. */
function generalNumcompare(a: string, b: string): number {
  const x = strtold(a);
  const y = strtold(b);
  if (x === undefined) return y === undefined ? 0 : -1;
  if (y === undefined) return 1;
  if (x < y) return -1;
  if (x > y) return 1;
  if (x === y) return 0;
  // At least one NaN: NaNs before numbers.
  if (Number.isNaN(x) && Number.isNaN(y)) return 0;
  return Number.isNaN(x) ? -1 : 1;
}

const UNIT_ORDER: Record<string, number> = { K: 1, k: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 };

/**
 * upstream: sort.c find_unit_order — the suffix after the number; a decimal point not followed by
 * a digit ends the number, and a number whose digits are all zero has no unit
 * (reference: `sort -h` puts 0K before 2 and -1K before -5, captured 2026-11-16).
 */
function findUnitOrder(s: string): number {
  const neg = s[0] === '-';
  let i = neg ? 1 : 0;
  let maxDigit = '';
  for (;;) {
    while (i < s.length && isDigit(s[i] as string)) {
      if ((s[i] as string) > maxDigit) maxDigit = s[i] as string;
      i++;
    }
    if (s[i] === '.' && i + 1 < s.length && isDigit(s[i + 1] as string)) {
      i++;
      continue;
    }
    break;
  }
  if (maxDigit <= '0') return 0;
  const order = UNIT_ORDER[s[i] ?? ''] ?? 0;
  return neg ? -order : order;
}

function humanNumcompare(a: string, b: string): number {
  let i = 0;
  while (isBlank(a[i])) i++;
  let j = 0;
  while (isBlank(b[j])) j++;
  const sa = a.slice(i);
  const sb = b.slice(j);
  const diff = findUnitOrder(sa) - findUnitOrder(sb);
  return diff !== 0 ? sign(diff) : numcompare(sa, sb);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** upstream: sort.c getmonth — 0 for an unknown month, 1–12 otherwise (C.UTF-8's "Jan"…"Dec"). */
function getmonth(s: string): number {
  let i = 0;
  while (isBlank(s[i])) i++;
  const head = s.slice(i, i + 3).replace(/[a-z]/g, (c) => c.toUpperCase());
  return MONTHS.indexOf(head) + 1;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isAlpha = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');

/** upstream: gnulib filevercmp.c file_prefixlen — the length without suffixes like ".tar.gz". */
function filePrefixlen(s: readonly string[]): number {
  const n = s.length;
  let prefixlen = 0;
  for (let i = 0; ; ) {
    if (i === n) return prefixlen;
    i++;
    prefixlen = i;
    while (i + 1 < n && s[i] === '.' && (isAlpha(s[i + 1] as string) || s[i + 1] === '~')) {
      for (i += 2; i < n && (isAlpha(s[i] as string) || isDigit(s[i] as string) || s[i] === '~'); i++);
    }
  }
}

/** upstream: gnulib filevercmp.c order */
function verOrder(s: readonly string[], pos: number, len: number): number {
  if (pos === len) return -1;
  const c = s[pos] as string;
  if (isDigit(c)) return 0;
  if (isAlpha(c)) return c.charCodeAt(0);
  if (c === '~') return -2;
  return (c.codePointAt(0) as number) + 256;
}

/** upstream: gnulib filevercmp.c verrevcmp */
function verrevcmp(s1: readonly string[], l1: number, s2: readonly string[], l2: number): number {
  let i = 0;
  let j = 0;
  while (i < l1 || j < l2) {
    let firstDiff = 0;
    while ((i < l1 && !isDigit(s1[i] as string)) || (j < l2 && !isDigit(s2[j] as string))) {
      const c1 = verOrder(s1, i, l1);
      const c2 = verOrder(s2, j, l2);
      if (c1 !== c2) return c1 - c2;
      i++;
      j++;
    }
    while (i < l1 && s1[i] === '0') i++;
    while (j < l2 && s2[j] === '0') j++;
    while (i < l1 && j < l2 && isDigit(s1[i] as string) && isDigit(s2[j] as string)) {
      if (!firstDiff) firstDiff = (s1[i] as string).charCodeAt(0) - (s2[j] as string).charCodeAt(0);
      i++;
      j++;
    }
    if (i < l1 && isDigit(s1[i] as string)) return 1;
    if (j < l2 && isDigit(s2[j] as string)) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

/** upstream: gnulib filevercmp.c filenvercmp */
export function filevercmp(as: string, bs: string): number {
  const a = [...as];
  const b = [...bs];
  if (a.length === 0) return b.length === 0 ? 0 : -1;
  if (b.length === 0) return 1;
  if (a[0] === '.') {
    if (b[0] !== '.') return -1;
    const adot = a.length === 1;
    const bdot = b.length === 1;
    if (adot) return bdot ? 0 : -1;
    if (bdot) return 1;
    const adotdot = a[1] === '.' && a.length === 2;
    const bdotdot = b[1] === '.' && b.length === 2;
    if (adotdot) return bdotdot ? 0 : -1;
    if (bdotdot) return 1;
  } else if (b[0] === '.') return 1;
  const ap = filePrefixlen(a);
  const bp = filePrefixlen(b);
  const onePass = ap === a.length && bp === b.length;
  const r = verrevcmp(a, ap, b, bp);
  return r !== 0 || onePass ? r : verrevcmp(a, a.length, b, b.length);
}

/** -d keeps blanks and ASCII letters and digits; -i keeps printable ASCII. */
function applyIgnore(s: string, ignore: Key['ignore']): string {
  if (ignore === 'nondictionary') return s.replace(/[^ \t\n0-9A-Za-z]/g, '');
  if (ignore === 'nonprinting') return s.replace(/[^\x20-\x7e]/g, '');
  return s;
}

const foldUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** One key of two lines. upstream: sort.c keycompare (the loop body) */
function compareKey(a: string, b: string, key: Key): number {
  let ta = a;
  let tb = b;
  if (key.ignore) {
    ta = applyIgnore(ta, key.ignore);
    tb = applyIgnore(tb, key.ignore);
  }
  if (key.translate) {
    ta = foldUpper(ta);
    tb = foldUpper(tb);
  }
  if (key.numeric) return numcompare(ta, tb);
  if (key.generalNumeric) return generalNumcompare(ta, tb);
  if (key.human) return humanNumcompare(ta, tb);
  if (key.month) return getmonth(ta) - getmonth(tb);
  if (key.version) return sign(filevercmp(ta, tb));
  return compareCodePoints(ta, tb);
}

/** upstream: sort.c compare — the keys, then (unless -u or -s) the whole line. */
export function compareLines(a: string, b: string, o: Order): number {
  for (const key of o.keys) {
    const d = compareKey(keyText(a, key, o.tab), keyText(b, key, o.tab), key);
    if (d !== 0) return key.reverse ? -d : d;
  }
  if (o.keys.length > 0 && (o.unique || o.stable)) return 0;
  const d = compareCodePoints(a, b);
  return o.reverse ? -d : d;
}
