import { describe, expect, test } from 'vitest';
import { initialPrngState, nextUint32, randomOver, type PrngState } from './prng.ts';

describe('xoshiro128**', () => {
  test('matches the reference algorithm', () => {
    // Expected values from an independent Python transcription of xoshiro128starstar.c
    // (https://prng.di.unimi.it/xoshiro128starstar.c) started from state [1, 2, 3, 4].
    const s: PrngState = [1, 2, 3, 4];
    const out = Array.from({ length: 6 }, () => nextUint32(s));
    expect(out).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492]);
  });

  test('initial state depends on seed and name only', () => {
    expect(initialPrngState(7, 'k8s.names')).toEqual(initialPrngState(7, 'k8s.names'));
    expect(initialPrngState(7, 'k8s.names')).not.toEqual(initialPrngState(8, 'k8s.names'));
    expect(initialPrngState(7, 'k8s.names')).not.toEqual(initialPrngState(7, 'host.pids'));
    for (const word of initialPrngState(0, '')) {
      expect(Number.isInteger(word) && word >= 0 && word < 2 ** 32).toBe(true);
    }
  });
});

describe('Random', () => {
  const fresh = (name = 'test') => randomOver(initialPrngState(42, name));

  test('int stays in range and covers it', () => {
    const r = fresh();
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 6000; i++) {
      const v = r.int(6);
      expect(v >= 0 && v < 6 && Number.isInteger(v)).toBe(true);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    // Each bucket expects 1000; a 4-sigma band is about ±115.
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(150);
  });

  test('int rejects bad bounds', () => {
    const r = fresh();
    expect(() => r.int(0)).toThrow(RangeError);
    expect(() => r.int(1.5)).toThrow(RangeError);
    expect(() => r.int(2 ** 32 + 1)).toThrow(RangeError);
    expect(r.int(1)).toBe(0);
  });

  test('float is in [0, 1)', () => {
    const r = fresh();
    for (let i = 0; i < 1000; i++) {
      const f = r.float();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });

  test('shuffle returns a permutation and leaves the input alone', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const out = fresh().shuffle(items);
    expect([...out].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('pick and chars draw from what they are given', () => {
    const r = fresh();
    expect(['x', 'y']).toContain(r.pick(['x', 'y']));
    expect(() => r.pick([])).toThrow(RangeError);
    expect(r.chars(10, 'bcdf')).toMatch(/^[bcdf]{10}$/);
  });

  test('the same state draws the same sequence', () => {
    const a = fresh();
    const b = fresh();
    expect(Array.from({ length: 20 }, () => a.int(1000))).toEqual(Array.from({ length: 20 }, () => b.int(1000)));
  });
});
