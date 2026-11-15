// resource.Quantity: fixed-point quantities ("100m", "1Gi", "1e3"), ported from the pin.
// upstream: staging/src/k8s.io/apimachinery/pkg/api/resource/quantity.go, amount.go, math.go,
// scale_int.go, suffix.go (and gopkg.in/inf.v0 for the inf.Dec behavior they rely on).
//
// A Quantity here is plain data with a bigint mantissa. It is a working value, never world state:
// world state keeps the canonical string (canonicalQuantity), the way the API server stores it.
//
// Upstream keeps two representations, an int64Amount fast path and an inf.Dec. Both describe the
// same number and print the same canonical string, but they round differently in ScaledValue
// (negative values, int64 overflow) and decide whether ParseQuantity keeps the input string, so
// `rep` records which one upstream would hold.

export type Format = 'DecimalExponent' | 'BinarySI' | 'DecimalSI';

export interface Quantity {
  /** Upstream's representation: 'int64' (int64Amount; `unscaled` fits an int64) or 'dec' (inf.Dec). */
  readonly rep: 'int64' | 'dec';
  readonly unscaled: bigint;
  /** Base-10 exponent: the value is unscaled × 10^scale (upstream Scale; an inf.Dec scale is its negation). */
  readonly scale: number;
  readonly format: Format;
  /** Cached String() output, '' when it is computed. ParseQuantity keeps an input that is already canonical. */
  readonly s: string;
}

/** A parse failure. `sim` marks a limit of the simulator rather than an upstream error (gap log). */
export interface QuantityError {
  readonly error: string;
  readonly sim?: true;
}

// upstream: quantity.go splitREString, ErrFormatWrong, ErrNumeric, ErrSuffix
export const ERR_FORMAT_WRONG = "quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'";
export const ERR_NUMERIC = 'unable to parse numeric part of quantity';
export const ERR_SUFFIX = "unable to parse quantity's suffix";

/**
 * Upstream would build a decimal with millions of digits here (and stall the API server); the
 * simulator refuses instead. Only reachable with absurd exponents such as "1.0000000000000000001e99999".
 * parseQuantity and canonicalQuantity return it as a QuantityError; the arithmetic functions throw
 * a RangeError with this message.
 */
export const SIM_QUANTITY_TOO_LARGE = '[sim] quantity exponent is beyond what the simulator computes';
const MAX_POW10 = 10_000;

// upstream: amount.go Nano, Micro, Milli, ...
export const NANO = -9;
export const MICRO = -6;
export const MILLI = -3;

const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);
// upstream: math.go maxInt64Factors
const MAX_INT64_FACTORS = 18;

const i64 = (x: bigint): bigint => BigInt.asIntN(64, x);
const i32 = (n: number): number => n | 0;
const fitsInt64 = (x: bigint): boolean => x >= MIN_INT64 && x <= MAX_INT64;
const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const bsign = (x: bigint): -1 | 0 | 1 => (x === 0n ? 0 : x < 0n ? -1 : 1);

function pow10(n: number): bigint {
  if (n > MAX_POW10) throw new RangeError(SIM_QUANTITY_TOO_LARGE);
  return 10n ** BigInt(n);
}

// ---------------------------------------------------------------------------------------------
// Suffixes. upstream: suffix.go newSuffixer, fastLookup.interpret, suffixHandler.interpret/constructBytes

const DEC_SUFFIXES: readonly (readonly [string, number])[] = [
  ['n', -9], ['u', -6], ['m', -3], ['', 0], ['k', 3], ['M', 6], ['G', 9], ['T', 12], ['P', 15], ['E', 18],
];
const BIN_SUFFIXES: readonly (readonly [string, number])[] = [
  ['Ki', 10], ['Mi', 20], ['Gi', 30], ['Ti', 40], ['Pi', 50], ['Ei', 60],
];

interface Interpreted {
  readonly base: 10 | 2;
  readonly exponent: number;
  readonly format: Format;
}

function interpretSuffix(s: string): Interpreted | undefined {
  const d = DEC_SUFFIXES.find(([k]) => k === s);
  if (d) return { base: 10, exponent: d[1], format: 'DecimalSI' };
  const b = BIN_SUFFIXES.find(([k]) => k === s);
  if (b) return { base: 2, exponent: b[1], format: 'BinarySI' };
  if (s.length > 1 && (s[0] === 'E' || s[0] === 'e')) {
    // strconv.ParseInt(suffix[1:], 10, 64), then int32(parsed)
    const rest = s.slice(1);
    if (!/^[+-]?[0-9]+$/.test(rest)) return undefined;
    const parsed = BigInt(rest);
    if (!fitsInt64(parsed)) return undefined;
    return { base: 10, exponent: Number(BigInt.asIntN(32, parsed)), format: 'DecimalExponent' };
  }
  return undefined;
}

function decSuffix(exponent: number): string {
  return DEC_SUFFIXES.find(([, e]) => e === exponent)?.[0] ?? '';
}

function binSuffix(exponent: number): string {
  return BIN_SUFFIXES.find(([, e]) => e === exponent)?.[0] ?? '';
}

// ---------------------------------------------------------------------------------------------
// int64 arithmetic. upstream: math.go

/** int64Multiply/int64MultiplyScale: the product, or undefined if it overflows an int64. */
function int64Multiply(a: bigint, b: bigint): bigint | undefined {
  const c = a * b;
  return fitsInt64(c) ? c : undefined;
}

/**
 * positiveScaleInt64: base × 10^scale. On overflow upstream returns ok=false, and the value it
 * returns alongside differs by case: the wrapped product for scales 1, 2, 3, 6 and 9 (except for
 * the most negative base, which gives 0), and 0 for every other scale. ScaledValue uses that value.
 */
function positiveScaleInt64(base: bigint, scale: number): { value: bigint; ok: boolean } {
  if (scale === 0 || base === 0n) return { value: base, ok: true };
  if (scale > 18) return { value: 0n, ok: false };
  const exact = base * pow10(scale);
  if (fitsInt64(exact)) return { value: exact, ok: true };
  if (scale === 1 || scale === 2 || scale === 3 || scale === 6 || scale === 9) {
    return { value: base === MIN_INT64 ? 0n : i64(exact), ok: false };
  }
  return { value: 0n, ok: false };
}

/** negativeScaleInt64: base / 10^scale rounded away from zero, and whether that was exact. */
function negativeScaleInt64(base: bigint, scale: number): { value: bigint; exact: boolean } {
  if (scale === 0) return { value: base, exact: true };
  if (base === 0n) return { value: 0n, exact: true };
  if (scale > 19) return { value: base > 0n ? 1n : -1n, exact: false };
  const p = pow10(scale);
  const q = base / p;
  if (base % p === 0n) return { value: q, exact: true };
  return { value: base > 0n ? q + 1n : q - 1n, exact: false };
}

// ---------------------------------------------------------------------------------------------
// Parsing. upstream: quantity.go parseQuantityString, ParseQuantity

export interface QuantityParts {
  readonly positive: boolean;
  readonly value: string;
  readonly num: string;
  readonly denom: string;
  readonly suffix: string;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** upstream: quantity.go parseQuantityString, the scanner that splits sign, number and suffix. */
export function parseQuantityString(str: string): QuantityParts | QuantityError {
  let positive = true;
  let pos = 0;
  const end = str.length;
  if (pos < end) {
    if (str[0] === '-') {
      positive = false;
      pos++;
    } else if (str[0] === '+') {
      pos++;
    }
  }
  // strip leading zeros
  for (let i = pos; ; i++) {
    if (i >= end) return { positive, value: '0', num: '0', denom: '', suffix: '' };
    if (str[i] === '0') pos++;
    else break;
  }
  // extract the numerator
  let num: string;
  for (let i = pos; ; i++) {
    if (i >= end) return { positive, value: str.slice(0, end), num: str.slice(pos, end), denom: '', suffix: '' };
    if (!isDigit(str[i])) {
      num = str.slice(pos, i);
      pos = i;
      break;
    }
  }
  if (num.length === 0) num = '0';
  // handle a denominator
  let denom = '';
  if (pos < end && str[pos] === '.') {
    pos++;
    for (let i = pos; ; i++) {
      if (i >= end) return { positive, value: str.slice(0, end), num, denom: str.slice(pos, end), suffix: '' };
      if (!isDigit(str[i])) {
        denom = str.slice(pos, i);
        pos = i;
        break;
      }
    }
  }
  const value = str.slice(0, pos);
  // grab the elements of the suffix
  const suffixStart = pos;
  for (let i = pos; ; i++) {
    if (i >= end) return { positive, value, num, denom, suffix: str.slice(suffixStart, end) };
    if (!'eEinumkKMGTP'.includes(str[i] as string)) {
      pos = i;
      break;
    }
  }
  if (pos < end && (str[pos] === '-' || str[pos] === '+')) pos++;
  for (let i = pos; ; i++) {
    if (i >= end) return { positive, value, num, denom, suffix: str.slice(suffixStart, end) };
    if (!isDigit(str[i])) break;
  }
  // a non-digit after the exponent's digits
  return { error: ERR_FORMAT_WRONG };
}

/** inf.Dec SetString over the scanner's `value`: [sign] digits [. digits], at least one digit. */
function decSetString(value: string): { unscaled: bigint; infScale: number } | undefined {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/.exec(value);
  if (!m) return undefined;
  const int = m[2] ?? '';
  const frac = m[3] ?? '';
  if (int.length + frac.length === 0) return undefined;
  const digits = BigInt(int + frac);
  return { unscaled: m[1] === '-' ? -digits : digits, infScale: frac.length };
}

/** upstream: quantity.go ParseQuantity. */
export function parseQuantity(str: string): Quantity | QuantityError {
  try {
    return parse(str);
  } catch (e) {
    if (e instanceof RangeError && e.message === SIM_QUANTITY_TOO_LARGE) return { error: SIM_QUANTITY_TOO_LARGE, sim: true };
    throw e;
  }
}

function parse(str: string): Quantity | QuantityError {
  if (str.length === 0) return { error: ERR_FORMAT_WRONG };
  if (str === '0') return { rep: 'int64', unscaled: 0n, scale: 0, format: 'DecimalSI', s: str };

  const parts = parseQuantityString(str);
  if ('error' in parts) return parts;
  const { positive, value, num, denom } = parts;

  const suffix = interpretSuffix(parts.suffix);
  if (!suffix) return { error: ERR_SUFFIX };
  const { base, exponent } = suffix;
  let format = suffix.format;

  let precision = 0;
  let scale = 0;
  let mantissa = 1n;
  switch (format) {
    case 'DecimalExponent':
    case 'DecimalSI':
      scale = exponent;
      precision = MAX_INT64_FACTORS - (num.length + denom.length);
      break;
    case 'BinarySI':
      scale = 0;
      if (exponent >= 0 && denom.length === 0) {
        // only handle positive binary numbers with the fast path
        mantissa <<= BigInt(exponent);
        // 1Mi (2^20) has ~6 digits of decimal precision, so exponent*3/10 -1 is roughly the precision
        precision = 15 - num.length - Math.trunc((exponent * 3) / 10) - 1;
      } else {
        precision = -1;
      }
      break;
  }

  if (precision >= 0) {
    // if we have a denominator, shift the entire value to the left by the number of places in it
    scale = i32(scale - denom.length);
    if (scale >= NANO) {
      const shifted = num + denom;
      const parsed = BigInt(shifted); // strconv.ParseInt: digits only, at most 18 of them here
      if (!fitsInt64(parsed)) return { error: ERR_NUMERIC };
      const product = int64Multiply(parsed, mantissa);
      if (product !== undefined) {
        const result = positive ? product : -product;
        const q: Quantity = { rep: 'int64', unscaled: result, scale, format, s: '' };
        // if the number is in canonical form, reuse the string
        if (format === 'BinarySI') {
          if (exponent % 10 === 0 && (parsed & 7n) !== 0n) return { ...q, s: str };
        } else if (scale % 3 === 0 && !shifted.endsWith('000') && shifted[0] !== '0') {
          return { ...q, s: str };
        }
        return q;
      }
    }
  }

  const amount = decSetString(value);
  if (!amount) return { error: ERR_NUMERIC };
  let unscaled = amount.unscaled;
  let infScale = amount.infScale;
  // So that no one but us has to think about suffixes, remove it.
  if (base === 10) {
    infScale = i32(infScale + i32(-exponent));
  } else {
    unscaled *= 1n << BigInt(exponent);
  }

  const sign = bsign(unscaled);
  unscaled = abs(unscaled);

  // Round non-zero values up to the minimum representable value (inf.RoundUp at Nano), "under the
  // theory that if you want some resources, you should get some resources".
  if (unscaled !== 0n) {
    ({ unscaled } = decRound(unscaled, infScale, -NANO));
    infScale = -NANO;
  }

  // The max is just a simple cap.
  if (format === 'BinarySI' && decCmp(unscaled, infScale, MAX_INT64, 0) > 0) {
    unscaled = MAX_INT64;
    infScale = 0;
  }
  if (format === 'BinarySI' && decCmp(unscaled, infScale, 1n, 0) < 0 && unscaled > 0n) {
    // This avoids rounding and hopefully confusion, too.
    format = 'DecimalSI';
  }
  if (sign === -1) unscaled = -unscaled;

  return { rep: 'dec', unscaled, scale: 0 - infScale, format, s: '' };
}

/** inf.Dec Round(x, s, inf.RoundUp): rescale to inf scale s, rounding away from zero. */
function decRound(unscaled: bigint, infScale: number, s: number): { unscaled: bigint; exact: boolean } {
  if (s >= infScale) return { unscaled: unscaled * pow10(s - infScale), exact: true };
  const r = negativeScaleBig(unscaled, infScale - s);
  return { unscaled: r.value, exact: r.exact };
}

/** Exact division by 10^scale rounded away from zero, for unbounded integers. */
function negativeScaleBig(base: bigint, scale: number): { value: bigint; exact: boolean } {
  if (base === 0n) return { value: 0n, exact: true };
  if (scale > digitCount(base)) return { value: base > 0n ? 1n : -1n, exact: false };
  const p = pow10(scale);
  const q = base / p;
  if (base % p === 0n) return { value: q, exact: true };
  return { value: base > 0n ? q + 1n : q - 1n, exact: false };
}

function digitCount(x: bigint): number {
  return abs(x).toString().length;
}

/** Exact comparison of a·10^-as and b·10^-bs (inf scales), without materializing huge powers. */
function decCmp(a: bigint, as: number, b: bigint, bs: number): -1 | 0 | 1 {
  return cmpExact(a, -as, b, -bs);
}

/** Exact comparison of a·10^ea and b·10^eb. */
function cmpExact(a: bigint, ea: number, b: bigint, eb: number): -1 | 0 | 1 {
  const sa = bsign(a);
  const sb = bsign(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (sa === 0) return 0;
  // same sign: compare magnitudes, first by order of magnitude
  const ma = digitCount(a) + ea;
  const mb = digitCount(b) + eb;
  let c: -1 | 0 | 1;
  if (ma !== mb) {
    c = ma < mb ? -1 : 1;
  } else {
    const m = Math.min(ea, eb);
    const x = abs(a) * pow10(ea - m);
    const y = abs(b) * pow10(eb - m);
    c = x === y ? 0 : x < y ? -1 : 1;
  }
  return sa > 0 ? c : c === 0 ? 0 : c === 1 ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------
// Constructors. upstream: quantity.go NewQuantity, NewMilliQuantity, NewScaledQuantity, NewDecimalQuantity

function int64Arg(v: number | bigint): bigint {
  const b = BigInt(v);
  if (!fitsInt64(b)) throw new RangeError(`quantity value ${b} overflows int64`);
  return b;
}

export function newQuantity(value: number | bigint, format: Format): Quantity {
  return { rep: 'int64', unscaled: int64Arg(value), scale: 0, format, s: '' };
}

export function newMilliQuantity(value: number | bigint, format: Format): Quantity {
  return { rep: 'int64', unscaled: int64Arg(value), scale: MILLI, format, s: '' };
}

export function newScaledQuantity(value: number | bigint, scale: number): Quantity {
  return { rep: 'int64', unscaled: int64Arg(value), scale, format: 'DecimalSI', s: '' };
}

/** An inf.Dec-backed quantity of unscaled × 10^exponent (the test helper decQuantity). */
export function newDecimalQuantity(unscaled: bigint, exponent: number, format: Format): Quantity {
  return { rep: 'dec', unscaled, scale: exponent, format, s: '' };
}

/** upstream: quantity.go ToDec: the same value in the inf.Dec representation. */
export function toDec(q: Quantity): Quantity {
  return q.rep === 'dec' ? q : { ...q, rep: 'dec' };
}

// ---------------------------------------------------------------------------------------------
// Printing. upstream: quantity.go CanonicalizeBytes, String; amount.go AsCanonicalBytes, AsCanonicalBase1024Bytes

/** upstream: quantity.go String (and MarshalJSON, which writes the same text). */
export function quantityString(q: Quantity): string {
  if (q.s.length > 0) return q.s;
  return canonicalize(q);
}

function canonicalize(q: Quantity): string {
  if (isZero(q)) return '0';

  let format: Format = q.format;
  let rounded = 0n;
  switch (format) {
    case 'DecimalExponent':
    case 'DecimalSI':
      break;
    case 'BinarySI':
      if (cmpInt64(q, -1024n) > 0 && cmpInt64(q, 1024n) < 0) {
        // This avoids rounding and hopefully confusion, too.
        format = 'DecimalSI';
      } else {
        const r = asScale0(q);
        if (r.exact) rounded = r.value;
        else format = 'DecimalSI'; // Don't lose precision-- show as DecimalSI
      }
      break;
    default:
      format = 'DecimalExponent';
  }

  if (format !== 'BinarySI') {
    const { number, exponent } = asCanonicalBytes(q);
    if (format === 'DecimalSI') return number + decSuffix(exponent);
    return exponent === 0 ? number : `${number}e${exponent}`;
  }
  // removeInt64Factors / removeBigIntFactors(value, 1024)
  let amount = rounded;
  let times = 0;
  while (abs(amount) >= 1024n && amount % 1024n === 0n) {
    amount /= 1024n;
    times++;
  }
  return amount.toString() + binSuffix(times * 10);
}

/** The value rounded away from zero to an integer, and whether it already was one (AsScale(0)). */
function asScale0(q: Quantity): { value: bigint; exact: boolean } {
  if (q.scale >= 0) return { value: q.unscaled * pow10(q.scale), exact: true };
  return negativeScaleBig(q.unscaled, -q.scale);
}

/** Mantissa and base-10 exponent, the exponent a multiple of 3 ("1.1e5" gives "110", 3). */
function asCanonicalBytes(q: Quantity): { number: string; exponent: number } {
  let amount = q.unscaled;
  let exponent = q.scale;
  // move all factors of 10 into the exponent for easy reasoning
  const zeros = /0*$/.exec(abs(amount).toString())?.[0].length ?? 0;
  if (zeros > 0) {
    amount /= pow10(zeros);
    exponent = i32(exponent + zeros);
  }
  // make sure exponent is a multiple of 3
  while (exponent % 3 !== 0) {
    amount *= 10n;
    exponent = i32(exponent - 1);
  }
  return { number: amount.toString(), exponent };
}

/**
 * The string the API server stores for a quantity it decoded from `s` (UnmarshalJSON, then
 * MarshalJSON): the format of the input is kept and the suffix chosen as upstream does.
 * `s` is the JSON string's content or the JSON number's text.
 */
export function canonicalQuantity(s: string): string | QuantityError {
  // upstream: quantity.go UnmarshalJSON: ParseQuantity(strings.TrimSpace(string(value)))
  const q = parseQuantity(goTrimSpace(s));
  if ('error' in q) return q;
  try {
    return quantityString(q);
  } catch (e) {
    if (e instanceof RangeError && e.message === SIM_QUANTITY_TOO_LARGE) return { error: SIM_QUANTITY_TOO_LARGE, sim: true };
    throw e;
  }
}

// strings.TrimSpace: unicode.IsSpace, which differs from String.prototype.trim (U+0085 is a
// space to Go, U+FEFF is not).
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'gu');

function goTrimSpace(s: string): string {
  return s.replace(GO_TRIM, '');
}

// ---------------------------------------------------------------------------------------------
// Arithmetic and comparison. upstream: quantity.go Add, Sub, Mul, Neg, Cmp, CmpInt64, RoundUp

export function isZero(q: Quantity): boolean {
  return q.unscaled === 0n;
}

export function sign(q: Quantity): -1 | 0 | 1 {
  return bsign(q.unscaled);
}

export function compareQuantities(a: Quantity, b: Quantity): -1 | 0 | 1 {
  // Both representations compare exactly (int64Amount.Cmp falls back to inf.Dec when it can't).
  return cmpExact(a.unscaled, a.scale, b.unscaled, b.scale);
}

export function cmpInt64(q: Quantity, y: bigint): -1 | 0 | 1 {
  return cmpExact(q.unscaled, q.scale, y, 0);
}

export function equalQuantities(a: Quantity, b: Quantity): boolean {
  return compareQuantities(a, b) === 0;
}

/** int64Amount.Add: the sum at the smaller scale, or undefined if it would overflow an int64. */
function int64AmountAdd(a: Quantity, b: { unscaled: bigint; scale: number }): { unscaled: bigint; scale: number } | undefined {
  if (b.unscaled === 0n) return { unscaled: a.unscaled, scale: a.scale };
  if (a.unscaled === 0n) return { unscaled: b.unscaled, scale: b.scale };
  if (a.scale === b.scale) {
    const c = a.unscaled + b.unscaled;
    return fitsInt64(c) ? { unscaled: c, scale: a.scale } : undefined;
  }
  if (a.scale > b.scale) {
    const p = positiveScaleInt64(a.unscaled, a.scale - b.scale);
    if (!p.ok) return undefined;
    const c = p.value + b.unscaled;
    return fitsInt64(c) ? { unscaled: c, scale: b.scale } : undefined;
  }
  const p = positiveScaleInt64(b.unscaled, b.scale - a.scale);
  if (!p.ok) return undefined;
  const c = a.unscaled + p.value;
  return fitsInt64(c) ? { unscaled: c, scale: a.scale } : undefined;
}

/** inf.Dec Add/Sub: the result takes the larger inf scale, the smaller base-10 exponent. */
function decAdd(a: Quantity, b: Quantity, negateB: boolean): { unscaled: bigint; scale: number } {
  const m = Math.min(a.scale, b.scale);
  const bu = negateB ? -b.unscaled : b.unscaled;
  return { unscaled: a.unscaled * pow10(a.scale - m) + bu * pow10(b.scale - m), scale: m };
}

/** upstream: Quantity.Add. If q is zero, the result takes y's format. */
export function addQuantities(q: Quantity, y: Quantity): Quantity {
  let format = q.format;
  if (q.rep === 'int64' && y.rep === 'int64') {
    if (q.unscaled === 0n) format = y.format;
    const r = int64AmountAdd(q, y);
    if (r) return { rep: 'int64', ...r, format, s: '' };
  } else if (isZero(q)) {
    format = y.format;
  }
  return { rep: 'dec', ...decAdd(q, y, false), format, s: '' };
}

/** upstream: Quantity.Sub. If q is zero, the result takes y's format. */
export function subQuantities(q: Quantity, y: Quantity): Quantity {
  const format = isZero(q) ? y.format : q.format;
  if (q.rep === 'int64' && y.rep === 'int64') {
    // int64Amount.Sub negates b.value in int64 (the most negative value stays itself)
    const r = int64AmountAdd(q, { unscaled: i64(-y.unscaled), scale: y.scale });
    if (r) return { rep: 'int64', ...r, format, s: '' };
  }
  return { rep: 'dec', ...decAdd(q, y, true), format, s: '' };
}

/** upstream: Quantity.Neg (int64 negation wraps for the most negative value). */
export function negQuantity(q: Quantity): Quantity {
  return { ...q, unscaled: q.rep === 'int64' ? i64(-q.unscaled) : -q.unscaled, s: '' };
}

/** upstream: Quantity.Mul: the product, and false if its mantissa no longer fits an int64. */
export function mulQuantity(q: Quantity, y: number | bigint): { quantity: Quantity; exact: boolean } {
  const b = int64Arg(y);
  if (q.rep === 'int64') {
    const r = int64AmountMul(q, b);
    if (r) return { quantity: { ...q, ...r, s: '' }, exact: true };
  }
  const unscaled = q.unscaled * b;
  return { quantity: { ...q, rep: 'dec', unscaled, s: '' }, exact: fitsInt64(unscaled) };
}

/** int64Amount.Mul, or undefined where upstream falls back to inf.Dec. */
function int64AmountMul(a: Quantity, b: bigint): { unscaled: bigint; scale: number } | undefined {
  if (a.unscaled === 0n) return { unscaled: a.unscaled, scale: a.scale };
  if (b === 0n) return { unscaled: 0n, scale: 0 };
  const c = int64Multiply(a.unscaled, b);
  if (c === undefined) return undefined;
  if (a.scale > 0 && !positiveScaleInt64(c, a.scale).ok) return undefined;
  if (a.scale < 0 && !negativeScaleInt64(c, -a.scale).exact) return undefined;
  return { unscaled: c, scale: a.scale };
}

/**
 * upstream: Quantity.RoundUp: round away from zero to at least `scale`, and whether that was
 * exact. An inf.Dec always moves to exactly that scale; an int64Amount only coarsens.
 */
export function roundUpQuantity(q: Quantity, scale: number): { quantity: Quantity; exact: boolean } {
  if (q.rep === 'dec') {
    const r = decRound(q.unscaled, -q.scale, -scale);
    return { quantity: { ...q, unscaled: r.unscaled, scale, s: '' }, exact: r.exact };
  }
  if (q.scale >= scale) return { quantity: q, exact: true };
  const r = negativeScaleInt64(q.unscaled, scale - q.scale);
  return { quantity: { ...q, unscaled: r.value, scale, s: '' }, exact: r.exact };
}

// ---------------------------------------------------------------------------------------------
// Values. upstream: quantity.go Value, MilliValue, ScaledValue, AsInt64, AsApproximateFloat64; scale_int.go scaledValue

/**
 * upstream: Quantity.ScaledValue: ceil(q / 10^scale) as an int64, as upstream computes it. That
 * includes its quirks: an int64Amount rounds away from zero and gives 0 or a wrapped value on
 * overflow; an inf.Dec wraps, and its fast path rounds a negative fraction up by one too many
 * ("-1.5" → 0).
 */
export function scaledValue(q: Quantity, scale: number): bigint {
  if (q.rep === 'int64') {
    // int64Amount.AsScaledInt64
    if (q.scale < scale) return negativeScaleInt64(q.unscaled, scale - q.scale).value;
    return positiveScaleInt64(q.unscaled, q.scale - scale).value;
  }
  return decScaledValue(q.unscaled, -q.scale, -scale);
}

// upstream: scale_int.go scaledValue(unscaled, scale, newScale) with inf scales
function decScaledValue(unscaled: bigint, infScale: number, newScale: number): bigint {
  const dif = infScale - newScale;
  if (dif === 0) return i64(unscaled);
  if (unscaled === 0n) return 0n;
  if (dif < 0) {
    // unscaled.Int64() * int64(math.Pow10(-dif)); a float64 beyond int64 converts to the most
    // negative int64 on amd64.
    const factor = -dif <= 18 ? pow10(-dif) : MIN_INT64;
    return i64(i64(unscaled) * factor);
  }
  if (unscaled < MAX_INT64 && dif < 19) {
    const u = i64(unscaled);
    const divide = pow10(dif);
    const result = u / divide; // Go integer division truncates toward zero
    return u % divide !== 0n ? result + 1n : result;
  }
  // big.Int DivMod is Euclidean: floor division for a positive divisor
  if (dif > digitCount(unscaled)) return unscaled > 0n ? 1n : 0n;
  const divisor = pow10(dif);
  let result = unscaled / divisor;
  const remainder = unscaled % divisor;
  if (remainder < 0n) result -= 1n;
  return remainder !== 0n ? i64(i64(result) + 1n) : i64(result);
}

/** upstream: Quantity.Value: the value rounded up to an integer, as a number (exact below 2^53). */
export function value(q: Quantity): number {
  return Number(scaledValue(q, 0));
}

/** upstream: Quantity.MilliValue: ceil(q × 1000), as a number (exact below 2^53). */
export function milliValue(q: Quantity): number {
  return Number(scaledValue(q, MILLI));
}

/** upstream: Quantity.AsInt64: the value as an int64 when the fast representation holds it exactly. */
export function asInt64(q: Quantity): bigint | undefined {
  if (q.rep === 'dec') return undefined;
  if (q.scale === 0) return q.unscaled;
  if (q.scale < 0) return undefined;
  const r = positiveScaleInt64(q.unscaled, q.scale);
  return r.ok ? r.value : undefined;
}

// upstream: go/src/math/pow10.go
const POW10_TAB = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19,
  1e20, 1e21, 1e22, 1e23, 1e24, 1e25, 1e26, 1e27, 1e28, 1e29, 1e30, 1e31,
];
const POW10_POS_TAB32 = [1e0, 1e32, 1e64, 1e96, 1e128, 1e160, 1e192, 1e224, 1e256, 1e288];
const POW10_NEG_TAB32 = [1e-0, 1e-32, 1e-64, 1e-96, 1e-128, 1e-160, 1e-192, 1e-224, 1e-256, 1e-288, 1e-320];

function goPow10(n: number): number {
  if (n >= 0 && n <= 308) return (POW10_POS_TAB32[Math.trunc(n / 32)] as number) * (POW10_TAB[n % 32] as number);
  if (n >= -323 && n < 0) return (POW10_NEG_TAB32[Math.trunc(-n / 32)] as number) / (POW10_TAB[-n % 32] as number);
  return n > 0 ? Infinity : 0;
}

/** upstream: Quantity.AsApproximateFloat64. */
export function asApproximateFloat64(q: Quantity): number {
  const base = Number(q.unscaled); // big.Float.Float64 and float64(int64) both round to nearest even
  if (q.scale === 0) return base;
  return base * goPow10(q.scale);
}
