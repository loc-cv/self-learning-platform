import { describe, expect, test } from 'vitest';
import type { Json } from './json.ts';
import { BAD_JSON_PATCH, mergePatch, mergePatchError } from './mergepatch.ts';

/** JSON text, so key order is part of the comparison. */
const merged = (target: Json, patch: Json): string => JSON.stringify(mergePatch(target, patch));

describe('RFC 7386 appendix A', () => {
  test.each<[Json, Json, Json]>([
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ e: null }, { a: 1 }, { a: 1, e: null }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ])('%j + %j', (target, patch, want) => {
    expect(merged(target, patch)).toBe(JSON.stringify(want));
  });

  test('a null or scalar patch is ErrBadJSONPatch in json-patch v4', () => {
    for (const p of [null, 'bar', 1, true] as Json[]) expect(mergePatchError(p)).toBe(BAD_JSON_PATCH);
    for (const p of [{}, [], { a: null }] as Json[]) expect(mergePatchError(p)).toBeNull();
    expect(BAD_JSON_PATCH).toBe('Invalid JSON Patch');
  });
});

describe('json-patch v4 specifics', () => {
  test('the API server cases (fixtures/golden/cases/api/crud.yaml)', () => {
    const cm = { kind: 'ConfigMap', apiVersion: 'v1', metadata: { name: 'cm1', namespace: 'default', labels: { tier: 'web', app: 'one' } }, data: { k: 'v' } };
    expect(merged(cm, { metadata: { labels: { tier: null, patched: 'yes' } }, data: { k2: 'v2' } })).toBe(
      JSON.stringify({ apiVersion: 'v1', data: { k: 'v', k2: 'v2' }, kind: 'ConfigMap', metadata: { labels: { app: 'one', patched: 'yes' }, name: 'cm1', namespace: 'default' } }),
    );
    expect(mergePatch({ metadata: { finalizers: ['a'] } }, { metadata: { finalizers: null } })).toEqual({ metadata: {} });
  });

  test('merged and inserted objects get sorted keys; untouched subtrees keep their order', () => {
    const target = { z: 1, spec: { y: 1, x: 1 }, status: { b: 1, a: 1 } };
    expect(merged(target, { spec: { w: 1 } })).toBe('{"spec":{"w":1,"x":1,"y":1},"status":{"b":1,"a":1},"z":1}');
    expect(merged(target, {})).toBe('{"spec":{"y":1,"x":1},"status":{"b":1,"a":1},"z":1}');
    expect(merged(target, { new: { q: 1, p: { n: 1, m: 1 } } })).toBe('{"new":{"p":{"m":1,"n":1},"q":1},"spec":{"y":1,"x":1},"status":{"b":1,"a":1},"z":1}');
  });

  test('pruneNulls reaches objects inside inserted arrays and keeps null elements', () => {
    expect(merged({}, { a: [{ y: null, z: 1, b: 2 }, null] })).toBe('{"a":[{"b":2,"z":1},null]}');
    expect(merged({ a: 5 }, { a: [{ y: null }] })).toBe('{"a":[{}]}');
    // replacing an object member with an array returns the patch value as is
    expect(merged({ a: { x: 1 } }, { a: [{ z: 1, y: null }] })).toBe('{"a":[{"z":1,"y":null}]}');
    // a top-level array patch is pruned the same way
    expect(merged({ a: 1 }, [{ b: null, a: 1 }, null])).toBe('[{"a":1},null]');
  });

  test('a member that is null in the target counts as absent', () => {
    expect(merged({ a: null }, { a: { b: null, c: 1 } })).toBe('{"a":{"c":1}}');
  });

  test('inputs are not modified', () => {
    const target: Json = Object.freeze({ a: Object.freeze({ b: 1 }) }) as Json;
    const patch: Json = Object.freeze({ a: Object.freeze({ c: 2 }) }) as Json;
    expect(mergePatch(target, patch)).toEqual({ a: { b: 1, c: 2 } });
    expect(target).toEqual({ a: { b: 1 } });
  });
});
