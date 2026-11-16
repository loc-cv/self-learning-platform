// How kubectl turns a Table cell into text: fmt.Sprint of the value the JSON decoded to (string,
// int64 for an integer, float64 otherwise, bool, []interface{}, map[string]interface{}, nil), and
// fmt's %s of a non-string (the kind prefix of a name cell).
// upstream: Go src/fmt/print.go (printValue: maps with sorted keys, slices space-separated,
// <nil>), src/fmt/format.go fmtFloat and src/strconv/ftoa.go ('g' with the shortest precision
// switches to an exponent below 1e-4 and from 1e+06; at least two exponent digits);
// staging/src/k8s.io/apimachinery/pkg/runtime/converter.go (JSON integers decode to int64).

import type { Json } from '../../apimachinery/json.ts';
import { compareGoStrings } from '../../apimachinery/labels.ts';

/** strconv.FormatFloat(f, 'g', -1, 64). */
export function goFloat(f: number): string {
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  // toExponential() without digits is the shortest representation that round-trips.
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(f.toExponential()) as RegExpExecArray;
  const sign = m[1] as string;
  const digits = (m[2] as string) + (m[3] ?? '');
  const exp = Number(m[4]);
  if (exp < -4 || exp >= 6) {
    const e = Math.abs(exp);
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${e < 10 ? `0${e}` : e}`;
  }
  const dp = exp + 1;
  if (dp <= 0) return `${sign}0.${'0'.repeat(-dp)}${digits}`;
  if (dp >= digits.length) return `${sign}${digits}${'0'.repeat(dp - digits.length)}`;
  return `${sign}${digits.slice(0, dp)}.${digits.slice(dp)}`;
}

const isInt = (n: number): boolean => Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;

/** fmt.Sprint(v) of a decoded JSON value (%v). */
export function goSprint(v: Json | undefined): string {
  if (v === null || v === undefined) return '<nil>';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return isInt(v) ? String(v) : goFloat(v);
  if (Array.isArray(v)) return `[${v.map(goSprint).join(' ')}]`;
  const keys = Object.keys(v).sort(compareGoStrings);
  return `map[${keys.map((k) => `${k}:${goSprint(v[k])}`).join(' ')}]`;
}

/** fmt's %s of a decoded JSON value: strings as they are, other types as %!s(type=value). */
export function goSprintS(v: Json | undefined): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '%!s(<nil>)';
  if (typeof v === 'boolean') return `%!s(bool=${v})`;
  if (typeof v === 'number') return isInt(v) ? `%!s(int64=${v})` : `%!s(float64=${goFloat(v)})`;
  if (Array.isArray(v)) return `[${v.map(goSprintS).join(' ')}]`;
  const keys = Object.keys(v).sort(compareGoStrings);
  return `map[${keys.map((k) => `${k}:${goSprintS(v[k])}`).join(' ')}]`;
}

/** len(s) in Go: UTF-8 bytes. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** strings.ToUpper / ToLower, rune by rune (a rune that maps to several stays as it is). */
export const goUpper = (s: string): string => [...s].map((c) => (c.toUpperCase().length === c.length ? c.toUpperCase() : c)).join('');
export const goLower = (s: string): string => [...s].map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join('');
