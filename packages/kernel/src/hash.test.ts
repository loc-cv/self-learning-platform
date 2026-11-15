import { describe, expect, test } from 'vitest';
import { hashNode, hashString } from './hash.ts';
import { deepFreeze } from './json.ts';

describe('hashString', () => {
  test('is the cyrb53 core', () => {
    // cyrb53 returns the low 21 bits of lane 2 above lane 1. Expected values are the examples
    // published with it: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
    const cyrb53 = (s: string) => {
      const h = hashString(s);
      return 4294967296 * (2097151 & parseInt(h.slice(0, 8), 16)) + parseInt(h.slice(8), 16);
    };
    expect(cyrb53('a')).toBe(7929297801672961);
    expect(cyrb53('b')).toBe(8684336938537663);
    expect(cyrb53('revenge')).toBe(4051478007546757);
    expect(cyrb53('revenue')).toBe(8309097637345594);
  });

  test('is 16 hex digits and stable across releases', () => {
    // Pinned so an accidental change of the function (which would invalidate every recorded
    // checkpoint) fails here first.
    expect(hashString('')).toBe('488bdcb81aee8d83');
    expect(hashString('simlab')).toBe('8c5f4b9e0f248808');
    expect(hashString('simlab')).toBe(hashString('simlab'));
    expect(hashString('simlab')).not.toBe(hashString('simlab', 1));
    expect(hashString('simlab')).not.toBe(hashString('simlaB'));
  });
});

describe('hashNode', () => {
  test('ignores key insertion order', () => {
    expect(hashNode({ a: 1, b: [1, 2], c: { x: null } })).toBe(hashNode({ c: { x: null }, b: [1, 2], a: 1 }));
  });

  test('does not depend on which nodes are frozen', () => {
    const plain = { t: { k: { v: 'data', n: 3 } }, list: [{ a: true }] };
    const frozen = { t: { k: deepFreeze({ v: 'data', n: 3 }) }, list: [deepFreeze({ a: true })] };
    expect(hashNode(frozen)).toBe(hashNode(plain));
    expect(hashNode(deepFreeze(structuredClone(plain)))).toBe(hashNode(plain));
  });

  test('distinguishes types and structure', () => {
    const distinct = [1, '1', true, 'true', null, 'null', [], {}, [1], { 0: 1 }, [[1]], [1, 2], [2, 1], { a: '' }, { a: [] }];
    const hashes = distinct.map((v) => hashNode(v));
    expect(new Set(hashes).size).toBe(distinct.length);
  });

  test('a cached value and an equal fresh value hash the same', () => {
    const v = deepFreeze({ name: 'x', data: 'y'.repeat(1000) });
    const first = hashNode({ v });
    expect(hashNode({ v })).toBe(first);
    expect(hashNode({ v: { name: 'x', data: 'y'.repeat(1000) } })).toBe(first);
  });

  test('changing a container changes the hash', () => {
    const shared = deepFreeze({ a: 1 });
    const world = { t: { k: shared } as Record<string, unknown> };
    const before = hashNode(world);
    world.t.k2 = shared;
    expect(hashNode(world)).not.toBe(before);
    delete world.t.k2;
    expect(hashNode(world)).toBe(before);
  });

  test('throws on anything that is not JSON data', () => {
    expect(() => hashNode({ a: undefined })).toThrow(/undefined is not JSON data/);
    expect(() => hashNode({ a: Number.NaN })).toThrow(TypeError);
    expect(() => hashNode({ a: new Map() })).toThrow(/Map/);
    expect(() => hashNode({ a: () => 1 })).toThrow(/function/);
    expect(() => hashNode([1n])).toThrow(/bigint/);
  });
});
