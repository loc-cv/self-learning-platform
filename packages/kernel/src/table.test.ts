import { expect, test } from 'vitest';
import { assertPlainData, deepFreeze } from './json.ts';
import { keys, put, remove, type Table } from './table.ts';

test('put deep-freezes what it stores, and values cannot be edited in place', () => {
  const t: Table<{ a: { b: number[] } }> = {};
  const v = put(t, 'k', { a: { b: [1] } });
  expect(Object.isFrozen(v) && Object.isFrozen(v.a) && Object.isFrozen(v.a.b)).toBe(true);
  expect(() => {
    (v.a.b as number[]).push(2);
  }).toThrow(TypeError);
  expect(Object.isFrozen(t)).toBe(false);
  remove(t, 'k');
  expect(t).toEqual({});
});

test('keys are in code-unit order, not integer-first insertion order', () => {
  const t: Table<number> = {};
  for (const k of ['b', '10', 'a', '2', 'B', '_']) t[k] = 0;
  expect(Object.keys(t)).toEqual(['2', '10', 'b', 'a', 'B', '_']);
  expect(keys(t)).toEqual(['10', '2', 'B', '_', 'a', 'b']);
});

test('deepFreeze does not revisit frozen subtrees', () => {
  const inner = Object.freeze({ x: 1 });
  const outer = deepFreeze({ inner, other: { y: 2 } });
  expect(Object.isFrozen(outer.other)).toBe(true);
});

test('assertPlainData names the offending path', () => {
  expect(() => assertPlainData({ a: [1, { b: new Set() }] })).toThrow('$.a[1].b: an instance of Set is not JSON data');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => assertPlainData(cyclic)).toThrow(/cycle/);
  expect(() => assertPlainData({ a: [1, 'x', null, true, { b: -0 }] })).not.toThrow();
});
