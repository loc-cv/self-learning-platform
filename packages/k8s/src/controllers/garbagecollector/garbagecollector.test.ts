// The garbage collector in virtual time, with owners and dependents built by hand from ConfigMaps,
// Secrets and Pods: background cascade, orphaning, foreground deletion, several owners, dangling
// references, UID mismatches and owners in another namespace.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { createClient } from '../../client/client.ts';
import type { JsonObject } from '../../apimachinery/json.ts';
import type { RequestOptions } from '../../apiserver/types.ts';
import { startController } from '../runtime.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(traces?: TraceRecord[]): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ...(traces ? { ports: { trace: (r: TraceRecord) => traces.push(r) } } : {}) });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  k.act('start', (ctx) => startController(ctx, 'kube-controller-manager', 'garbage-collector', DEFAULT_APISERVER));
  return k;
}

const api = (k: Kernel, resource: string) => ({
  create: (body: JsonObject, ns = 'default') => {
    const r = k.act('create', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).create(ns, body));
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.object as JsonObject;
  },
  get: (name: string, ns = 'default') => {
    const r = k.act('get', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).get(ns, name));
    return r.ok ? (r.object as JsonObject) : undefined;
  },
  del: (name: string, options?: RequestOptions, ns = 'default') => k.act('delete', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).delete(ns, name, options)),
  patch: (name: string, patch: JsonObject, ns = 'default') => k.act('patch', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).patch(ns, name, patch)),
});

const meta = (o: JsonObject | undefined): JsonObject => (o?.metadata ?? {}) as JsonObject;

interface Ref {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  blockOwnerDeletion?: boolean;
}

function refTo(o: JsonObject, extra: { blockOwnerDeletion?: boolean; controller?: boolean } = {}): Ref {
  return { apiVersion: o.apiVersion as string, kind: o.kind as string, name: meta(o).name as string, uid: meta(o).uid as string, ...extra };
}

const cm = (name: string, owners: Ref[] = [], more: JsonObject = {}): JsonObject => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name, ...(owners.length ? { ownerReferences: owners as unknown as JsonObject[] } : {}), ...more },
});
const secret = (name: string, owners: Ref[] = [], more: JsonObject = {}): JsonObject => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name, ...(owners.length ? { ownerReferences: owners as unknown as JsonObject[] } : {}), ...more },
});
const pod = (name: string, owners: Ref[] = [], more: JsonObject = {}): JsonObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name, ...(owners.length ? { ownerReferences: owners as unknown as JsonObject[] } : {}), ...more },
  spec: { containers: [{ name: 'c', image: 'nginx' }] },
});

describe('garbage collector', () => {
  test('background cascade: deleting an owner removes its dependents, transitively', () => {
    const k = boot();
    const cms = api(k, 'v1/configmaps');
    const secrets = api(k, 'v1/secrets');
    const a = cms.create(cm('a'));
    const b = secrets.create(secret('b', [refTo(a)]));
    cms.create(cm('c', [refTo(b)]));
    cms.create(cm('bystander'));
    k.advance(100);
    expect(secrets.get('b')).toBeDefined();
    cms.del('a');
    k.advance(100);
    expect(secrets.get('b')).toBeUndefined();
    expect(cms.get('c')).toBeUndefined();
    expect(cms.get('bystander')).toBeDefined();
  });

  test('orphan: dependents lose the reference and survive; the owner goes', () => {
    const k = boot();
    const cms = api(k, 'v1/configmaps');
    const owner = cms.create(cm('owner'));
    const other = cms.create(cm('other'));
    cms.create(cm('only', [refTo(owner, { controller: true, blockOwnerDeletion: true })]));
    cms.create(cm('both', [refTo(owner), refTo(other)]));
    k.advance(100);
    cms.del('owner', { propagationPolicy: 'Orphan' });
    expect(meta(cms.get('owner')).finalizers).toEqual(['orphan']);
    k.advance(100);
    expect(cms.get('owner')).toBeUndefined();
    // The ownerReferences key goes entirely when the last reference goes (as in the golden
    // controllers/gc-orphan-foreground fixture).
    const only = cms.get('only');
    expect(only).toBeDefined();
    expect('ownerReferences' in meta(only)).toBe(false);
    expect(meta(cms.get('both')).ownerReferences).toEqual([refTo(other)]);
  });

  test('foreground: the owner waits with foregroundDeletion until blocking dependents are gone', () => {
    const k = boot();
    const cms = api(k, 'v1/configmaps');
    const secrets = api(k, 'v1/secrets');
    const owner = cms.create(cm('owner'));
    // owner ← middle (blocking) ← leaf (blocking, held by a finalizer); owner ← loose (not blocking).
    const middle = secrets.create(secret('middle', [refTo(owner, { controller: true, blockOwnerDeletion: true })]));
    cms.create(cm('leaf', [refTo(middle, { controller: true, blockOwnerDeletion: true })], { finalizers: ['example.com/hold'] }));
    cms.create(cm('loose', [refTo(owner)]));
    k.advance(100);
    cms.del('owner', { propagationPolicy: 'Foreground' });
    k.advance(1000);
    const o = meta(cms.get('owner'));
    expect(o.deletionTimestamp).toBeDefined();
    expect(o.finalizers).toEqual(['foregroundDeletion']);
    // The middle object has dependents and an owner waiting for them: deleted in Foreground too.
    const m = meta(secrets.get('middle'));
    expect(m.deletionTimestamp).toBeDefined();
    expect(m.deletionGracePeriodSeconds).toBe(0);
    expect(m.finalizers).toEqual(['foregroundDeletion']);
    const leaf = meta(cms.get('leaf'));
    expect(leaf.deletionTimestamp).toBeDefined();
    expect(leaf.finalizers).toEqual(['example.com/hold']);
    // A non-blocking dependent does not hold the owner, but is deleted with it.
    expect(cms.get('loose')).toBeUndefined();
    // Release the leaf: leaf, then middle, then owner.
    cms.patch('leaf', { metadata: { finalizers: null } });
    k.advance(100);
    expect(cms.get('leaf')).toBeUndefined();
    expect(secrets.get('middle')).toBeUndefined();
    expect(cms.get('owner')).toBeUndefined();
  });

  test('a dependent with two owners keeps the one still there', () => {
    const k = boot();
    const cms = api(k, 'v1/configmaps');
    const a = cms.create(cm('a'));
    const b = cms.create(cm('b'));
    cms.create(cm('dep', [refTo(a), refTo(b)]));
    k.advance(100);
    cms.del('a');
    k.advance(100);
    expect(meta(cms.get('dep')).ownerReferences).toEqual([refTo(b)]);
    cms.del('b');
    k.advance(100);
    expect(cms.get('dep')).toBeUndefined();
  });

  test('a reference to an owner that is already gone is collected', () => {
    const k = boot();
    const cms = api(k, 'v1/configmaps');
    const gone = cms.create(cm('gone'));
    cms.del('gone');
    k.advance(100);
    cms.create(cm('late', [refTo(gone)]));
    k.advance(100);
    expect(cms.get('late')).toBeUndefined();
  });

  test('an owner present under the name with another UID counts as absent', () => {
    const traces: TraceRecord[] = [];
    const k = boot(traces);
    const cms = api(k, 'v1/configmaps');
    const owner = cms.create(cm('owner'));
    cms.create(cm('dep', [{ ...refTo(owner), uid: '00000000-0000-0000-0000-000000000000' }]));
    k.advance(100);
    expect(cms.get('dep')).toBeUndefined();
    expect(cms.get('owner')).toBeDefined();
    const del = traces.find((t) => t.kind === 'controller.write' && t.message === 'delete configmaps default/dep');
    expect(del).toBeDefined();
  });

  test('an owner in another namespace: OwnerRefInvalidNamespace, and the dependent is collected', () => {
    const k = boot();
    k.act('ns', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/namespaces').create(undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'other' } }));
    const cms = api(k, 'v1/configmaps');
    const owner = cms.create(cm('owner'));
    const dep = cms.create(cm('dep', [refTo(owner)]), 'other');
    k.advance(100);
    expect(cms.get('dep', 'other')).toBeUndefined();
    expect(cms.get('owner')).toBeDefined();
    const events = k.act('events', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/events').list('other'));
    const items = ((events.ok ? (events.object as JsonObject).items : []) as JsonObject[]).filter((e) => e.reason === 'OwnerRefInvalidNamespace');
    expect(items).toHaveLength(1);
    const e = items[0] as JsonObject;
    expect(e.type).toBe('Warning');
    expect(e.message).toBe(`ownerRef [v1/ConfigMap, namespace: other, name: owner, uid: ${meta(owner).uid as string}] does not exist in namespace "other"`);
    expect(e.involvedObject).toEqual({ kind: 'ConfigMap', namespace: 'other', name: 'dep', uid: meta(dep).uid, apiVersion: 'v1' });
    expect(e.source).toEqual({ component: 'garbage-collector-controller' });
  });

  test('a Pod held by a finalizer keeps a foreground owner, as in the golden fixture', () => {
    const k = boot();
    const cms = api(k, 'v1/configmaps');
    const pods = api(k, 'v1/pods');
    const owner = cms.create(cm('owner'));
    pods.create(pod('p', [refTo(owner, { controller: true, blockOwnerDeletion: true })], { finalizers: ['example.com/hold'] }));
    k.advance(100);
    cms.del('owner', { propagationPolicy: 'Foreground' });
    k.advance(1000);
    expect(meta(cms.get('owner')).finalizers).toEqual(['foregroundDeletion']);
    expect(meta(pods.get('p')).deletionTimestamp).toBeDefined();
    pods.patch('p', { metadata: { finalizers: null } });
    k.advance(100);
    expect(pods.get('p')).toBeUndefined();
    expect(cms.get('owner')).toBeUndefined();
  });

  test('Deployment and ReplicaSet objects as in the golden gc-orphan-foreground fixture', () => {
    const k = boot();
    const deployments = api(k, 'apps/v1/deployments');
    const replicasets = api(k, 'apps/v1/replicasets');
    const pods = api(k, 'v1/pods');
    const labels = { app: 'fg' };
    const template = { metadata: { labels }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } };
    const mk = (kind: string, name: string, owners: Ref[] = []): JsonObject => ({
      apiVersion: 'apps/v1',
      kind,
      metadata: { name, labels, ...(owners.length ? { ownerReferences: owners as unknown as JsonObject[] } : {}) },
      spec: { replicas: 1, selector: { matchLabels: labels }, template },
    });
    // Orphan: the ReplicaSet loses its ownerReferences key; its generation stays 1.
    const keep = deployments.create(mk('Deployment', 'keep'));
    replicasets.create(mk('ReplicaSet', 'keep-1', [refTo(keep, { controller: true, blockOwnerDeletion: true })]));
    k.advance(100);
    deployments.del('keep', { propagationPolicy: 'Orphan' });
    k.advance(100);
    expect(deployments.get('keep')).toBeUndefined();
    const rs = meta(replicasets.get('keep-1'));
    expect('ownerReferences' in rs).toBe(false);
    expect(rs.generation).toBe(1);
    // Foreground, held by a finalizer on the only Pod: both get deletionTimestamp,
    // deletionGracePeriodSeconds 0, finalizers [foregroundDeletion] and generation 2.
    const fg = deployments.create(mk('Deployment', 'fg'));
    const fgRs = replicasets.create(mk('ReplicaSet', 'fg-1', [refTo(fg, { controller: true, blockOwnerDeletion: true })]));
    pods.create(pod('fg-1-a', [refTo(fgRs, { controller: true, blockOwnerDeletion: true })], { labels, finalizers: ['example.com/hold'] }));
    k.advance(100);
    deployments.del('fg', { propagationPolicy: 'Foreground' });
    k.advance(1000);
    for (const o of [meta(deployments.get('fg')), meta(replicasets.get('fg-1'))]) {
      expect(o.deletionTimestamp).toBeDefined();
      expect(o.deletionGracePeriodSeconds).toBe(0);
      expect(o.finalizers).toEqual(['foregroundDeletion']);
      expect(o.generation).toBe(2);
    }
    pods.patch('fg-1-a', { metadata: { finalizers: null } });
    k.advance(100);
    expect(replicasets.get('fg-1')).toBeUndefined();
    expect(deployments.get('fg')).toBeUndefined();
  });

  test('same seed, same world', () => {
    const run = () => {
      const k = boot();
      const cms = api(k, 'v1/configmaps');
      const a = cms.create(cm('a'));
      for (const n of ['x', 'y', 'z']) cms.create(cm(n, [refTo(a, { blockOwnerDeletion: true })]));
      cms.del('a', { propagationPolicy: 'Foreground' });
      k.advance(1000);
      return k.hash();
    };
    expect(run()).toBe(run());
  });
});
