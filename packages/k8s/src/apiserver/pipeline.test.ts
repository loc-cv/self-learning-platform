// The request pipeline and the store with the kinds of this file's scope (ConfigMap, Namespace):
// optimistic concurrency, finalizers holding deletion, propagation finalizers, selectors, watch
// order and replay, dry run, and determinism of the world.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, restore, snapshot, type Ctx, type Kernel, type Plugin } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from './bootstrap.ts';
import { DEFAULT_APISERVER } from './config.ts';
import { handle, openWatch, watchEvents } from './pipeline.ts';
import type { ApiRequest, ApiResponse } from './types.ts';
import type { JsonObject } from '../apimachinery/json.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(seed = 1): Kernel {
  const k = bootKernel(registry, { seed, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

const cm = (name: string, extra: JsonObject = {}): JsonObject => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, ...((extra.metadata as JsonObject) ?? {}) }, ...(extra.data ? { data: extra.data } : {}) });

function req(k: Kernel, r: Partial<ApiRequest> & Pick<ApiRequest, 'verb'>): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { group: '', version: 'v1', resource: 'configmaps', namespace: 'default', ...r }));
}

const obj = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};
const meta = (o: JsonObject): JsonObject => o.metadata as JsonObject;
const message = (r: ApiResponse): string => (!r.ok && 'status' in r ? (r.status.message as string) : `ok ${r.code}`);

describe('optimistic concurrency', () => {
  test('an update with a stale resourceVersion is a Conflict; the current one succeeds and bumps it', () => {
    const k = boot();
    const created = obj(req(k, { verb: 'create', body: cm('a', { data: { k: '1' } }) }));
    const rv = meta(created).resourceVersion as string;
    const first = obj(req(k, { verb: 'update', name: 'a', body: { ...cm('a', { data: { k: '2' } }), metadata: { name: 'a', resourceVersion: rv } } }));
    expect(Number(meta(first).resourceVersion)).toBeGreaterThan(Number(rv));
    const stale = req(k, { verb: 'update', name: 'a', body: { ...cm('a', { data: { k: '3' } }), metadata: { name: 'a', resourceVersion: rv } } });
    expect(stale.code).toBe(409);
    expect(message(stale)).toBe('Operation cannot be fulfilled on configmaps "a": the object has been modified; please apply your changes to the latest version and try again');
  });

  test('an update that changes nothing writes nothing: same resourceVersion, no watch event', () => {
    const k = boot();
    const created = obj(req(k, { verb: 'create', body: cm('a', { data: { k: '1' } }) }));
    const w = k.act('w', (ctx) => openWatch(ctx, DEFAULT_APISERVER, { verb: 'watch', group: '', version: 'v1', resource: 'configmaps', namespace: 'default', options: { resourceVersion: meta(created).resourceVersion as string } }, 'test'));
    if (!('ok' in w)) throw new Error('watch');
    const again = obj(req(k, { verb: 'update', name: 'a', body: cm('a', { data: { k: '1' } }) }));
    expect(meta(again).resourceVersion).toBe(meta(created).resourceVersion);
    expect(k.act('take', (ctx) => watchEvents(ctx, DEFAULT_APISERVER, w.ok.id))).toEqual([]);
  });
});

describe('deletion', () => {
  test('a finalizer holds the object; removing it completes the deletion', () => {
    const k = boot();
    req(k, { verb: 'create', body: cm('held', { metadata: { finalizers: ['example.com/hold'] } }) });
    const deleting = obj(req(k, { verb: 'delete', name: 'held' }));
    expect(meta(deleting).deletionTimestamp).toBe('2026-11-13T09:00:00Z');
    expect(meta(deleting).deletionGracePeriodSeconds).toBe(0);
    expect(req(k, { verb: 'get', name: 'held' }).code).toBe(200);
    // A second delete changes nothing.
    expect(meta(obj(req(k, { verb: 'delete', name: 'held' }))).resourceVersion).toBe(meta(deleting).resourceVersion);
    const added = req(k, { verb: 'patch', name: 'held', body: { metadata: { finalizers: ['example.com/hold', 'example.com/more'] } } });
    expect(message(added)).toBe('ConfigMap "held" is invalid: metadata.finalizers: Forbidden: no new finalizers can be added if the object is being deleted, found new finalizers []string{"example.com/more"}');
    expect(req(k, { verb: 'patch', name: 'held', body: { metadata: { finalizers: null } } }).code).toBe(200);
    expect(message(req(k, { verb: 'get', name: 'held' }))).toBe('configmaps "held" not found');
  });

  test('propagation policies add the garbage collector finalizers', () => {
    const k = boot();
    req(k, { verb: 'create', body: cm('fg') });
    expect(meta(obj(req(k, { verb: 'delete', name: 'fg', options: { propagationPolicy: 'Foreground' } }))).finalizers).toEqual(['foregroundDeletion']);
    req(k, { verb: 'create', body: cm('or') });
    expect(meta(obj(req(k, { verb: 'delete', name: 'or', options: { propagationPolicy: 'Orphan' } }))).finalizers).toEqual(['orphan']);
    req(k, { verb: 'create', body: cm('bg') });
    const done = obj(req(k, { verb: 'delete', name: 'bg', options: { propagationPolicy: 'Background' } }));
    expect(done).toMatchObject({ kind: 'Status', status: 'Success', details: { name: 'bg', kind: 'configmaps' } });
  });

  test('a namespace being deleted refuses new content and keeps its kubernetes finalizer', () => {
    const k = boot();
    const ns = (r: Partial<ApiRequest> & Pick<ApiRequest, 'verb'>) => k.act('t', (ctx) => handle(ctx, DEFAULT_APISERVER, { group: '', version: 'v1', resource: 'namespaces', ...r }));
    ns({ verb: 'create', body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'doomed' } } });
    const deleting = obj(ns({ verb: 'delete', name: 'doomed' }));
    expect(deleting.status).toEqual({ phase: 'Terminating' });
    expect(deleting.spec).toEqual({ finalizers: ['kubernetes'] });
    const late = req(k, { verb: 'create', namespace: 'doomed', body: cm('late') });
    expect(late.code).toBe(403);
    expect(message(req(k, { verb: 'create', namespace: 'nowhere', body: cm('x') }))).toBe('namespaces "nowhere" not found');
    expect(message(ns({ verb: 'delete', name: 'kube-system' }))).toBe('namespaces "kube-system" is forbidden: this namespace may not be deleted');
  });
});

describe('selectors', () => {
  test('label and field selectors filter lists; bad selectors are BadRequest', () => {
    const k = boot();
    req(k, { verb: 'create', body: cm('a', { metadata: { labels: { app: 'web', tier: 'fe' } } }) });
    req(k, { verb: 'create', body: cm('b', { metadata: { labels: { app: 'db' } } }) });
    req(k, { verb: 'create', body: cm('c') });
    const names = (r: ApiResponse) => (obj(r).items as JsonObject[]).map((i) => meta(i).name);
    expect(names(req(k, { verb: 'list', options: { labelSelector: 'app' } }))).toEqual(['a', 'b']);
    expect(names(req(k, { verb: 'list', options: { labelSelector: '!app' } }))).toEqual(['c']);
    expect(names(req(k, { verb: 'list', options: { labelSelector: 'app notin (db)' } }))).toEqual(['a', 'c']);
    expect(names(req(k, { verb: 'list', options: { labelSelector: 'app in (web,db),tier!=fe' } }))).toEqual(['b']);
    expect(names(req(k, { verb: 'list', options: { fieldSelector: 'metadata.name!=a' } }))).toEqual(['b', 'c']);
    expect(message(req(k, { verb: 'list', options: { fieldSelector: 'data.x=1' } }))).toBe('"data.x" is not a known field selector: only "metadata.name", "metadata.namespace"');
    expect(req(k, { verb: 'list', options: { labelSelector: 'a==b==c' } }).code).toBe(400);
  });

  test('a list spans namespaces in key order when no namespace is given', () => {
    const k = boot();
    req(k, { verb: 'create', namespace: 'kube-system', body: cm('z') });
    req(k, { verb: 'create', namespace: 'default', body: cm('y') });
    const all = obj(req(k, { verb: 'list', namespace: undefined as unknown as string }));
    expect((all.items as JsonObject[]).map((i) => `${meta(i).namespace as string}/${meta(i).name as string}`)).toEqual(['default/y', 'kube-system/z']);
  });
});

describe('watch', () => {
  const watch = (k: Kernel, options: ApiRequest['options'] = {}) => {
    const w = k.act('w', (ctx) => openWatch(ctx, DEFAULT_APISERVER, { verb: 'watch', group: '', version: 'v1', resource: 'configmaps', namespace: 'default', options }, 'test'));
    if (!('ok' in w)) throw new Error(JSON.stringify(w));
    return w.ok.id;
  };
  const take = (k: Kernel, id: string) => k.act('take', (ctx) => watchEvents(ctx, DEFAULT_APISERVER, id)).map((e) => `${e.type} ${meta(e.object).name as string}`);

  test('events arrive in write order; a watch from now starts with ADDED for what exists', () => {
    const k = boot();
    req(k, { verb: 'create', body: cm('b') });
    req(k, { verb: 'create', body: cm('a') });
    const id = watch(k);
    req(k, { verb: 'update', name: 'b', body: cm('b', { data: { x: '1' } }) });
    req(k, { verb: 'create', body: cm('c') });
    req(k, { verb: 'delete', name: 'a' });
    expect(take(k, id)).toEqual(['ADDED a', 'ADDED b', 'MODIFIED b', 'ADDED c', 'DELETED a']);
    expect(take(k, id)).toEqual([]);
  });

  test('a selector watch sees an object enter and leave its set as ADDED and DELETED', () => {
    const k = boot();
    const id = watch(k, { labelSelector: 'app=web' });
    req(k, { verb: 'create', body: cm('x') });
    req(k, { verb: 'patch', name: 'x', body: { metadata: { labels: { app: 'web' } } } });
    req(k, { verb: 'patch', name: 'x', body: { data: { k: 'v' } } });
    req(k, { verb: 'patch', name: 'x', body: { metadata: { labels: { app: 'db' } } } });
    expect(take(k, id)).toEqual(['ADDED x', 'MODIFIED x', 'DELETED x']);
  });

  test('a watch from a past resourceVersion replays the changes after it; a revision the cache dropped is Expired', () => {
    const k = boot();
    const rv = meta(obj(req(k, { verb: 'create', body: cm('a') }))).resourceVersion as string;
    req(k, { verb: 'create', body: cm('b') });
    req(k, { verb: 'delete', name: 'a' });
    expect(take(k, watch(k, { resourceVersion: rv }))).toEqual(['ADDED b', 'DELETED a']);
    // Past the 75 s window and the 100 retained events, the oldest revisions are gone.
    for (let i = 0; i < 110; i++) {
      k.advance(1000);
      req(k, { verb: 'create', body: cm(`n${i}`) });
    }
    const expired = k.act('w', (ctx) => openWatch(ctx, DEFAULT_APISERVER, { verb: 'watch', group: '', version: 'v1', resource: 'configmaps', namespace: 'default', options: { resourceVersion: rv } }, 'test'));
    expect('status' in expired && expired.status.reason).toBe('Expired');
  });

  test('writes wake a waiting reader through the kernel queue; it reads every event queued meanwhile', () => {
    // A reader that counts its wake-ups in a world counter and waits again.
    const reader: Plugin = {
      name: 'test-reader',
      requires: ['k8s'],
      handlers: [{ type: 'test.wake', handle: (ctx, payload) => { ctx.nextId('test.woken'); ctx.subscribe(`k8s.watch:${payload as string}`, 'test.wake', payload); } }],
    };
    const k = bootKernel(createRegistry([hostPlugin, k8sPlugin, reader]), { seed: 1, startTime: DEFAULT_START_TIME });
    k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
    const id = watch(k);
    k.act('sub', (ctx) => ctx.subscribe(`k8s.watch:${id}`, 'test.wake', id));
    req(k, { verb: 'create', body: cm('a') });
    req(k, { verb: 'create', body: cm('b') });
    // Both writes happen before the reader runs: one wake-up (the waiter is consumed by the first publish).
    k.advance(0);
    expect(k.world.counters['test.woken']).toBe(1);
    expect(take(k, id)).toEqual(['ADDED a', 'ADDED b']);
  });
});

describe('determinism', () => {
  const script = (k: Kernel) => {
    req(k, { verb: 'create', body: cm('a', { data: { k: '1' } }) });
    req(k, { verb: 'create', body: cm('', { metadata: { generateName: 'gen-' } }) });
    req(k, { verb: 'patch', name: 'a', body: { data: { k: '2' } } });
    req(k, { verb: 'create', body: cm('held', { metadata: { finalizers: ['example.com/x'] } }) });
    req(k, { verb: 'delete', name: 'held' });
  };

  test('the same seed and requests give the same world hash; snapshot and restore keep it', () => {
    const a = boot(7);
    const b = boot(7);
    script(a);
    script(b);
    expect(a.hash()).toBe(b.hash());
    const restored = restore(snapshot(a.world, registry), registry);
    expect(restored.slices.k8s).toEqual(a.world.slices.k8s);
    // A fork continues independently of its parent.
    const f = a.fork();
    req(f, { verb: 'create', body: cm('only-in-fork') });
    expect(req(a, { verb: 'get', name: 'only-in-fork' }).code).toBe(404);
  });

  test('uids and generated names come from the seed', () => {
    const name = (seed: number) => {
      const k = boot(seed);
      return meta(obj(req(k, { verb: 'create', body: cm('', { metadata: { generateName: 'gen-' } }) }))).name;
    };
    expect(name(3)).toBe(name(3));
    expect(name(3)).toMatch(/^gen-[bcdfghjklmnpqrstvwxz2456789]{5}$/);
  });
});

describe('dry run', () => {
  test('dryRun=All validates and answers but stores nothing', () => {
    const k = boot();
    const rev = k.world.slices.k8s as { etcd: Record<string, { revision: number }> };
    const before = rev.etcd[DEFAULT_APISERVER.etcd]?.revision;
    const r = req(k, { verb: 'create', body: cm('dry'), options: { dryRun: true } });
    expect(r.code).toBe(201);
    expect(req(k, { verb: 'get', name: 'dry' }).code).toBe(404);
    expect(rev.etcd[DEFAULT_APISERVER.etcd]?.revision).toBe(before);
  });
});
