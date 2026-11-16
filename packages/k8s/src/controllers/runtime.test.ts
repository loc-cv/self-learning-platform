// The controller runtime: watch-fed queues, latency, deduplication, rate-limited retries, stop and
// start, traces with causes; and the fake kubelet that later tests rely on.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Contribution, type Kernel, type Plugin, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from '../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { createClient } from '../client/client.ts';
import type { JsonObject } from '../apimachinery/json.ts';
import { fakeKubeletPlugin, startFakeKubelet } from '../testing/kubelet.ts';
import { CONTROLLER, enqueue, startController, stopController } from './runtime.ts';
import type { ControllerSpec } from './types.ts';

/** A controller that counts its syncs per key in its data and fails keys named `bad-*`. */
const counter: ControllerSpec = {
  name: 'test-counter',
  component: 'kube-controller-manager',
  serviceAccount: 'test-counter',
  watches: [{ resource: 'v1/configmaps', keys: (ev) => [`${(ev.object.metadata as JsonObject).namespace as string}/${(ev.object.metadata as JsonObject).name as string}`] }],
  latency: 10,
  maxRetries: 3,
  sync(c, key) {
    const n = Number(c.data()[key] ?? 0) + 1;
    c.setData(key, n);
    c.setData('log', [...((c.data().log as string[] | undefined) ?? []), `${c.now - DEFAULT_START_TIME}:${key}`]);
    return key.includes('/bad-') ? { error: 'boom' } : { done: true };
  },
};

const testPlugin: Plugin = { name: 'test-controllers', requires: ['k8s'], contributions: { [CONTROLLER]: [counter as unknown as Contribution] } };
const registry = createRegistry([hostPlugin, k8sPlugin, fakeKubeletPlugin, testPlugin]);

function boot(seed = 1, traces?: TraceRecord[]): Kernel {
  const k = bootKernel(registry, { seed, startTime: DEFAULT_START_TIME, ...(traces ? { ports: { trace: (r: TraceRecord) => traces.push(r) } } : {}) });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

const cm = (name: string): JsonObject => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'default' } });
const create = (k: Kernel, body: JsonObject, resource = 'v1/configmaps') => k.act('test', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).create('default', body));
const data = (k: Kernel) => (k.world.slices.k8s as { controllers: Record<string, { data: Record<string, unknown> }> }).controllers['kcm/test-counter']?.data ?? {};

describe('work queue', () => {
  test('a start lists everything; watch events queue keys after the latency, deduplicated', () => {
    const k = boot();
    create(k, cm('a'));
    k.act('start', (ctx) => startController(ctx, 'kcm', 'test-counter', DEFAULT_APISERVER));
    k.advance(5);
    expect(data(k)['default/a']).toBeUndefined();
    k.advance(5);
    expect(data(k)['default/a']).toBe(1);
    // Two writes at the same instant: one sync.
    k.act('w', (ctx) => {
      const c = createClient(ctx, DEFAULT_APISERVER).resource('v1/configmaps');
      c.patch('default', 'a', { data: { x: '1' } });
      c.patch('default', 'a', { data: { x: '2' } });
    });
    k.advance(100);
    expect(data(k)['default/a']).toBe(2);
  });

  test('errors retry with 5 ms · 2^n backoff and the key is dropped after maxRetries', () => {
    const k = boot();
    k.act('start', (ctx) => startController(ctx, 'kcm', 'test-counter', DEFAULT_APISERVER));
    create(k, cm('bad-x'));
    k.advance(1000);
    // First sync at 10 ms, retries after 5, 10 and 20 ms, then dropped.
    expect(data(k).log).toEqual(['10:default/bad-x', '15:default/bad-x', '25:default/bad-x', '45:default/bad-x']);
  });

  test('a stopped controller does nothing and forgets its queue; a restart relists', () => {
    const k = boot();
    k.act('start', (ctx) => startController(ctx, 'kcm', 'test-counter', DEFAULT_APISERVER));
    create(k, cm('a'));
    k.act('stop', (ctx) => stopController(ctx, 'kcm', 'test-counter'));
    k.advance(100);
    expect((k.world.slices.k8s as { watches: object }).watches).toEqual({});
    create(k, cm('b'));
    k.act('start', (ctx) => startController(ctx, 'kcm', 'test-counter', DEFAULT_APISERVER));
    k.advance(100);
    expect(data(k).log).toEqual(['110:default/a', '110:default/b']);
  });

  test('an explicit enqueue keeps the earlier time of a key already queued', () => {
    const k = boot();
    k.act('start', (ctx) => startController(ctx, 'kcm', 'test-counter', DEFAULT_APISERVER));
    k.act('q', (ctx) => {
      enqueue(ctx, 'kcm/test-counter', 'default/z', 50, 'test');
      enqueue(ctx, 'kcm/test-counter', 'default/z', 20, 'test');
      enqueue(ctx, 'kcm/test-counter', 'default/z', 80, 'test');
    });
    k.advance(100);
    expect(data(k).log).toEqual(['20:default/z']);
  });

  test('every sync and write is traced with its cause', () => {
    const traces: TraceRecord[] = [];
    const k = boot(1, traces);
    k.act('start', (ctx) => startFakeKubelet(ctx, DEFAULT_APISERVER));
    create(k, { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: 'nginx' }] } }, 'v1/pods');
    k.advance(10);
    const sync = traces.find((t) => t.kind === 'controller.sync');
    expect(sync?.message).toBe('sync default/p, queued by ADDED v1/pods default/p');
    const write = traces.find((t) => t.kind === 'controller.write');
    expect(write?.message).toBe('create pods/binding default/p');
    expect(write?.causes).toEqual([sync?.id]);
  });
});

describe('fake kubelet', () => {
  test('binds, reports Running and Ready after readyAfter, and finishes a graceful deletion', () => {
    const k = boot();
    k.act('start', (ctx) => startFakeKubelet(ctx, DEFAULT_APISERVER));
    create(k, { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: 'nginx' }] } }, 'v1/pods');
    const get = () => k.act('get', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/pods').get('default', 'p'));
    k.advance(100);
    const bound = get();
    expect(bound.ok && ((bound.object as JsonObject).spec as JsonObject).nodeName).toBe('node01');
    k.advance(2000);
    const running = get();
    const status = (running.ok ? (running.object as JsonObject).status : {}) as JsonObject;
    expect(status.phase).toBe('Running');
    expect((status.conditions as JsonObject[]).find((c) => c.type === 'Ready')?.status).toBe('True');
    k.act('del', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/pods').delete('default', 'p'));
    expect(get().ok).toBe(true);
    k.advance(1100);
    expect(get().code).toBe(404);
  });

  test('same seed, same world hash', () => {
    const run = () => {
      const k = boot(7);
      k.act('start', (ctx) => startFakeKubelet(ctx, DEFAULT_APISERVER));
      for (const n of ['a', 'b', 'c']) create(k, { apiVersion: 'v1', kind: 'Pod', metadata: { name: n }, spec: { containers: [{ name: 'c', image: 'nginx' }] } }, 'v1/pods');
      k.advance(5000);
      return k.hash();
    };
    expect(run()).toBe(run());
  });
});
