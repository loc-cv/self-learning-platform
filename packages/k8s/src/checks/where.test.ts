// where clauses: each operator on one value, on several values, and on none.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../apimachinery/json.ts';
import { compileWhere, valuesPhrase, whereHolds, wherePhrase, type WhereClause } from './where.ts';

const obj: JsonObject = {
  metadata: { name: 'web', finalizers: ['a/b', 'c/d'], labels: { tier: 'front' } },
  spec: { replicas: 3, ports: ['80', '443'], weight: '10', template: { x: 1, y: [2] } },
};

function holds(clause: WhereClause): boolean {
  const c = compileWhere(clause);
  if ('error' in c) throw new Error(c.error);
  return whereHolds(c, obj).holds;
}

describe('where operators', () => {
  test('equals compares the printed text; objects as JSON', () => {
    expect(holds({ path: '{.spec.replicas}', equals: 3 })).toBe(true);
    expect(holds({ path: '{.spec.replicas}', equals: '3' })).toBe(true);
    expect(holds({ path: '{.spec.replicas}', equals: 2 })).toBe(false);
    expect(holds({ path: '{.spec.template}', equals: { y: [2], x: 1 } })).toBe(true);
    expect(holds({ path: '{.metadata.finalizers}', equals: ['a/b', 'c/d'] })).toBe(true);
  });

  test('notEquals, in', () => {
    expect(holds({ path: '{.spec.replicas}', notEquals: 2 })).toBe(true);
    expect(holds({ path: '{.spec.replicas}', notEquals: 3 })).toBe(false);
    expect(holds({ path: '{.metadata.labels.tier}', in: ['back', 'front'] })).toBe(true);
    expect(holds({ path: '{.metadata.labels.tier}', in: ['back'] })).toBe(false);
  });

  test('contains: a substring of a string, an element of a list', () => {
    expect(holds({ path: '{.metadata.name}', contains: 'e' })).toBe(true);
    expect(holds({ path: '{.metadata.finalizers}', contains: 'c/d' })).toBe(true);
    expect(holds({ path: '{.metadata.finalizers}', contains: 'c' })).toBe(false);
    expect(holds({ path: '{.spec.replicas}', contains: 3 })).toBe(false);
  });

  test('matches, gte, lte', () => {
    expect(holds({ path: '{.metadata.name}', matches: '^w.b$' })).toBe(true);
    expect(holds({ path: '{.spec.replicas}', matches: '^[0-9]+$' })).toBe(true);
    expect(holds({ path: '{.spec.replicas}', gte: 3 })).toBe(true);
    expect(holds({ path: '{.spec.replicas}', gte: 4 })).toBe(false);
    expect(holds({ path: '{.spec.weight}', lte: 10 })).toBe(true);
    expect(holds({ path: '{.metadata.name}', lte: 10 })).toBe(false);
  });

  test('several values: every one must satisfy', () => {
    expect(holds({ path: '{.spec.ports[*]}', matches: '^[0-9]+$' })).toBe(true);
    expect(holds({ path: '{.spec.ports[*]}', equals: '80' })).toBe(false);
  });

  test('no value: only exists false and notEquals hold', () => {
    const none = '{.spec.missing}';
    expect(holds({ path: none, exists: false })).toBe(true);
    expect(holds({ path: none, exists: true })).toBe(false);
    expect(holds({ path: none, notEquals: 1 })).toBe(true);
    for (const c of [{ equals: 1 }, { in: [1] }, { contains: 'x' }, { matches: '.*' }, { gte: 0 }, { lte: 0 }]) expect(holds({ path: none, ...c })).toBe(false);
    expect(holds({ path: '{.spec.replicas}', exists: true })).toBe(true);
  });

  test('errors: no operator, two operators, a bad regular expression, unsupported syntax', () => {
    const err = (c: WhereClause) => {
      const r = compileWhere(c);
      return 'error' in r ? r.error : '';
    };
    expect(err({ path: '{.a}' })).toBe('where clause "{.a}" needs exactly one operator (equals, notEquals, in, contains, matches, exists, gte, lte), got 0');
    expect(err({ path: '{.a}', equals: 1, gte: 1 })).toMatch(/got 2$/);
    expect(err({ path: '{.a}', matches: '(' })).toMatch(/^invalid regular expression "\(": /);
    expect(err({ path: '{..a}', equals: 1 })).toMatch(/recursive descent/);
  });
});

describe('phrases', () => {
  test('the requirement and the observed values', () => {
    expect(wherePhrase({ path: '{.spec.replicas}', equals: 3 })).toBe('{.spec.replicas} equals 3');
    expect(wherePhrase({ path: '{.a}', equals: 'x' })).toBe('{.a} equals "x"');
    expect(wherePhrase({ path: '{.a}', in: ['x', 'y'] })).toBe('{.a} is one of "x", "y"');
    expect(wherePhrase({ path: '{.a}', exists: false })).toBe('{.a} is not set');
    expect(wherePhrase({ path: '{.a}', gte: 2 })).toBe('{.a} >= 2');
    expect(valuesPhrase('{.a}', [])).toBe('{.a} is not set');
    expect(valuesPhrase('{.a}', [2])).toBe('{.a} is 2');
    expect(valuesPhrase('{.a}', ['x', 'y'])).toBe('{.a} is "x" "y"');
  });
});
