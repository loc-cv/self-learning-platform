// x86-64 `long double` (80-bit extended precision: a 64-bit significand) as exact BigInt values,
// for the coreutils that compute with it: seq iterates `first + i * step` in long double, and
// printf converts float arguments with strtold(3) and prints them with %Lf. JavaScript's doubles
// would print other digits (`seq -f %.20g 0.1 0.1` prints 0.1 because 0.1L is
// 0.1000000000000000000013…, where the double 0.1 is 0.1000000000000000055…).
//   docs: printf(3) "Conversion specifiers" (f, e, g); strtold(3); the System V x86-64 ABI
//         (long double is the x87 80-bit format)
// Each result is rounded to 64 significant bits, ties to even, as the x87 does by default.
// The exponent range is not limited (values beyond about 1e4932 do not become infinite).

export type LongDouble =
  | { kind: 'finite'; neg: boolean; m: bigint; e: number }
  | { kind: 'inf'; neg: boolean }
  | { kind: 'nan' };

const BITS = 64n;
const TOP = 1n << BITS;
const LOW = 1n << (BITS - 1n);

const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);

/** n / d rounded to the nearest integer, ties to even (n, d > 0). */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r2 = (n % d) * 2n;
  return r2 > d || (r2 === d && (q & 1n) === 1n) ? q + 1n : q;
}

/** The long double nearest to (n / d) * 2^e, n >= 0, d > 0. */
function fromRational(neg: boolean, n: bigint, d: bigint, e = 0): LongDouble {
  if (n === 0n) return { kind: 'finite', neg, m: 0n, e: 0 };
  // Scale so that the quotient has exactly 64 bits before rounding.
  let shift = Number(BITS) - (bitLength(n) - bitLength(d));
  let m = shift >= 0 ? divRound(n << BigInt(shift), d) : divRound(n, d << BigInt(-shift));
  while (m >= TOP) {
    // One bit too many (from the estimate or from rounding up): redo with one less.
    shift -= 1;
    m = shift >= 0 ? divRound(n << BigInt(shift), d) : divRound(n, d << BigInt(-shift));
  }
  while (m < LOW) {
    shift += 1;
    m = shift >= 0 ? divRound(n << BigInt(shift), d) : divRound(n, d << BigInt(-shift));
  }
  return { kind: 'finite', neg, m, e: e - shift };
}

export const ZERO: LongDouble = { kind: 'finite', neg: false, m: 0n, e: 0 };

export function fromBigInt(v: bigint): LongDouble {
  return fromRational(v < 0n, v < 0n ? -v : v, 1n);
}

/**
 * strtold(3): the longest prefix of `s` that is a number (optional blanks and sign, then a decimal
 * number with optional exponent, a hexadecimal one such as `0x1.8p3`, `inf`, `infinity` or
 * `nan`), and how many characters it took; undefined when there is none.
 */
export function parseLongDoublePrefix(s: string): { value: LongDouble; length: number } | undefined {
  const lead = /^[ \t\n\v\f\r]*([+-]?)/.exec(s) as RegExpExecArray;
  const neg = lead[1] === '-';
  const rest = s.slice(lead[0].length);
  const at = lead[0].length;
  const special = /^(inf(?:inity)?|nan(?:\([0-9A-Za-z_]*\))?)/i.exec(rest);
  if (special) {
    const word = (special[1] as string).toLowerCase();
    return { value: word.startsWith('inf') ? { kind: 'inf', neg } : { kind: 'nan' }, length: at + special[0].length };
  }
  const hex = /^0[xX]([0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP]([+-]?[0-9]+))?/.exec(rest);
  if (hex) {
    const [int = '', frac = ''] = (hex[1] as string).split('.');
    const n = BigInt(`0x${int}${frac}` === '0x' ? '0' : `0x${int}${frac}`);
    const exp = Number(hex[2] ?? '0') - 4 * frac.length;
    const value = exp >= 0 ? fromRational(neg, n << BigInt(exp), 1n) : fromRational(neg, n, 1n << BigInt(-exp));
    return { value, length: at + hex[0].length };
  }
  const dec = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?/.exec(rest);
  if (!dec) return undefined;
  const [int = '', frac = ''] = (dec[1] as string).split('.');
  const n = BigInt(`${int}${frac}` === '' ? '0' : `${int}${frac}`);
  const exp = Number(dec[2] ?? '0') - frac.length;
  const value = exp >= 0 ? fromRational(neg, n * 10n ** BigInt(exp), 1n) : fromRational(neg, n, 10n ** BigInt(-exp));
  return { value, length: at + dec[0].length };
}

/** strtold(3) of a whole string; undefined unless all of it is one number. */
export function parseLongDouble(s: string): LongDouble | undefined {
  const r = parseLongDoublePrefix(s);
  return r && r.length === s.length ? r.value : undefined;
}

/** The exact value as a fraction n / d with d > 0. */
function rational(x: { neg: boolean; m: bigint; e: number }): { n: bigint; d: bigint } {
  const s = x.neg ? -1n : 1n;
  return x.e >= 0 ? { n: s * (x.m << BigInt(x.e)), d: 1n } : { n: s * x.m, d: 1n << BigInt(-x.e) };
}

export function add(a: LongDouble, b: LongDouble): LongDouble {
  if (a.kind === 'nan' || b.kind === 'nan') return { kind: 'nan' };
  if (a.kind === 'inf' || b.kind === 'inf') {
    if (a.kind === 'inf' && b.kind === 'inf' && a.neg !== b.neg) return { kind: 'nan' };
    return a.kind === 'inf' ? a : b;
  }
  const e = Math.min(a.e, b.e);
  const va = (a.neg ? -a.m : a.m) << BigInt(a.e - e);
  const vb = (b.neg ? -b.m : b.m) << BigInt(b.e - e);
  const sum = va + vb;
  if (sum === 0n) return { kind: 'finite', neg: a.neg && b.neg, m: 0n, e: 0 };
  return fromRational(sum < 0n, sum < 0n ? -sum : sum, 1n, e);
}

export function mul(a: LongDouble, b: LongDouble): LongDouble {
  if (a.kind === 'nan' || b.kind === 'nan') return { kind: 'nan' };
  const neg = a.neg !== b.neg;
  if (a.kind === 'inf' || b.kind === 'inf') {
    if ((a.kind === 'finite' && a.m === 0n) || (b.kind === 'finite' && b.m === 0n)) return { kind: 'nan' };
    return { kind: 'inf', neg };
  }
  return fromRational(neg, a.m * b.m, 1n, a.e + b.e);
}

/** -1, 0 or 1; NaN compares as unordered (returns NaN). */
export function cmp(a: LongDouble, b: LongDouble): number {
  if (a.kind === 'nan' || b.kind === 'nan') return Number.NaN;
  const rank = (x: LongDouble): number => (x.kind === 'inf' ? (x.neg ? -1 : 1) : 0);
  if (rank(a) !== rank(b) || rank(a) !== 0) return Math.sign(rank(a) - rank(b));
  const ra = rational(a as { neg: boolean; m: bigint; e: number });
  const rb = rational(b as { neg: boolean; m: bigint; e: number });
  const l = ra.n * rb.d;
  const r = rb.n * ra.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function isZero(x: LongDouble): boolean {
  return x.kind === 'finite' && x.m === 0n;
}

export function isNeg(x: LongDouble): boolean {
  return x.kind !== 'nan' && x.neg;
}

/** |x| * 10^p rounded to an integer, ties to even (as glibc rounds an exact binary value). */
function scaledDigits(x: { m: bigint; e: number }, p: number): bigint {
  let n = x.m;
  let d = 1n;
  if (x.e >= 0) n <<= BigInt(x.e);
  else d <<= BigInt(-x.e);
  if (p >= 0) n *= 10n ** BigInt(p);
  else d *= 10n ** BigInt(-p);
  return divRound(n, d);
}

/** %.<p>f of |x|. */
function fixed(x: { m: bigint; e: number }, p: number, alt: boolean): string {
  const digits = scaledDigits(x, p).toString().padStart(p + 1, '0');
  const int = digits.slice(0, digits.length - p);
  const frac = digits.slice(digits.length - p);
  return p > 0 ? `${int}.${frac}` : alt ? `${int}.` : int;
}

/** The decimal exponent of |x| > 0: floor(log10 |x|). */
function decimalExponent(x: { m: bigint; e: number }): number {
  const { n, d } = rational({ neg: false, ...x });
  let k = n.toString().length - d.toString().length;
  // Adjust the estimate so that 10^k <= n/d < 10^(k+1).
  const ge = (k2: number): boolean => (k2 >= 0 ? n >= d * 10n ** BigInt(k2) : n * 10n ** BigInt(-k2) >= d);
  while (!ge(k)) k--;
  while (ge(k + 1)) k++;
  return k;
}

/** %.<p>e of |x|: the digits and the exponent after rounding. */
function exponential(x: { m: bigint; e: number }, p: number): { mant: string; exp: number } {
  if (x.m === 0n) return { mant: '0'.repeat(p + 1), exp: 0 };
  let exp = decimalExponent(x);
  let digits = scaledDigits(x, p - exp);
  if (digits.toString().length > p + 1) {
    exp += 1;
    digits = scaledDigits(x, p - exp);
  }
  return { mant: digits.toString(), exp };
}

function expString(mant: string, exp: number, p: number, alt: boolean, upper: boolean): string {
  const body = p > 0 ? `${mant[0]}.${mant.slice(1)}` : alt ? `${mant[0]}.` : (mant[0] as string);
  const e = `${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return `${body}${upper ? 'E' : 'e'}${e}`;
}

export interface FloatSpec {
  /** Any of `-+ #0'`. */
  flags: string;
  width?: number;
  precision?: number;
  /** f F e E g G */
  conv: string;
}

/** printf(3) of a long double with one of the f, e and g conversions. */
export function formatLongDouble(x: LongDouble, spec: FloatSpec): string {
  const conv = spec.conv;
  const upper = conv === 'F' || conv === 'E' || conv === 'G';
  const alt = spec.flags.includes('#');
  const neg = x.kind !== 'nan' && x.neg;
  const sign = neg ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
  let body: string;
  let numeric = true;
  if (x.kind !== 'finite') {
    body = x.kind === 'nan' ? 'nan' : 'inf';
    if (upper) body = body.toUpperCase();
    numeric = false;
  } else {
    const p = spec.precision ?? 6;
    const lc = conv.toLowerCase();
    if (lc === 'f') body = fixed(x, p, alt);
    else if (lc === 'e') {
      const r = exponential(x, p);
      body = expString(r.mant, r.exp, p, alt, upper);
    } else {
      // %g: the style of %e's exponent after rounding to P significant digits.
      const P = p === 0 ? 1 : p;
      const r = exponential(x, P - 1);
      const X = x.m === 0n ? 0 : r.exp;
      if (P > X && X >= -4) {
        body = fixed(x, P - 1 - X, alt);
        if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '');
      } else {
        let mant = r.mant;
        if (!alt) mant = mant.replace(/0+$/, '') || '0';
        body = expString(mant, r.exp, alt ? P - 1 : mant.length - 1, alt, upper);
      }
    }
  }
  const width = spec.width ?? 0;
  const len = sign.length + body.length;
  if (len >= width) return sign + body;
  if (spec.flags.includes('-')) return (sign + body).padEnd(width);
  if (numeric && spec.flags.includes('0')) return sign + '0'.repeat(width - len) + body;
  return (sign + body).padStart(width);
}
