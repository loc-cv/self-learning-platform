// Ported from upstream: staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr_test.go, v1.37.2.

import { describe, expect, it } from 'vitest';
import { getIntOrPercentValueSafely, getScaledValueFromIntOrPercent, intOrStringIntValue } from './intstr.ts';

describe('getIntOrPercentValueSafely', () => {
  // TestGetIntFromIntOrString
  it.each([
    [200, { value: 200, isPercent: false }],
    ['200', { error: 'invalid type: string is not a percentage' }],
    ['30%0', { error: 'invalid type: string is not a percentage' }],
    ['40%', { value: 40, isPercent: true }],
    ['%', { error: 'invalid value "%": strconv.Atoi: parsing "": invalid syntax' }],
    ['a%', { error: 'invalid value "a%": strconv.Atoi: parsing "a": invalid syntax' }],
    ['a', { error: 'invalid type: string is not a percentage' }],
    ['40#', { error: 'invalid type: string is not a percentage' }],
    ['40%%', { error: 'invalid value "40%%": strconv.Atoi: parsing "40%": invalid syntax' }],
    ['+5%', { value: 5, isPercent: true }],
    ['-5%', { value: -5, isPercent: true }],
    ['1_0%', { error: 'invalid value "1_0%": strconv.Atoi: parsing "1_0": invalid syntax' }],
    ['99999999999999999999%', { error: 'invalid value "99999999999999999999%": strconv.Atoi: parsing "99999999999999999999": value out of range' }],
  ] as const)('%j', (input, want) => {
    expect(getIntOrPercentValueSafely(input)).toEqual(want);
  });
});

describe('getScaledValueFromIntOrPercent', () => {
  // TestGetIntFromIntOrPercent
  it.each([
    [123, 0, false, { value: 123 }],
    ['90%', 100, true, { value: 90 }],
    ['90%', 95, true, { value: 86 }],
    ['90%', 95, false, { value: 85 }],
    ['%', 0, false, { error: 'invalid value for IntOrString: invalid value "%": strconv.Atoi: parsing "": invalid syntax' }],
    ['90#', 0, false, { error: 'invalid value for IntOrString: invalid type: string is not a percentage' }],
    ['#%', 0, false, { error: 'invalid value for IntOrString: invalid value "#%": strconv.Atoi: parsing "#": invalid syntax' }],
    ['90', 0, false, { error: 'invalid value for IntOrString: invalid type: string is not a percentage' }],
    ['25%', 3, true, { value: 1 }],
    ['25%', 3, false, { value: 0 }],
  ] as const)('%j of %d (roundUp=%s)', (input, total, roundUp, want) => {
    expect(getScaledValueFromIntOrPercent(input, total, roundUp)).toEqual(want);
  });

  it('TestGetValueFromIntOrPercentNil', () => {
    expect(getScaledValueFromIntOrPercent(undefined, 0, false)).toEqual({ error: 'nil value for IntOrString' });
    expect(getScaledValueFromIntOrPercent(null, 0, false)).toEqual({ error: 'nil value for IntOrString' });
  });
});

describe('intOrStringIntValue', () => {
  it.each([
    [7, 7],
    ['7', 7],
    ['-7', -7],
    ['7%', 0],
    ['', 0],
  ] as const)('%j', (input, want) => {
    expect(intOrStringIntValue(input)).toBe(want);
  });
});
