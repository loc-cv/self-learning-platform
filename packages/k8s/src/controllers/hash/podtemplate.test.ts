// pod-template-hash against the real control plane.
//
// podtemplate.fixture.json was captured from the oracle (v1.37.2, npm run oracle -- up) on
// 2026-11-16: Deployments with varied templates were created with kubectl, then each one's stored
// template (`kubectl get deployment -o json`, spec.template) and status.collisionCount were saved
// with the `pod-template-hash` label of its current ReplicaSet. Collisions were forced by creating,
// beforehand, unowned ReplicaSets under the names the Deployment would take (c01: one, c03: two).
// The two templates with timestamps come from a run with TZ set empty for kube-controller-manager:
// govalue.ts models time.Local as Go's UTC fallback (see there); with TZ unset the oracle loaded
// this workstation's /etc/localtime and h19-creationts hashed to 5b4f6dbc4c instead.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import { computeHash, fnv32a, podTemplateForHash, safeEncodeString } from './podtemplate.ts';
import { forHash, type GoValue } from './spew.ts';

interface Case {
  deployment: string;
  collisionCount?: number;
  hash: string;
  template: JsonObject;
}

const fixture = JSON.parse(readFileSync(new URL('./podtemplate.fixture.json', import.meta.url), 'utf8')) as { cases: Case[] };

describe('computeHash matches the oracle', () => {
  it('has the captured cases', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
  });
  it.each(fixture.cases.map((c) => [c.deployment, c] as const))('%s', (_, c) => {
    expect(computeHash(c.template, c.collisionCount)).toBe(c.hash);
  });
});

describe('collision count bytes', () => {
  // upstream ComputeHash: PutUint32 little-endian into an 8-byte slice, all eight written.
  const template: JsonObject = { metadata: { labels: { app: 'x' } }, spec: { containers: [{ name: 'c', image: 'i' }] } };
  it('appends the count as 4 little-endian bytes and 4 zero bytes', () => {
    const base = [...new TextEncoder().encode(podTemplateForHash(template))];
    const sum = (bytes: number[]) => safeEncodeString(String(fnv32a(bytes)));
    expect(computeHash(template, 0x01020304)).toBe(sum([...base, 4, 3, 2, 1, 0, 0, 0, 0]));
    expect(computeHash(template, 0)).toBe(sum([...base, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(computeHash(template)).toBe(sum(base));
    expect(computeHash(template, 0)).not.toBe(computeHash(template));
  });
});

describe('fnv32a and SafeEncodeString', () => {
  it('fnv32a of known inputs (Go src/hash/fnv/fnv_test.go golden32a)', () => {
    expect(fnv32a([])).toBe(0x811c9dc5);
    expect(fnv32a([0x61])).toBe(0xe40c292c);
    expect(fnv32a([0x61, 0x62])).toBe(0x4d2505ca);
    expect(fnv32a([0x61, 0x62, 0x63])).toBe(0x1a47e90b);
  });
  it('maps each digit into the name alphabet', () => {
    // '0' is 48 and 48 % 27 = 21, the alphabet's '4'; '6' is 54 and 54 % 27 = 0, its 'b'
    expect(safeEncodeString('0123456789')).toBe('456789bcdf');
  });
});

describe('spew formatting', () => {
  const s = (v: string): GoValue => ({ k: 'string', t: 'string', v });
  const nilPtr: GoValue = { k: 'ptr', t: '*int64', elem: null };
  it('prints types, nil pointers and sorted maps as %#v does', () => {
    const v: GoValue = {
      k: 'struct',
      t: 'x.T',
      fields: [
        ['A', s('raw text')],
        ['P', nilPtr],
        ['Q', { k: 'ptr', t: '*int64', elem: { k: 'int', t: 'int64', v: 5n } }],
        ['M', { k: 'map', t: 'map[string]string', entries: [[s('b'), s('2')], [s('B'), s('1')], [s('a'), s('3')]] }],
        ['S', { k: 'slice', t: '[]string', elems: [s('x'), s('y')] }],
        ['N', { k: 'slice', t: '[]string', elems: null }],
      ],
    };
    expect(forHash(v)).toBe('(x.T){A:(string)raw text P:(*int64)<nil> Q:(*int64)5 M:(map[string]string)map[B:1 a:3 b:2] S:([]string)[x y] N:([]string)<nil>}');
  });
  it('keeps ignoreNextType set after a nil pointer element, as upstream does', () => {
    const v: GoValue = {
      k: 'struct',
      t: 'x.T',
      fields: [
        ['L', { k: 'slice', t: '[]*int64', elems: [{ k: 'ptr', t: '*int64', elem: { k: 'int', t: 'int64', v: 1n } }, nilPtr] }],
        ['After', s('v')],
      ],
    };
    expect(forHash(v)).toBe('(x.T){L:([]*int64)[<*>1 <nil>] After:v}');
  });
});
