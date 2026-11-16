// Go's formatting of the values yaml.v2 decodes, where its text reaches the user: strconv's
// FormatFloat(f, 'g', -1, 64|32) and fmt's %#v.
//
// upstream: Go src/internal/strconv/ftoa.go (fmtEFG: shortest digits, %e when the exponent is
// below -4 or at least 6, two-digit exponents), src/fmt/print.go printValue (%#v of
// []interface {}, map[interface {}]interface {}, nil as `interface {}(nil)` inside them and
// `<nil>` at the top, uint64 in hex), checked against the vendored yaml.v2 with Go 1.27.

import { goQuote } from '../field.ts';
import type { GoValue } from './resolve.ts';

/** The shortest decimal digits of |v| (no leading or trailing zeros) and the decimal point position. */
function shortest(v: number, bits: 64 | 32): { digits: string; dp: number } {
  const a = Math.abs(v);
  let s: string;
  if (bits === 64) s = a.toExponential();
  else {
    const f = Math.fround(a);
    s = f.toExponential(8);
    for (let p = 1; p <= 9; p++) {
      const t = f.toExponential(p - 1);
      if (Math.fround(Number(t)) === f) {
        s = t;
        break;
      }
    }
  }
  const [m, e] = s.split('e') as [string, string];
  const digits = m.replace('.', '').replace(/0+$/, '') || '0';
  return { digits, dp: Number(e) + 1 };
}

/** strconv.FormatFloat(v, 'g', -1, bits). */
export function formatFloatG(v: number, bits: 64 | 32 = 64): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  const neg = v < 0 || Object.is(v, -0);
  if (v === 0) return neg ? '-0' : '0';
  const { digits, dp } = shortest(v, bits);
  const sign = neg ? '-' : '';
  const exp = dp - 1;
  if (exp < -4 || exp >= 6) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const ae = Math.abs(exp);
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${ae < 10 ? '0' : ''}${ae}`;
  }
  if (dp <= 0) return `${sign}0.${'0'.repeat(-dp)}${digits}`;
  if (dp >= digits.length) return `${sign}${digits}${'0'.repeat(dp - digits.length)}`;
  return `${sign}${digits.slice(0, dp)}.${digits.slice(dp)}`;
}

export class GoFormatUnsupported extends Error {}

/**
 * fmt's %#v (and %+#v, the same for these types) of a decoded value. A map whose keys are of
 * different types is sorted by fmtsort on type identity, an order the simulator cannot know:
 * GoFormatUnsupported.
 */
export function goSyntax(v: GoValue, top = true): string {
  switch (v.k) {
    case 'nil':
      return top ? '<nil>' : 'interface {}(nil)';
    case 'bool':
      return String(v.v);
    case 'int':
      return v.v.toString();
    case 'uint':
      return `0x${v.v.toString(16)}`;
    case 'float':
      return formatFloatG(v.v, 64);
    case 'string':
      return goQuote(v.v);
    case 'seq':
      return `[]interface {}{${v.items.map((x) => goSyntax(x, false)).join(', ')}}`;
    case 'map': {
      const kinds = new Set(v.entries.map((e) => e.key.k));
      if (kinds.size > 1) throw new GoFormatUnsupported('a map with keys of different types');
      const entries = [...v.entries].sort((a, b) => compareSameKind(a.key, b.key));
      return `map[interface {}]interface {}{${entries.map((e) => `${goSyntax(e.key, false)}:${goSyntax(e.value, false)}`).join(', ')}}`;
    }
  }
}

/** Go's string comparison (UTF-8 byte order, which is code point order; JS `<` is UTF-16 order). */
export function compareGoStrings(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate (an astral code point) sorts after U+E000–U+FFFF in code point order.
    const sx = x >= 0xd800 && x <= 0xdfff ? x + 0x10000 : x;
    const sy = y >= 0xd800 && y <= 0xdfff ? y + 0x10000 : y;
    return sx < sy ? -1 : 1;
  }
  return a.length - b.length;
}

/** fmtsort's order for two keys of one type. */
function compareSameKind(a: GoValue, b: GoValue): number {
  if (a.k === 'string' && b.k === 'string') return compareGoStrings(a.v, b.v);
  if ((a.k === 'int' || a.k === 'uint') && (b.k === 'int' || b.k === 'uint')) return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.k === 'float' && b.k === 'float') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.k === 'bool' && b.k === 'bool') return Number(a.v) - Number(b.v);
  throw new GoFormatUnsupported('map keys that fmtsort orders by address');
}
