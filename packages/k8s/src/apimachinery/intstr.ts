// IntOrString helpers. An IntOrString is plain JSON here: a number (Type Int, an int32) or a string.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go

import { goQuote } from './field.ts';

export type IntOrString = number | string;

/** The result of a helper: the value, or upstream's error text. */
export type IntResult = { readonly value: number } | { readonly error: string };

/** upstream: intstr.go IntValue: the int, or a string's strconv.Atoi value (0 when it isn't one). */
export function intOrStringIntValue(v: IntOrString): number {
  if (typeof v === 'number') return v;
  const r = atoi(v);
  return 'error' in r ? 0 : Number(r.value);
}

/** upstream: intstr.go getIntOrPercentValueSafely: the int, or the number before a trailing '%'. */
export function getIntOrPercentValueSafely(v: IntOrString): { value: number; isPercent: boolean } | { error: string } {
  if (typeof v === 'number') return { value: intOrStringIntValue(v), isPercent: false };
  if (!v.endsWith('%')) return { error: 'invalid type: string is not a percentage' };
  const r = atoi(v.slice(0, -1));
  if ('error' in r) return { error: `invalid value ${goQuote(v)}: ${r.error}` };
  return { value: Number(r.value), isPercent: true };
}

/**
 * upstream: intstr.go GetScaledValueFromIntOrPercent: an int as is, or a percentage of `total`,
 * rounded up or down (in float64, as upstream).
 */
export function getScaledValueFromIntOrPercent(v: IntOrString | null | undefined, total: number, roundUp: boolean): IntResult {
  if (v === null || v === undefined) return { error: 'nil value for IntOrString' };
  const r = getIntOrPercentValueSafely(v);
  if ('error' in r) return { error: `invalid value for IntOrString: ${r.error}` };
  if (!r.isPercent) return { value: r.value };
  const scaled = (r.value * total) / 100;
  return { value: roundUp ? Math.ceil(scaled) : Math.floor(scaled) };
}

const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);

/**
 * strconv.Atoi on a 64-bit platform. Errors read as a *strconv.NumError prints them.
 * upstream: go/src/internal/strconv/atoi.go Atoi, ParseInt; go/src/strconv/number.go NumError.Error
 */
function atoi(s: string): { value: bigint } | { error: string } {
  // base 10 allows no underscores and no prefix: an optional sign and at least one digit
  if (!/^[+-]?[0-9]+$/.test(s)) return { error: `strconv.Atoi: parsing ${goQuote(s)}: invalid syntax` };
  const n = BigInt(s);
  if (n > MAX_INT64 || n < MIN_INT64) return { error: `strconv.Atoi: parsing ${goQuote(s)}: value out of range` };
  return { value: n };
}
