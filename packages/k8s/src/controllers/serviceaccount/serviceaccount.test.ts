// The ServiceAccount controller in virtual time: `default` in every active namespace, as the
// golden controllers/namespace-deletion fixture shows for a fresh namespace.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer, SYSTEM_NAMESPACES } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { createClient } from '../../client/client.ts';
import type { JsonObject } from '../../apimachinery/json.ts';
import type { ApiResponse } from '../../apiserver/types.ts';
import { startController } from '../runtime.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  k.act('start', (ctx) => startController(ctx, 'kube-controller-manager', 'serviceaccount', DEFAULT_APISERVER));
  return k;
}

const req = (k: Kernel, fn: (c: ReturnType<typeof createClient>) => ApiResponse): ApiResponse => k.act('request', (ctx) => fn(createClient(ctx, DEFAULT_APISERVER)));
const getSa = (k: Kernel, ns: string) => {
  const r = req(k, (c) => c.resource('v1/serviceaccounts').get(ns, 'default'));
  return r.ok ? (r.object as JsonObject) : undefined;
};

describe('serviceaccount controller', () => {
  test('the system namespaces get `default` when the controller starts', () => {
    const k = boot();
    k.advance(10);
    for (const ns of SYSTEM_NAMESPACES) expect(getSa(k, ns)).toBeDefined();
  });

  test('a new namespace gets exactly the object upstream creates; a deleted one comes back', () => {
    const k = boot();
    req(k, (c) => c.resource('v1/namespaces').create(undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'fresh' } }));
    k.advance(10);
    const sa = getSa(k, 'fresh') as JsonObject;
    // fixtures/golden/v1.37.2/controllers/namespace-deletion.yaml: metadata only.
    expect(Object.keys(sa).sort()).toEqual(['apiVersion', 'kind', 'metadata']);
    expect(Object.keys(sa.metadata as JsonObject).sort()).toEqual(['creationTimestamp', 'name', 'namespace', 'resourceVersion', 'uid']);
    const uid = (sa.metadata as JsonObject).uid;
    req(k, (c) => c.resource('v1/serviceaccounts').delete('fresh', 'default'));
    expect(getSa(k, 'fresh')).toBeUndefined();
    k.advance(10);
    const again = getSa(k, 'fresh') as JsonObject;
    expect(again).toBeDefined();
    expect((again.metadata as JsonObject).uid).not.toBe(uid);
  });

  test('a terminating namespace does not get one', () => {
    const k = boot();
    req(k, (c) => c.resource('v1/namespaces').create(undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'ending' } }));
    k.advance(10);
    // No namespace controller runs: the namespace stays Terminating.
    req(k, (c) => c.resource('v1/namespaces').delete(undefined, 'ending'));
    req(k, (c) => c.resource('v1/serviceaccounts').delete('ending', 'default'));
    k.advance(100);
    expect(getSa(k, 'ending')).toBeUndefined();
  });
});
