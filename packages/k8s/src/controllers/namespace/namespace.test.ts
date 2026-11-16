// The namespace controller in virtual time, against the golden controllers/namespace-deletion
// fixture: content deleted, conditions while a finalizer holds content, the finalize subresource.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { createClient } from '../../client/client.ts';
import type { JsonObject } from '../../apimachinery/json.ts';
import type { ApiResponse } from '../../apiserver/types.ts';
import { fakeKubeletPlugin, startFakeKubelet } from '../../testing/kubelet.ts';
import { startController } from '../runtime.ts';

const registry = createRegistry([hostPlugin, k8sPlugin, fakeKubeletPlugin]);

function boot(traces?: TraceRecord[]): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ...(traces ? { ports: { trace: (r: TraceRecord) => traces.push(r) } } : {}) });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  k.act('start', (ctx) => startController(ctx, 'kube-controller-manager', 'namespace', DEFAULT_APISERVER));
  return k;
}

const req = (k: Kernel, fn: (c: ReturnType<typeof createClient>) => ApiResponse): ApiResponse => k.act('request', (ctx) => fn(createClient(ctx, DEFAULT_APISERVER)));
const obj = (r: ApiResponse): JsonObject | undefined => (r.ok ? (r.object as JsonObject) : undefined);
const meta = (o: JsonObject | undefined): JsonObject => (o?.metadata ?? {}) as JsonObject;
const getNs = (k: Kernel, name: string) => obj(req(k, (c) => c.resource('v1/namespaces').get(undefined, name)));
const createNs = (k: Kernel, name: string) => req(k, (c) => c.resource('v1/namespaces').create(undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name } }));
const createCm = (k: Kernel, ns: string, name: string, more: JsonObject = {}) =>
  req(k, (c) => c.resource('v1/configmaps').create(ns, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, ...more }, data: { a: '1' } }));

describe('namespace controller', () => {
  test('deleting a namespace removes its content, then the namespace', () => {
    const k = boot();
    createNs(k, 'gone');
    createCm(k, 'gone', 'one');
    req(k, (c) => c.resource('v1/secrets').create('gone', { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' } }));
    req(k, (c) => c.resource('v1/namespaces').delete(undefined, 'gone'));
    expect((getNs(k, 'gone')?.status as JsonObject).phase).toBe('Terminating');
    // Queued 5 s after the delete (namespaceDeletionGracePeriod).
    k.advance(4900);
    expect(obj(req(k, (c) => c.resource('v1/configmaps').get('gone', 'one')))).toBeDefined();
    k.advance(200);
    expect(req(k, (c) => c.resource('v1/configmaps').get('gone', 'one')).code).toBe(404);
    expect(req(k, (c) => c.resource('v1/secrets').get('gone', 's')).code).toBe(404);
    expect(getNs(k, 'gone')).toBeUndefined();
  });

  test('content held by a finalizer keeps the namespace Terminating with the golden conditions', () => {
    const traces: TraceRecord[] = [];
    const k = boot(traces);
    createNs(k, 'held');
    createCm(k, 'held', 'pinned', { finalizers: ['example.com/hold'] });
    req(k, (c) => c.resource('v1/namespaces').delete(undefined, 'held'));
    k.advance(6000);
    const ns = getNs(k, 'held') as JsonObject;
    expect(ns.spec).toEqual({ finalizers: ['kubernetes'] });
    const status = ns.status as JsonObject;
    expect(status.phase).toBe('Terminating');
    const conds = (status.conditions as JsonObject[]).map(({ lastTransitionTime, ...c }) => {
      expect(typeof lastTransitionTime).toBe('string');
      return c;
    });
    // fixtures/golden/v1.37.2/controllers/namespace-deletion.yaml, in order.
    expect(conds).toEqual([
      { type: 'NamespaceDeletionDiscoveryFailure', status: 'False', reason: 'ResourcesDiscovered', message: 'All resources successfully discovered' },
      { type: 'NamespaceDeletionGroupVersionParsingFailure', status: 'False', reason: 'ParsedGroupVersions', message: 'All legacy kube types successfully parsed' },
      { type: 'NamespaceDeletionContentFailure', status: 'False', reason: 'ContentDeleted', message: 'All content successfully deleted, may be waiting on finalization' },
      { type: 'NamespaceContentRemaining', status: 'True', reason: 'SomeResourcesRemain', message: 'Some resources are remaining: configmaps. has 1 resource instances' },
      { type: 'NamespaceFinalizersRemaining', status: 'True', reason: 'SomeFinalizersRemain', message: 'Some content in the namespace has finalizers remaining: example.com/hold in 1 resource instances' },
    ]);
    const pinned = meta(obj(req(k, (c) => c.resource('v1/configmaps').get('held', 'pinned'))));
    expect(pinned.deletionTimestamp).toBeDefined();
    expect(pinned.deletionGracePeriodSeconds).toBe(0);
    expect(pinned.finalizers).toEqual(['example.com/hold']);
    // The API server refuses new content (NamespaceLifecycle), as in the fixture.
    const late = createCm(k, 'held', 'late');
    expect(!late.ok && 'status' in late && late.status.message).toBe('configmaps "late" is forbidden: unable to create new content in namespace held because it is being terminated');
    // Content with finalizers requeues after finalizerEstimateSeconds/2 + 1 = 8 s.
    expect(traces.some((t) => t.kind === 'namespace.content-remaining' && t.message === 'some content remains in the namespace, estimate 15 seconds before it is removed')).toBe(true);
    req(k, (c) => c.resource('v1/configmaps').patch('held', 'pinned', { metadata: { finalizers: null } }));
    k.advance(7000);
    expect(getNs(k, 'held')).toBeUndefined();
    // The kubernetes finalizer went through namespaces/finalize.
    expect(traces.some((t) => t.kind === 'controller.write' && t.message === 'update namespaces/finalize held')).toBe(true);
  });

  test('Pods go first; the namespace waits for their graceful termination estimate', () => {
    const k = boot();
    // The kubelet takes the whole grace period (30 s) to stop the Pod.
    k.act('kubelet', (ctx) => startFakeKubelet(ctx, DEFAULT_APISERVER, { terminateAfter: 60_000 }));
    createNs(k, 'apps');
    req(k, (c) => c.resource('v1/pods').create('apps', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: 'nginx' }] } }));
    createCm(k, 'apps', 'cfg');
    k.advance(3000);
    req(k, (c) => c.resource('v1/namespaces').delete(undefined, 'apps'));
    // t=5 s: the Pod is deleted (gone at 35 s); the ConfigMap waits for the Pods.
    k.advance(5100);
    expect(meta(obj(req(k, (c) => c.resource('v1/pods').get('apps', 'p')))).deletionTimestamp).toBeDefined();
    expect(obj(req(k, (c) => c.resource('v1/configmaps').get('apps', 'cfg')))).toBeDefined();
    const conds = ((getNs(k, 'apps')?.status as JsonObject).conditions as JsonObject[]).map((c) => `${c.type as string}=${c.status as string}`);
    // On the Pods path upstream updates the conditions without the content totals.
    expect(conds).toContain('NamespaceContentRemaining=False');
    // The status update requeues it at 10 s (5 s after the update); then the estimate of 30 s
    // requeues after 30/2 + 1 = 16 s: 26 s, 42 s. The Pod is gone at 35 s; the rest goes at 42 s.
    k.advance(41_000 - 5100);
    expect(req(k, (c) => c.resource('v1/pods').get('apps', 'p')).code).toBe(404);
    expect(obj(req(k, (c) => c.resource('v1/configmaps').get('apps', 'cfg')))).toBeDefined();
    k.advance(1100);
    expect(getNs(k, 'apps')).toBeUndefined();
  });

  test('the system namespaces cannot be deleted (API server, NamespaceLifecycle)', () => {
    const k = boot();
    for (const name of ['default', 'kube-system']) {
      const r = req(k, (c) => c.resource('v1/namespaces').delete(undefined, name));
      expect(r.code).toBe(403);
      expect(!r.ok && 'status' in r && r.status.message).toBe(`namespaces "${name}" is forbidden: this namespace may not be deleted`);
    }
  });

  test('namespaces/finalize: only the finalizers change; the last one removes a terminating namespace', () => {
    const k = boot();
    createNs(k, 'f');
    const ns = getNs(k, 'f') as JsonObject;
    // Not terminating: the finalizer goes, the namespace stays, and status is kept.
    const body = { ...ns, spec: { finalizers: [] }, status: { phase: 'Terminating' } };
    const r = req(k, (c) => c.request({ verb: 'update', group: '', version: 'v1', resource: 'namespaces', subresource: 'finalize', name: 'f', body }));
    expect(r.ok).toBe(true);
    const after = getNs(k, 'f') as JsonObject;
    expect(after.spec).toEqual({});
    expect((after.status as JsonObject).phase).toBe('Active');
    // A bad finalizer name: indexed path, as ValidateNamespaceFinalizeUpdate reports it.
    const bad = req(k, (c) => c.request({ verb: 'update', group: '', version: 'v1', resource: 'namespaces', subresource: 'finalize', name: 'f', body: { ...after, spec: { finalizers: ['bogus'] } } }));
    expect(!bad.ok && 'status' in bad && bad.status.message).toBe(
      'Namespace "f" is invalid: spec.finalizers[0]: Invalid value: "bogus": name is neither a standard finalizer name nor is it fully qualified',
    );
    // Patch is not a verb of the subresource.
    const patch = req(k, (c) => c.resource('v1/namespaces').patch(undefined, 'f', { spec: {} }, { subresource: 'finalize' }));
    expect(patch.code).toBe(405);
  });
});
