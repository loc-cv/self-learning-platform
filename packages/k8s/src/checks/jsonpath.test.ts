// The JSONPath subset of the checks: the supported syntax, what it yields, and the unsupported
// syntax it names instead of guessing.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../apimachinery/json.ts';
import { canonicalJson, evaluate, parsePath, textOf } from './jsonpath.ts';

const pod: JsonObject = {
  metadata: { name: 'web', labels: { app: 'web', 'app.kubernetes.io/name': 'shop' }, annotations: { 'a.b/c': 'x' } },
  spec: { replicas: 3, containers: [{ name: 'nginx', image: 'nginx:1.27' }, { name: 'sidecar', image: 'busybox' }], paused: false, empty: null },
};

function values(path: string): unknown[] {
  const p = parsePath(path);
  if ('error' in p) throw new Error(p.error);
  return evaluate(pod, p.steps);
}

describe('parsePath and evaluate', () => {
  test('fields, indexes, wildcards, quoted and escaped keys', () => {
    expect(values('{.spec.replicas}')).toEqual([3]);
    expect(values('{$.spec.replicas}')).toEqual([3]);
    expect(values('{.spec.containers[0].image}')).toEqual(['nginx:1.27']);
    expect(values('{.spec.containers[-1].name}')).toEqual(['sidecar']);
    expect(values('{.spec.containers[*].name}')).toEqual(['nginx', 'sidecar']);
    expect(values("{.metadata.annotations['a.b/c']}")).toEqual(['x']);
    expect(values('{.metadata.labels.app\\.kubernetes\\.io/name}')).toEqual(['shop']);
    expect(values('{.metadata.labels.*}')).toEqual(['web', 'shop']);
    expect(values('{.spec.paused}')).toEqual([false]);
  });

  test('missing fields, out-of-range indexes and nulls yield nothing', () => {
    expect(values('{.spec.missing}')).toEqual([]);
    expect(values('{.spec.containers[5].name}')).toEqual([]);
    expect(values('{.spec.containers.name}')).toEqual([]);
    expect(values('{.spec.empty}')).toEqual([]);
  });

  test('unsupported syntax is an error naming it', () => {
    const err = (p: string) => {
      const r = parsePath(p);
      return 'error' in r ? r.error : '';
    };
    expect(err('.spec.replicas')).toBe('unsupported JSONPath syntax in ".spec.replicas": the path must be one {…} expression, such as {.spec.replicas}');
    expect(err('{..name}')).toBe('unsupported JSONPath syntax in "{..name}": recursive descent (..)');
    expect(err('{.items[?(@.a=="b")].c}')).toBe('unsupported JSONPath syntax in "{.items[?(@.a==\\"b\\")].c}": a filter [?(@.a=="b")]');
    expect(err('{.a[0:2]}')).toMatch(/a slice \[0:2\]$/);
    expect(err('{.a[0,1]}')).toMatch(/a union \[0,1\]$/);
    expect(err('{.a} {.b}')).toMatch(/more than one/);
    expect(err('{.a[0}')).toMatch(/an unclosed \[$/);
    expect(err('{}')).toMatch(/an empty expression$/);
  });
});

describe('textOf', () => {
  test('strings as is, numbers and booleans as JSON, objects with sorted keys', () => {
    expect(textOf('3')).toBe('3');
    expect(textOf(3)).toBe('3');
    expect(textOf(true)).toBe('true');
    expect(textOf({ b: 1, a: [1, 'x'] })).toBe('{"a":[1,"x"],"b":1}');
    expect(canonicalJson(['a'])).toBe('["a"]');
  });
});
