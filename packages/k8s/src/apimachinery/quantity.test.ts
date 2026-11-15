// Ported from upstream: staging/src/k8s.io/apimachinery/pkg/api/resource/quantity_test.go
// (and quantity_example_test.go), v1.37.2.

import { describe, expect, it } from 'vitest';
import {
  ERR_FORMAT_WRONG,
  ERR_NUMERIC,
  ERR_SUFFIX,
  MICRO,
  MILLI,
  NANO,
  SIM_QUANTITY_TOO_LARGE,
  addQuantities,
  asApproximateFloat64,
  asInt64,
  canonicalQuantity,
  compareQuantities,
  isZero,
  milliValue,
  mulQuantity,
  negQuantity,
  newDecimalQuantity,
  newMilliQuantity,
  newQuantity,
  newScaledQuantity,
  parseQuantity,
  parseQuantityString,
  quantityString,
  roundUpQuantity,
  scaledValue,
  sign,
  subQuantities,
  toDec,
  value,
  type Format,
  type Quantity,
} from './quantity.ts';

const MOST_POSITIVE = (1n << 63n) - 1n;
const MOST_NEGATIVE = -(1n << 63n);

function must(s: string): Quantity {
  const q = parseQuantity(s);
  if ('error' in q) throw new Error(`cannot parse '${s}': ${q.error}`);
  return q;
}

/** decQuantity: an inf.Dec of i × 10^exponent. */
const decQ = (i: number | bigint, exponent: number, format: Format): Quantity => newDecimalQuantity(BigInt(i), exponent, format);
/** intQuantity: an int64Amount of i × 10^exponent. */
const intQ = (i: number | bigint, exponent: number, format: Format): Quantity => ({ ...newScaledQuantity(i, exponent), format });
const maxAllowed = (format: Format): Quantity => decQ(MOST_POSITIVE, 0, format);
const zero = (format: Format): Quantity => newQuantity(0, format);

/** A deterministic stand-in for rand.Int63 in the round-trip tests. */
function int63s(seed: bigint, n: number): bigint[] {
  let x = seed;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    out.push(x >> 1n);
  }
  return out;
}

describe('parseQuantity', () => {
  it('TestQuantityParseZero', () => {
    expect(quantityString(must('0'))).toBe('0');
  });

  it('TestQuantityParseNonNumericPanic', () => {
    expect(parseQuantity('Non-Numeric')).toEqual({ error: ERR_FORMAT_WRONG });
  });

  it('rejects the empty string', () => {
    expect(parseQuantity('')).toEqual({ error: ERR_FORMAT_WRONG });
  });

  // TestQuantityParse
  const table: readonly (readonly [string, Quantity])[] = [
    ['0', decQ(0, 0, 'DecimalSI')],
    ['0n', decQ(0, 0, 'DecimalSI')],
    ['0u', decQ(0, 0, 'DecimalSI')],
    ['0m', decQ(0, 0, 'DecimalSI')],
    ['0Ki', decQ(0, 0, 'BinarySI')],
    ['0k', decQ(0, 0, 'DecimalSI')],
    ['0Mi', decQ(0, 0, 'BinarySI')],
    ['0M', decQ(0, 0, 'DecimalSI')],
    ['0Gi', decQ(0, 0, 'BinarySI')],
    ['0G', decQ(0, 0, 'DecimalSI')],
    ['0Ti', decQ(0, 0, 'BinarySI')],
    ['0T', decQ(0, 0, 'DecimalSI')],

    // Quantity less numbers are allowed
    ['1', decQ(1, 0, 'DecimalSI')],

    // Binary suffixes
    ['1Ki', decQ(1024, 0, 'BinarySI')],
    ['8Ki', decQ(8 * 1024, 0, 'BinarySI')],
    ['7Mi', decQ(7 * 1024 * 1024, 0, 'BinarySI')],
    ['6Gi', decQ(6 * 1024 * 1024 * 1024, 0, 'BinarySI')],
    ['5Ti', decQ(5n * 1024n ** 4n, 0, 'BinarySI')],
    ['4Pi', decQ(4n * 1024n ** 5n, 0, 'BinarySI')],
    ['3Ei', decQ(3n * 1024n ** 6n, 0, 'BinarySI')],

    ['10Ti', decQ(10n * 1024n ** 4n, 0, 'BinarySI')],
    ['100Ti', decQ(100n * 1024n ** 4n, 0, 'BinarySI')],

    // Decimal suffixes
    ['5n', decQ(5, -9, 'DecimalSI')],
    ['4u', decQ(4, -6, 'DecimalSI')],
    ['3m', decQ(3, -3, 'DecimalSI')],
    ['9', decQ(9, 0, 'DecimalSI')],
    ['8k', decQ(8, 3, 'DecimalSI')],
    ['50k', decQ(5, 4, 'DecimalSI')],
    ['7M', decQ(7, 6, 'DecimalSI')],
    ['6G', decQ(6, 9, 'DecimalSI')],
    ['5T', decQ(5, 12, 'DecimalSI')],
    ['40T', decQ(4, 13, 'DecimalSI')],
    ['300T', decQ(3, 14, 'DecimalSI')],
    ['2P', decQ(2, 15, 'DecimalSI')],
    ['1E', decQ(1, 18, 'DecimalSI')],

    // Decimal exponents
    ['1E-3', decQ(1, -3, 'DecimalExponent')],
    ['1e3', decQ(1, 3, 'DecimalExponent')],
    ['1E6', decQ(1, 6, 'DecimalExponent')],
    ['1e9', decQ(1, 9, 'DecimalExponent')],
    ['1E12', decQ(1, 12, 'DecimalExponent')],
    ['1e15', decQ(1, 15, 'DecimalExponent')],
    ['1E18', decQ(1, 18, 'DecimalExponent')],

    // Nonstandard but still parsable
    ['1e14', decQ(1, 14, 'DecimalExponent')],
    ['1e13', decQ(1, 13, 'DecimalExponent')],
    ['1e3', decQ(1, 3, 'DecimalExponent')],
    ['100.035k', decQ(100035, 0, 'DecimalSI')],

    // Things that look like floating point
    ['0.001', decQ(1, -3, 'DecimalSI')],
    ['0.0005k', decQ(5, -1, 'DecimalSI')],
    ['0.005', decQ(5, -3, 'DecimalSI')],
    ['0.05', decQ(5, -2, 'DecimalSI')],
    ['0.5', decQ(5, -1, 'DecimalSI')],
    ['0.00050k', decQ(5, -1, 'DecimalSI')],
    ['0.00500', decQ(5, -3, 'DecimalSI')],
    ['0.05000', decQ(5, -2, 'DecimalSI')],
    ['0.50000', decQ(5, -1, 'DecimalSI')],
    ['0.5e0', decQ(5, -1, 'DecimalExponent')],
    ['0.5e-1', decQ(5, -2, 'DecimalExponent')],
    ['0.5e-2', decQ(5, -3, 'DecimalExponent')],
    ['0.5e0', decQ(5, -1, 'DecimalExponent')],
    ['10.035M', decQ(10035, 3, 'DecimalSI')],

    ['1.2e3', decQ(12, 2, 'DecimalExponent')],
    ['1.3E+6', decQ(13, 5, 'DecimalExponent')],
    ['1.40e9', decQ(14, 8, 'DecimalExponent')],
    ['1.53E12', decQ(153, 10, 'DecimalExponent')],
    ['1.6e15', decQ(16, 14, 'DecimalExponent')],
    ['1.7E18', decQ(17, 17, 'DecimalExponent')],

    ['9.01', decQ(901, -2, 'DecimalSI')],
    ['8.1k', decQ(81, 2, 'DecimalSI')],
    ['7.123456M', decQ(7123456, 0, 'DecimalSI')],
    ['6.987654321G', decQ(6987654321, 0, 'DecimalSI')],
    ['5.444T', decQ(5444, 9, 'DecimalSI')],
    ['40.1T', decQ(401, 11, 'DecimalSI')],
    ['300.2T', decQ(3002, 11, 'DecimalSI')],
    ['2.5P', decQ(25, 14, 'DecimalSI')],
    ['1.01E', decQ(101, 16, 'DecimalSI')],

    // Things that saturate/round
    ['3.001n', decQ(4, -9, 'DecimalSI')],
    ['1.1E-9', decQ(2, -9, 'DecimalExponent')],
    ['0.0000000001', decQ(1, -9, 'DecimalSI')],
    ['0.0000000005', decQ(1, -9, 'DecimalSI')],
    ['0.00000000050', decQ(1, -9, 'DecimalSI')],
    ['0.5e-9', decQ(1, -9, 'DecimalExponent')],
    ['0.9n', decQ(1, -9, 'DecimalSI')],
    ['0.00000012345', decQ(124, -9, 'DecimalSI')],
    ['0.00000012354', decQ(124, -9, 'DecimalSI')],
    ['9Ei', maxAllowed('BinarySI')],
    ['9223372036854775807Ki', maxAllowed('BinarySI')],
    ['12E', decQ(12, 18, 'DecimalSI')],

    // We'll accept fractional binary stuff, too.
    ['100.035Ki', decQ(10243584, -2, 'BinarySI')],
    ['0.5Mi', decQ(0.5 * 1024 * 1024, 0, 'BinarySI')],
    ['0.05Gi', decQ(536870912, -1, 'BinarySI')],
    ['0.025Ti', decQ(274877906944, -1, 'BinarySI')],

    // Things written by trolls
    ['0.000000000001Ki', decQ(2, -9, 'DecimalSI')], // rounds up, changes format
    ['.001', decQ(1, -3, 'DecimalSI')],
    ['.0001k', decQ(100, -3, 'DecimalSI')],
    ['1.', decQ(1, 0, 'DecimalSI')],
    ['1.G', decQ(1, 9, 'DecimalSI')],
  ];

  for (const asDec of [false, true]) {
    const p = (s: string): Quantity => (asDec ? toDec(must(s)) : must(s));

    it.each(table)(`TestQuantityParse %s (asDec=${asDec})`, (input, want) => {
      const got = p(input);
      expect(compareQuantities(want, got)).toBe(0);
      expect(got.format).toBe(want.format);
      if (asDec) {
        expect(asInt64(got)).toBeUndefined();
        return;
      }
      const i = asInt64(want);
      if (i === undefined) return;
      const j = asInt64(got);
      if (j === undefined) {
        expect(got.rep === 'int64' && got.scale >= 0).toBe(false);
        return;
      }
      expect(j).toBe(i);
    });

    it.each(table)(`TestQuantityParse round trips %s (asDec=${asDec})`, (input) => {
      const got = p(input);
      for (const format of ['DecimalSI', 'BinarySI', 'DecimalExponent'] as const) {
        const q = newDecimalQuantity(got.unscaled, got.scale, format);
        expect(compareQuantities(q, got)).toBe(0);
      }
      // decompose the input and build it up again from the parts
      const parts = parseQuantityString(input);
      if ('error' in parts) throw new Error(parts.error);
      expect(sign(got) >= 0 ? parts.positive : !parts.positive).toBe(true);
      const rebuilt = (parts.positive ? '' : '-') + parts.num + (parts.denom.length > 0 ? `.${parts.denom}` : '') + parts.suffix;
      expect(compareQuantities(must(rebuilt), got)).toBe(0);
    });

    it.each(table)(`TestQuantityParse -%s (asDec=${asDec})`, (input, want) => {
      const got = p(`-${input}`);
      expect(compareQuantities(negQuantity(toDec(want)), got)).toBe(0);
      expect(got.format).toBe(want.format);
    });

    it.each(table)(`TestQuantityParse +%s (asDec=${asDec})`, (input, want) => {
      const got = p(`+${input}`);
      expect(compareQuantities(want, got)).toBe(0);
      expect(got.format).toBe(want.format);
    });
  }

  it.each(['1.1.M', '1+1.0M', '0.1mi', '0.1am', 'aoeu', '.5i', '1i', '-3.01i', '-3.01e-', ' 1', '1 '])(
    'TestQuantityParse invalid %j',
    (input) => {
      expect('error' in parseQuantity(input)).toBe(true);
    },
  );

  it.each([
    ['', ERR_FORMAT_WRONG],
    ['aoeu', ERR_FORMAT_WRONG],
    ['1.1.M', ERR_FORMAT_WRONG],
    ['1+1.0M', ERR_FORMAT_WRONG],
    ['-3.01e-', ERR_SUFFIX],
    ['0.1mi', ERR_SUFFIX],
    ['0.1am', ERR_FORMAT_WRONG],
    ['1i', ERR_SUFFIX],
    ['1e', ERR_SUFFIX],
    ['1ee3', ERR_SUFFIX],
    ['1e99999999999999999999', ERR_SUFFIX], // ParseInt out of int64 range
    ['1Mi5', ERR_SUFFIX],
    ['1 ', ERR_FORMAT_WRONG],
    // the inf.Dec path needs at least one digit
    ['.e-10', ERR_NUMERIC],
    ['-.e-10', ERR_NUMERIC],
  ])('error text for %j', (input, error) => {
    expect(parseQuantity(input)).toEqual({ error });
  });

  it('TestParseQuantityString', () => {
    const table = [
      ['0.025Ti', true, '0.025', '0', '025', 'Ti'],
      ['1.025Ti', true, '1.025', '1', '025', 'Ti'],
      ['-1.025Ti', false, '-1.025', '1', '025', 'Ti'],
      ['.', true, '.', '0', '', ''],
      ['-.', false, '-.', '0', '', ''],
      ['1E-3', true, '1', '1', '', 'E-3'],
    ] as const;
    for (const [input, positive, value, num, denom, suffix] of table) {
      expect(parseQuantityString(input)).toEqual({ positive, value, num, denom, suffix });
    }
  });

  // TestParseQuantity: the int64 / inf.Dec boundary and the strings it reserializes to
  const big: readonly (readonly [string, bigint | undefined, string, string?])[] = [
    // min/max 18 digits
    ['-999999999999999999', -999999999999999999n, '-999999999999999999'],
    ['999999999999999999', 999999999999999999n, '999999999999999999'],
    ['-999999999999999999.0', undefined, '-999999999999999999', '-999999999999999999'],
    ['999999999999999999.0', undefined, '999999999999999999', '999999999999999999'],
    ['-999999999999999999.1', undefined, '-999999999999999999.1', '-999999999999999999100m'],
    ['999999999999999999.1', undefined, '999999999999999999.1', '999999999999999999100m'],
    // min/max 19 digits
    ['-9999999999999999999', undefined, '-9999999999999999999'],
    ['9999999999999999999', undefined, '9999999999999999999'],
    ['-1E', -1000000000000000000n, '-1000000000000000000'],
    ['1E', 1000000000000000000n, '1000000000000000000'],
    ['-1000000000000000000', undefined, '-1000000000000000000', '-1E'],
    ['1000000000000000000', undefined, '1000000000000000000', '1E'],
    ['-9999999999999999999.0', undefined, '-9999999999999999999', '-9999999999999999999'],
    ['9999999999999999999.0', undefined, '9999999999999999999', '9999999999999999999'],
    ['-1.0E', -1000000000000000000n, '-1000000000000000000', '-1E'],
    ['1.0E', 1000000000000000000n, '1000000000000000000', '1E'],
    ['-1000000000000000000.0', undefined, '-1000000000000000000', '-1E'],
    ['1000000000000000000.0', undefined, '1000000000000000000', '1E'],
    ['-9999999999999999999000m', undefined, '-9999999999999999999', '-9999999999999999999'],
    ['9999999999999999999000m', undefined, '9999999999999999999', '9999999999999999999'],
    ['-9999999999999999999.1', undefined, '-9999999999999999999.1', '-9999999999999999999100m'],
    ['9999999999999999999.1', undefined, '9999999999999999999.1', '9999999999999999999100m'],
    ['-1.0000000000000000001E', undefined, '-1000000000000000000.1', '-1000000000000000000100m'],
    ['1.0000000000000000001E', undefined, '1000000000000000000.1', '1000000000000000000100m'],
    ['-1000000000000000000.1', undefined, '-1000000000000000000.1', '-1000000000000000000100m'],
    ['1000000000000000000.1', undefined, '1000000000000000000.1', '1000000000000000000100m'],
    ['-1.000000000000000001E', undefined, '-1000000000000000001', '-1000000000000000001'],
    ['1.000000000000000001E', undefined, '1000000000000000001', '1000000000000000001'],
    ['-1000000000000000001', undefined, '-1000000000000000001'],
    ['1000000000000000001', undefined, '1000000000000000001'],
    // min/max 20 digits
    ['-10E', undefined, '-10000000000000000000'],
    ['10E', undefined, '10000000000000000000'],
    ['-10000000000000000000', undefined, '-10000000000000000000', '-10E'],
    ['10000000000000000000', undefined, '10000000000000000000', '10E'],
    ['-10.0E', undefined, '-10000000000000000000', '-10E'],
    ['10.0E', undefined, '10000000000000000000', '10E'],
    ['-10000000000000000000.0', undefined, '-10000000000000000000', '-10E'],
    ['10000000000000000000.0', undefined, '10000000000000000000', '10E'],
    ['-10000000000000000000000m', undefined, '-10000000000000000000', '-10E'],
    ['10000000000000000000000m', undefined, '10000000000000000000', '10E'],
    ['-10.0000000000000000001E', undefined, '-10000000000000000000.1', '-10000000000000000000100m'],
    ['10.0000000000000000001E', undefined, '10000000000000000000.1', '10000000000000000000100m'],
    ['-10000000000000000000.1', undefined, '-10000000000000000000.1', '-10000000000000000000100m'],
    ['10000000000000000000.1', undefined, '10000000000000000000.1', '10000000000000000000100m'],
    ['-10.000000000000000001E', undefined, '-10000000000000000001', '-10000000000000000001'],
    ['10.000000000000000001E', undefined, '10000000000000000001', '10000000000000000001'],
    ['-10000000000000000001', undefined, '-10000000000000000001'],
    ['10000000000000000001', undefined, '10000000000000000001'],
    // min/max int64 - 1
    ['-9223372036854775809', undefined, '-9223372036854775809'],
    ['9223372036854775806', undefined, '9223372036854775806'],
    ['-9223372036854775809.0', undefined, '-9223372036854775809', '-9223372036854775809'],
    ['9223372036854775806.0', undefined, '9223372036854775806', '9223372036854775806'],
    ['-9223372036854775809000m', undefined, '-9223372036854775809', '-9223372036854775809'],
    ['9223372036854775806000m', undefined, '9223372036854775806', '9223372036854775806'],
    ['-9223372036854775809.1', undefined, '-9223372036854775809.1', '-9223372036854775809100m'],
    ['9223372036854775806.1', undefined, '9223372036854775806.1', '9223372036854775806100m'],
    // min/max int64
    ['-9223372036854775808', undefined, '-9223372036854775808'],
    ['9223372036854775807', undefined, '9223372036854775807'],
    ['-9223372036854775808.0', undefined, '-9223372036854775808', '-9223372036854775808'],
    ['9223372036854775807.0', undefined, '9223372036854775807', '9223372036854775807'],
    ['-9223372036854775808000m', undefined, '-9223372036854775808', '-9223372036854775808'],
    ['9223372036854775807000m', undefined, '9223372036854775807', '9223372036854775807'],
    ['-9223372036854775808.1', undefined, '-9223372036854775808.1', '-9223372036854775808100m'],
    ['9223372036854775807.1', undefined, '9223372036854775807.1', '9223372036854775807100m'],
    // min/max int64 + 1
    ['-9223372036854775807', undefined, '-9223372036854775807'],
    ['9223372036854775808', undefined, '9223372036854775808'],
    ['-9223372036854775807.0', undefined, '-9223372036854775807', '-9223372036854775807'],
    ['9223372036854775808.0', undefined, '9223372036854775808', '9223372036854775808'],
    ['-9223372036854775807000m', undefined, '-9223372036854775807', '-9223372036854775807'],
    ['9223372036854775808000m', undefined, '9223372036854775808', '9223372036854775808'],
    ['-9223372036854775807.1', undefined, '-9223372036854775807.1', '-9223372036854775807100m'],
    ['9223372036854775808.1', undefined, '9223372036854775808.1', '9223372036854775808100m'],
  ];

  for (const [input, wantAsInt64, wantDec, canonical] of big) {
    it(`TestParseQuantity ${input}`, () => {
      const q = must(input);
      expect(asInt64(q)).toBe(wantAsInt64);
      const [int = '', frac = ''] = wantDec.split('.');
      expect(compareQuantities(q, newDecimalQuantity(BigInt(int + frac), -frac.length, 'DecimalSI'))).toBe(0);
      expect(quantityString(q)).toBe(canonical ?? input);
    });
  }

  it('refuses exponents the simulator does not compute', () => {
    expect(parseQuantity('1.0000000000000000001e99999')).toEqual({ error: SIM_QUANTITY_TOO_LARGE, sim: true });
    // the int64 path keeps a large exponent without expanding it
    expect(canonicalQuantity('1e2000000000')).toBe('100e1999999998');
  });
});

describe('quantityString', () => {
  // TestQuantityString: [quantity, canonical, an alternate spelling that canonicalizes to it]
  const table: readonly (readonly [Quantity, string, string])[] = [
    [decQ(1024 * 1024 * 1024, 0, 'BinarySI'), '1Gi', '1024Mi'],
    [decQ(300 * 1024 * 1024, 0, 'BinarySI'), '300Mi', '307200Ki'],
    [decQ(6 * 1024, 0, 'BinarySI'), '6Ki', ''],
    [decQ(1001 * 1024 * 1024 * 1024, 0, 'BinarySI'), '1001Gi', '1025024Mi'],
    [decQ(1024 * 1024 * 1024 * 1024, 0, 'BinarySI'), '1Ti', '1024Gi'],
    [decQ(5, 0, 'BinarySI'), '5', '5000m'],
    [decQ(500, -3, 'BinarySI'), '500m', '0.5'],
    [decQ(1, 9, 'DecimalSI'), '1G', '1000M'],
    [decQ(1000, 6, 'DecimalSI'), '1G', '0.001T'],
    [decQ(1000000, 3, 'DecimalSI'), '1G', ''],
    [decQ(1000000000, 0, 'DecimalSI'), '1G', ''],
    [decQ(1, -3, 'DecimalSI'), '1m', '1000u'],
    [decQ(80, -3, 'DecimalSI'), '80m', ''],
    [decQ(1080, -3, 'DecimalSI'), '1080m', '1.08'],
    [decQ(108, -2, 'DecimalSI'), '1080m', '1080000000n'],
    [decQ(10800, -4, 'DecimalSI'), '1080m', ''],
    [decQ(300, 6, 'DecimalSI'), '300M', ''],
    [decQ(1, 12, 'DecimalSI'), '1T', ''],
    [decQ(1234567, 6, 'DecimalSI'), '1234567M', ''],
    [decQ(1234567, -3, 'BinarySI'), '1234567m', ''],
    [decQ(3, 3, 'DecimalSI'), '3k', ''],
    [decQ(1025, 0, 'BinarySI'), '1025', ''],
    [decQ(0, 0, 'DecimalSI'), '0', ''],
    [decQ(0, 0, 'BinarySI'), '0', ''],
    [decQ(1, 9, 'DecimalExponent'), '1e9', '.001e12'],
    [decQ(1, -3, 'DecimalExponent'), '1e-3', '0.001e0'],
    [decQ(1, -9, 'DecimalExponent'), '1e-9', '1000e-12'],
    [decQ(80, -3, 'DecimalExponent'), '80e-3', ''],
    [decQ(300, 6, 'DecimalExponent'), '300e6', ''],
    [decQ(1, 12, 'DecimalExponent'), '1e12', ''],
    [decQ(1, 3, 'DecimalExponent'), '1e3', ''],
    [decQ(3, 3, 'DecimalExponent'), '3e3', ''],
    [decQ(3, 3, 'DecimalSI'), '3k', ''],
    [decQ(0, 0, 'DecimalExponent'), '0', '00'],
    [decQ(1, -9, 'DecimalSI'), '1n', ''],
    [decQ(80, -9, 'DecimalSI'), '80n', ''],
    [decQ(1080, -9, 'DecimalSI'), '1080n', ''],
    [decQ(108, -8, 'DecimalSI'), '1080n', ''],
    [decQ(10800, -10, 'DecimalSI'), '1080n', ''],
    [decQ(1, -6, 'DecimalSI'), '1u', ''],
    [decQ(80, -6, 'DecimalSI'), '80u', ''],
    [decQ(1080, -6, 'DecimalSI'), '1080u', ''],
  ];

  it.each(table)('TestQuantityString %#: %s', (q, want, alternate) => {
    expect(quantityString(q)).toBe(want);
    // parsing the canonical string keeps it
    expect(must(want).s).toBe(want);
    if (alternate !== '') {
      const alt = must(alternate);
      expect(alt.s).toBe('');
      expect(quantityString(alt)).toBe(want);
    }
    if (!isZero(q)) expect(quantityString(negQuantity(q))).toBe(`-${want}`);
  });

  it.each([
    ['1Ki', '1Ki'],
    ['1Mi', '1Mi'],
    ['1Gi', '1Gi'],
    ['1024Mi', '1Gi'],
    ['1000M', '1G'],
    ['.001Ki', '1024m'],
    ['.000001Ki', '1024u'],
    ['.000000001Ki', '1024n'],
    ['.000000000001Ki', '2n'],
  ])('TestQuantityParseEmit %s', (input, want) => {
    expect(quantityString(must(input))).toBe(want);
    expect(quantityString(must(`-${input}`))).toBe(`-${want}`);
  });

  it('TestQuantityCanocicalizeZero', () => {
    const val = must('1000m');
    const z = subQuantities(val, intQ(1, 0, 'DecimalSI'));
    expect(quantityString({ ...z, format: 'DecimalSI' })).toBe('0');
  });

  it('TestMilliNewSet', () => {
    const table = [
      [1, 'DecimalSI', '1m', true],
      [1000, 'DecimalSI', '1', true],
      [1234000, 'DecimalSI', '1234', true],
      [1024, 'BinarySI', '1024m', false], // Format changes
      [1000000, 'invalidFormatDefaultsToExponent', '1e3', true],
      [1024 * 1024, 'BinarySI', '1048576m', false], // Format changes
    ] as const;
    for (const [v, format, want, exact] of table) {
      const q = newMilliQuantity(v, format as Format);
      expect(quantityString(q)).toBe(want);
      if (exact) expect(milliValue(must(quantityString(q)))).toBe(v);
    }
  });

  it('TestNewSet', () => {
    const table = [
      [1, 'DecimalSI', '1'],
      [1000, 'DecimalSI', '1k'],
      [1234000, 'DecimalSI', '1234k'],
      [1024, 'BinarySI', '1Ki'],
      [1000000, 'invalidFormatDefaultsToExponent', '1e6'],
      [1024 * 1024, 'BinarySI', '1Mi'],
    ] as const;
    for (const asDec of [false, true]) {
      for (const [v, format, want] of table) {
        const q = newQuantity(v, format as Format);
        const s = quantityString(asDec ? toDec(q) : q);
        expect(s).toBe(want);
        expect(value(must(s))).toBe(v);
      }
    }
  });

  it('TestNewScaledSet', () => {
    const table = [
      [1, NANO, '1n'],
      [1000, NANO, '1u'],
      [1, MICRO, '1u'],
      [1000, MICRO, '1m'],
      [1, MILLI, '1m'],
      [1000, MILLI, '1'],
      [1, 0, '1'],
      [0, NANO, '0'],
      [0, MICRO, '0'],
      [0, MILLI, '0'],
      [0, 0, '0'],
    ] as const;
    for (const [v, scale, want] of table) {
      const q = newScaledQuantity(v, scale);
      expect(quantityString(q)).toBe(want);
      expect(scaledValue(must(quantityString(q)), scale)).toBe(BigInt(v));
    }
  });

  it('ExampleFormat', () => {
    expect(quantityString(newQuantity(5 * 1024 * 1024 * 1024, 'BinarySI'))).toBe('5Gi');
    expect(quantityString(newQuantity(5 * 1000 * 1000 * 1000, 'DecimalSI'))).toBe('5G');
    expect(quantityString(newMilliQuantity(5300, 'DecimalSI'))).toBe('5300m');
  });
});

describe('canonicalQuantity', () => {
  it.each([
    // the examples the API server is known for
    ['1000m', '1'],
    ['0.5', '500m'],
    ['1024Mi', '1Gi'],
    ['1e3', '1e3'],
    ['1.5Gi', '1536Mi'],
    ['100.5', '100500m'],
    ['500m', '500m'],
    ['128Mi', '128Mi'],
    ['1', '1'],
    ['2000', '2k'],
    ['1.5', '1500m'],
    ['0.1', '100m'],
    ['1Gi', '1Gi'],
    ['1536Mi', '1536Mi'],
    ['1.5Ki', '1536'], // BinarySI exact below 1024Ki prints without a suffix
    ['1.1Ki', '1126400m'], // not an integer: DecimalSI
    ['0.5Ki', '512'],
    ['512', '512'],
    ['1e4', '10e3'],
    ['1.5e3', '1500'], // DecimalExponent with exponent 0 prints no suffix
    // a canonical input is kept as typed (q.s), including its sign and leading zeros
    ['+1', '+1'],
    ['+1Gi', '+1Gi'],
    ['0100m', '0100m'],
    ['1E3', '1E3'],
    ['1e+3', '1e+3'],
    // ... and anything else is rebuilt
    ['-0', '0'],
    ['0.0', '0'],
    ['-', '0'],
    ['.', '0'],
    ['+1000m', '1'],
    ['-1.5Gi', '-1536Mi'],
  ])('%j → %j', (input, want) => {
    expect(canonicalQuantity(input)).toBe(want);
  });

  it('TestJSONWhitespace: UnmarshalJSON trims the way strings.TrimSpace does', () => {
    for (const [input, want] of [
      [' 1', '1'],
      ['1 ', '1'],
      ['1', '1'],
      ['10', '10'],
      ['-1', '-1'],
      [' -1', '-1'],
      ['\t1\n', '1'],
      ['\u00851　', '1'],
    ] as const) {
      expect(canonicalQuantity(input)).toBe(want);
    }
    // U+FEFF is not a space to Go
    expect(canonicalQuantity('﻿1')).toEqual({ error: ERR_FORMAT_WRONG });
  });

  it('reports parse errors', () => {
    expect(canonicalQuantity('lots')).toEqual({ error: ERR_FORMAT_WRONG });
    expect(canonicalQuantity('1Gb')).toEqual({ error: ERR_FORMAT_WRONG });
    expect(canonicalQuantity('1mi')).toEqual({ error: ERR_SUFFIX });
  });

  it('TestJSON: canonical strings parse back to the same value', () => {
    const samples: Quantity[] = [];
    const r = int63s(7n, 400);
    for (let i = 0; i < r.length; i += 2) {
      const a = r[i] as bigint;
      const b = r[i + 1] as bigint;
      switch (Number(b % 4n)) {
        case 0:
          samples.push(decQ(a, 0, 'BinarySI'));
          break;
        case 1:
          samples.push(decQ((a % 1024n) << BigInt(10 * Number(b % 5n)), 0, 'BinarySI'));
          break;
        case 2:
          samples.push(decQ(a, -Number(b % 4n), b % 8n < 4n ? 'DecimalSI' : 'DecimalExponent'));
          break;
        default:
          samples.push(decQ(a % 1000n, Number(b % 15n) - 3, b % 8n < 4n ? 'DecimalSI' : 'DecimalExponent'));
      }
    }
    for (const q of samples) {
      const s = canonicalQuantity(quantityString(q));
      expect(typeof s).toBe('string');
      expect(compareQuantities(must(s as string), q)).toBe(0);
    }
  });
});

describe('comparison and arithmetic', () => {
  it('TestQuantityCmp', () => {
    expect(compareQuantities(must('0'), must('0'))).toBe(0);
    expect(compareQuantities(must('100m'), must('50m'))).toBe(1);
    expect(compareQuantities(must('50m'), must('100m'))).toBe(-1);
    expect(compareQuantities(must('10000T'), must('100Gi'))).toBe(1);
    expect(compareQuantities(decQ(0, 0, 'DecimalSI'), zero('DecimalSI'))).toBe(0);
    expect(compareQuantities(zero('DecimalSI'), decQ(10, 0, 'DecimalSI'))).toBe(-1);
    expect(compareQuantities(zero('DecimalSI'), decQ(-10, 0, 'DecimalSI'))).toBe(1);
    expect(compareQuantities(decQ(10, 0, 'DecimalSI'), zero('DecimalSI'))).toBe(1);
    expect(compareQuantities(decQ(-10, 0, 'DecimalSI'), zero('DecimalSI'))).toBe(-1);
  });

  const e18 = 1000000n * 1000000n * 1000000n;
  const cmpTable: readonly (readonly [Quantity, Quantity, -1 | 0 | 1])[] = [
    [intQ(901, -2, 'DecimalSI'), intQ(901, -2, 'DecimalSI'), 0],
    [intQ(90, -1, 'DecimalSI'), intQ(901, -2, 'DecimalSI'), -1],
    [intQ(901, -2, 'DecimalSI'), intQ(900, -2, 'DecimalSI'), 1],
    [intQ(0, 0, 'DecimalSI'), intQ(0, 0, 'DecimalSI'), 0],
    [intQ(0, 1, 'DecimalSI'), intQ(0, -1, 'DecimalSI'), 0],
    [intQ(0, -1, 'DecimalSI'), intQ(0, 1, 'DecimalSI'), 0],
    [intQ(800, -3, 'DecimalSI'), intQ(1, 0, 'DecimalSI'), -1],
    [intQ(800, -3, 'DecimalSI'), intQ(79, -2, 'DecimalSI'), 1],

    [intQ(MOST_POSITIVE, 0, 'DecimalSI'), intQ(1, -1, 'DecimalSI'), 1],
    [intQ(MOST_POSITIVE, 1, 'DecimalSI'), intQ(1, 0, 'DecimalSI'), 1],
    [intQ(MOST_POSITIVE, 1, 'DecimalSI'), intQ(1, 1, 'DecimalSI'), 1],
    [intQ(MOST_POSITIVE, 1, 'DecimalSI'), intQ(0, 1, 'DecimalSI'), 1],
    [intQ(MOST_POSITIVE, -16, 'DecimalSI'), intQ(1, 3, 'DecimalSI'), -1],

    [intQ(MOST_NEGATIVE, 0, 'DecimalSI'), intQ(0, 0, 'DecimalSI'), -1],
    [intQ(MOST_NEGATIVE, -18, 'DecimalSI'), intQ(-1, 0, 'DecimalSI'), -1],
    [intQ(MOST_NEGATIVE, -19, 'DecimalSI'), intQ(-1, 0, 'DecimalSI'), 1],

    [intQ(e18, -17, 'DecimalSI'), intQ(1, 1, 'DecimalSI'), 0],
    [intQ(e18, -17, 'DecimalSI'), intQ(-10, 0, 'DecimalSI'), 1],
    [intQ(-e18, -17, 'DecimalSI'), intQ(-10, 0, 'DecimalSI'), 0],
    [intQ(e18, -17, 'DecimalSI'), intQ(1, 0, 'DecimalSI'), 1],

    [intQ(e18 + 1n, -17, 'DecimalSI'), intQ(1, 1, 'DecimalSI'), 1],
    [intQ(e18 - 1n, -17, 'DecimalSI'), intQ(1, 1, 'DecimalSI'), -1],
  ];

  it.each(cmpTable)('TestQuantityCmpInt64AndDec %#', (a, b, want) => {
    for (const [x, y] of [[a, b], [toDec(a), b], [a, toDec(b)], [toDec(a), toDec(b)]] as const) {
      expect(compareQuantities(x, y)).toBe(want);
      expect(compareQuantities(y, x)).toBe(want === 0 ? 0 : -want);
    }
  });

  it('TestQuantityNeg', () => {
    for (const q of [intQ(901, -2, 'DecimalSI'), decQ(901, -2, 'DecimalSI')]) {
      const out = negQuantity(q);
      expect(compareQuantities(out, q)).not.toBe(0);
      expect(quantityString(out)).toBe('-9010m');
    }
  });

  it('TestNeg', () => {
    const table = [
      [intQ(0, 0, 'DecimalSI'), intQ(0, 0, 'DecimalSI')],
      [zero('DecimalSI'), zero('DecimalSI')],
      [intQ(10, 0, 'BinarySI'), intQ(-10, 0, 'BinarySI')],
      [intQ(-10, 0, 'BinarySI'), intQ(10, 0, 'BinarySI')],
      [decQ(0, 0, 'DecimalSI'), intQ(0, 0, 'DecimalSI')],
      [decQ(10, 0, 'BinarySI'), intQ(-10, 0, 'BinarySI')],
      [decQ(-10, 0, 'BinarySI'), intQ(10, 0, 'BinarySI')],
    ] as const;
    for (const [a, want] of table) expect(compareQuantities(negQuantity(a), want)).toBe(0);
  });

  it('TestQuantityRoundUp', () => {
    const table = [
      ['9.01', -3, decQ(901, -2, 'DecimalSI'), true],
      ['9.01', -2, decQ(901, -2, 'DecimalSI'), true],
      ['9.01', -1, decQ(91, -1, 'DecimalSI'), false],
      ['9.01', 0, decQ(10, 0, 'DecimalSI'), false],
      ['9.01', 1, decQ(10, 0, 'DecimalSI'), false],
      ['9.01', 2, decQ(100, 0, 'DecimalSI'), false],
      ['-9.01', -3, decQ(-901, -2, 'DecimalSI'), true],
      ['-9.01', -2, decQ(-901, -2, 'DecimalSI'), true],
      ['-9.01', -1, decQ(-91, -1, 'DecimalSI'), false],
      ['-9.01', 0, decQ(-10, 0, 'DecimalSI'), false],
      ['-9.01', 1, decQ(-10, 0, 'DecimalSI'), false],
      ['-9.01', 2, decQ(-100, 0, 'DecimalSI'), false],
    ] as const;
    for (const asDec of [false, true]) {
      for (const [input, scale, want, exact] of table) {
        const q = asDec ? toDec(must(input)) : must(input);
        const r = roundUpQuantity(q, scale);
        expect(r.exact).toBe(exact);
        expect(compareQuantities(r.quantity, want)).toBe(0);
      }
    }
  });

  it('TestAdd', () => {
    const table = [
      [decQ(10, 0, 'DecimalSI'), decQ(1, 1, 'DecimalSI'), decQ(20, 0, 'DecimalSI')],
      [decQ(10, 0, 'DecimalSI'), decQ(1, 0, 'BinarySI'), decQ(11, 0, 'DecimalSI')],
      [decQ(10, 0, 'BinarySI'), decQ(1, 0, 'DecimalSI'), decQ(11, 0, 'BinarySI')],
      [zero('DecimalSI'), decQ(50, 0, 'DecimalSI'), decQ(50, 0, 'DecimalSI')],
      [decQ(50, 0, 'DecimalSI'), zero('DecimalSI'), decQ(50, 0, 'DecimalSI')],
      [zero('DecimalSI'), zero('DecimalSI'), decQ(0, 0, 'DecimalSI')],
    ] as const;
    for (const [a, b, want] of table) expect(compareQuantities(addQuantities(a, b), want)).toBe(0);
  });

  it('TestSub', () => {
    const table = [
      [decQ(10, 0, 'DecimalSI'), decQ(1, 1, 'DecimalSI'), decQ(0, 0, 'DecimalSI')],
      [decQ(10, 0, 'DecimalSI'), decQ(1, 0, 'BinarySI'), decQ(9, 0, 'DecimalSI')],
      [decQ(10, 0, 'BinarySI'), decQ(1, 0, 'DecimalSI'), decQ(9, 0, 'BinarySI')],
      [zero('DecimalSI'), decQ(50, 0, 'DecimalSI'), decQ(-50, 0, 'DecimalSI')],
      [decQ(50, 0, 'DecimalSI'), zero('DecimalSI'), decQ(50, 0, 'DecimalSI')],
      [zero('DecimalSI'), zero('DecimalSI'), decQ(0, 0, 'DecimalSI')],
    ] as const;
    for (const [a, b, want] of table) expect(compareQuantities(subQuantities(a, b), want)).toBe(0);
  });

  it.each(['100m', '1Gi'])('TestQuantityAddZeroPreservesSuffix / SubZero %s', (s) => {
    const v = must(s);
    const z = must('0');
    expect(quantityString(addQuantities(v, z))).toBe(s);
    expect(quantityString(addQuantities(z, v))).toBe(s);
    expect(quantityString(subQuantities(v, z))).toBe(s);
    expect(quantityString(subQuantities(z, v))).toBe(quantityString(negQuantity(v)));
  });

  it('an int64 sum that overflows moves to inf.Dec and stays exact', () => {
    const r = addQuantities(intQ(MOST_POSITIVE, 0, 'DecimalSI'), intQ(1, 0, 'DecimalSI'));
    expect(r.rep).toBe('dec');
    expect(quantityString(r)).toBe('9223372036854775808');
    expect(quantityString(addQuantities(must('1Gi'), must('512Mi')))).toBe('1536Mi');
    expect(quantityString(addQuantities(must('250m'), must('1')))).toBe('1250m');
  });

  it('TestMul', () => {
    const table: readonly (readonly [Quantity, bigint, Quantity, boolean])[] = [
      [decQ(10, 0, 'DecimalSI'), 10n, decQ(100, 0, 'DecimalSI'), true],
      [decQ(10, 0, 'DecimalSI'), 1n, decQ(10, 0, 'DecimalSI'), true],
      [decQ(10, 0, 'BinarySI'), 1n, decQ(10, 0, 'BinarySI'), true],
      [zero('DecimalSI'), 50n, decQ(0, 0, 'DecimalSI'), true],
      [decQ(50, 0, 'DecimalSI'), 0n, decQ(0, 0, 'DecimalSI'), true],
      [zero('DecimalSI'), 0n, decQ(0, 0, 'DecimalSI'), true],

      [decQ(10, 0, 'DecimalSI'), -10n, decQ(-100, 0, 'DecimalSI'), true],
      [decQ(-10, 0, 'DecimalSI'), 1n, decQ(-10, 0, 'DecimalSI'), true],
      [decQ(10, 0, 'BinarySI'), -1n, decQ(-10, 0, 'BinarySI'), true],
      [decQ(-50, 0, 'DecimalSI'), 0n, decQ(0, 0, 'DecimalSI'), true],
      [decQ(-50, 0, 'DecimalSI'), -50n, decQ(2500, 0, 'DecimalSI'), true],
      [zero('DecimalSI'), -50n, decQ(0, 0, 'DecimalSI'), true],
      [decQ(MOST_POSITIVE, 0, 'DecimalSI'), 0n, decQ(0, 1, 'DecimalSI'), true],
      [decQ(MOST_POSITIVE, 0, 'DecimalSI'), 1n, decQ(MOST_POSITIVE, 0, 'DecimalSI'), true],
      [decQ(MOST_POSITIVE, 0, 'DecimalSI'), -1n, decQ(-MOST_POSITIVE, 0, 'DecimalSI'), true],
      [decQ(MOST_POSITIVE / 2n, 0, 'DecimalSI'), 2n, decQ((MOST_POSITIVE / 2n) * 2n, 0, 'DecimalSI'), true],
      [decQ(MOST_POSITIVE / -2n, 0, 'DecimalSI'), -2n, decQ((MOST_POSITIVE / 2n) * 2n, 0, 'DecimalSI'), true],
      [decQ(MOST_POSITIVE, 0, 'DecimalSI'), 2n, decQ(MOST_POSITIVE * 2n, 0, 'DecimalSI'), false],
      [decQ(MOST_POSITIVE, 0, 'DecimalSI'), 10n, decQ(MOST_POSITIVE, 1, 'DecimalSI'), false],
      [decQ(MOST_POSITIVE, 0, 'DecimalSI'), -10n, decQ(-MOST_POSITIVE, 1, 'DecimalSI'), false],
      [decQ(MOST_NEGATIVE, 0, 'DecimalSI'), 0n, decQ(0, 1, 'DecimalSI'), true],
      [decQ(MOST_NEGATIVE, 0, 'DecimalSI'), 1n, decQ(MOST_NEGATIVE, 0, 'DecimalSI'), true],
      [decQ(MOST_NEGATIVE, 0, 'DecimalSI'), -1n, decQ(MOST_POSITIVE + 1n, 0, 'DecimalSI'), false],
      [decQ(MOST_NEGATIVE / 2n, 0, 'DecimalSI'), 2n, decQ(MOST_NEGATIVE, 0, 'DecimalSI'), true],
      [decQ(MOST_NEGATIVE / -2n, 0, 'DecimalSI'), -2n, decQ(MOST_NEGATIVE, 0, 'DecimalSI'), true],
      [decQ(MOST_NEGATIVE, 0, 'DecimalSI'), 2n, decQ(MOST_NEGATIVE * 2n, 0, 'DecimalSI'), false],
      [decQ(MOST_NEGATIVE, 0, 'DecimalSI'), 10n, decQ(MOST_NEGATIVE, 1, 'DecimalSI'), false],
      [decQ(MOST_NEGATIVE, 0, 'DecimalSI'), -10n, decQ(MOST_POSITIVE + 1n, 1, 'DecimalSI'), false],
    ];
    for (const [a, b, want, ok] of table) {
      const r = mulQuantity(a, b);
      expect(r.exact).toBe(ok);
      expect(compareQuantities(r.quantity, want)).toBe(0);
    }
    // the int64 fast path keeps its representation when it can
    expect(mulQuantity(intQ(15, -1, 'DecimalSI'), 2n).quantity.rep).toBe('int64');
    expect(mulQuantity(intQ(15, -1, 'DecimalSI'), 3n).quantity.rep).toBe('dec');
  });

  it('TestAddSubRoundTrip', () => {
    for (let k = -10; k <= 10; k++) {
      let q = zero('DecimalSI');
      const order = int63s(BigInt(k + 100), 100);
      for (const j of order) q = addQuantities(q, newScaledQuantity(j, k));
      for (const j of order) q = subQuantities(q, newScaledQuantity(j, k));
      expect(isZero(q)).toBe(true);
    }
  });

  it('TestAddSubRoundTripAcrossScales', () => {
    let q = zero('DecimalSI');
    const order = int63s(42n, 100);
    for (const j of order) q = addQuantities(q, newScaledQuantity(j, Number(j % 20n) - 10));
    for (const j of order) q = subQuantities(q, newScaledQuantity(j, Number(j % 20n) - 10));
    expect(isZero(q)).toBe(true);
  });

  it('TestNegateRoundTrip', () => {
    for (const asDec of [false, true]) {
      for (let k = -10; k <= 10; k++) {
        for (const j of int63s(BigInt(k + 1000), 100)) {
          const q = asDec ? toDec(newScaledQuantity(j, k)) : newScaledQuantity(j, k);
          expect(compareQuantities(negQuantity(negQuantity(q)), q)).toBe(0);
        }
      }
    }
  });
});

describe('values', () => {
  it('TestScaledValue', () => {
    const table = [
      [NANO, NANO, 1n],
      [NANO, MICRO, 1n],
      [NANO, MILLI, 1n],
      [NANO, 0, 1n],
      [MICRO, NANO, 1000n],
      [MICRO, MICRO, 1n],
      [MICRO, MILLI, 1n],
      [MICRO, 0, 1n],
      [MILLI, NANO, 1000n * 1000n],
      [MILLI, MICRO, 1000n],
      [MILLI, MILLI, 1n],
      [MILLI, 0, 1n],
      [0, NANO, 1000n * 1000n * 1000n],
      [0, MICRO, 1000n * 1000n],
      [0, MILLI, 1000n],
      [0, 0, 1n],
      [2, -2, 100n * 100n],
    ] as const;
    for (const [from, to, want] of table) {
      expect(scaledValue(newScaledQuantity(1, from), to)).toBe(want);
      expect(scaledValue(toDec(newScaledQuantity(1, from)), to)).toBe(want);
    }
  });

  it('ExampleMustParse', () => {
    expect([value(must('5Gi')), must('5Gi').format]).toEqual([5368709120, 'BinarySI']);
    expect([value(must('5G')), must('5G').format]).toEqual([5000000000, 'DecimalSI']);
    expect([milliValue(must('5300m')), must('5300m').format]).toEqual([5300, 'DecimalSI']);
    expect([milliValue(must('5.4')), must('5.4').format]).toEqual([5400, 'DecimalSI']);
  });

  it('Value rounds up', () => {
    expect(value(must('100m'))).toBe(1);
    expect(value(must('1.5'))).toBe(2); // inf.Dec
    expect(value(must('1500m'))).toBe(2); // int64Amount
    expect(milliValue(must('1n'))).toBe(1);
    expect(value(must('0'))).toBe(0);
  });

  it('keeps the int64Amount / inf.Dec differences for negative fractions', () => {
    // int64Amount rounds away from zero
    expect(value(must('-1500m'))).toBe(-2);
    // inf.Dec's fast path truncates, then adds one: ceil + 1 for a negative fraction
    expect(value(must('-1.0000000000000000005'))).toBe(0); // 19 digits: parsed as inf.Dec, -1.000000001
    expect(value(must('-1.5'))).toBe(-2); // few digits: parsed as int64Amount
    expect(value(toDec(must('-1500m')))).toBe(0);
  });

  it('wraps or zeroes on int64 overflow as upstream does', () => {
    // positiveScaleInt64 by the loop: 0 on overflow
    expect(scaledValue(must('1e19'), 0)).toBe(0n);
    // positiveScaleInt64 by ×1000: the wrapped product
    expect(scaledValue(intQ(MOST_POSITIVE, 0, 'DecimalSI'), MILLI)).toBe(BigInt.asIntN(64, MOST_POSITIVE * 1000n));
    // inf.Dec: big.Int.Int64 wraps
    expect(scaledValue(must('9Ei'), MILLI)).toBe(BigInt.asIntN(64, MOST_POSITIVE * 1000n));
    expect(scaledValue(must('10000000000000000000'), 0)).toBe(BigInt.asIntN(64, 10n ** 19n));
    // "10E" is an int64Amount of 10 × 10^18: the loop overflows to 0
    expect(scaledValue(must('10E'), 0)).toBe(0n);
  });

  it('asInt64', () => {
    expect(asInt64(must('1k'))).toBe(1000n);
    expect(asInt64(must('1m'))).toBeUndefined();
    expect(asInt64(must('1.5'))).toBeUndefined();
    expect(asInt64(must('1e19'))).toBeUndefined();
  });

  it.each([
    [decQ(0, 0, 'DecimalSI'), 0],
    [decQ(0, 0, 'DecimalExponent'), 0],
    [decQ(0, 0, 'BinarySI'), 0],
    [decQ(1, 0, 'DecimalSI'), 1],
    [decQ(1024, 0, 'BinarySI'), 1024],
    [decQ(8 * 1024, 0, 'BinarySI'), 8 * 1024],
    [decQ(7 * 1024 * 1024, 0, 'BinarySI'), 7 * 1024 * 1024],
    [decQ(7 * 1024 * 1024, 1, 'BinarySI'), 7 * 1024 * 1024 * 10],
    [decQ(7 * 1024 * 1024, 4, 'BinarySI'), 7 * 1024 * 1024 * 10000],
    [decQ(7 * 1024 * 1024, 8, 'BinarySI'), 7 * 1024 * 1024 * 100000000],
    [decQ(7 * 1024 * 1024, -1, 'DecimalSI'), 7 * 1024 * 1024 * 0.1],
    [decQ(7 * 1024 * 1024, -8, 'DecimalSI'), (7 * 1024 * 1024) / 100000000],
    [maxAllowed('DecimalSI'), 2 ** 63], // float64(math.MaxInt64)
    [maxAllowed('BinarySI'), 2 ** 63],
    [decQ(12, 18, 'DecimalSI'), 1.2e19],
    [decQ(12, 500, 'DecimalSI'), Infinity],
    [decQ(-12, 500, 'DecimalSI'), -Infinity],
  ])('TestQuantityAsApproximateFloat64 %#', (q, want) => {
    expect(asApproximateFloat64(q)).toBe(want);
  });

  it.each([
    ['2Ki', 2048],
    ['1.1Ki', 1126.4],
    ['1Mi', 1.048576e6],
    ['2Gi', 2.147483648e9],
  ])('TestStringQuantityAsApproximateFloat64 %s', (s, want) => {
    expect(asApproximateFloat64(must(s))).toBe(want);
  });
});
