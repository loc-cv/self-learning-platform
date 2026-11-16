// Simulation tests of kube-scheduler in virtual time on the kubeadm-1cp-2w topology. The exact
// messages against the real scheduler are in tools/src/golden/scheduling.test.ts.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { createClient } from '../client/client.ts';
import { k8sPlugin } from '../plugin.ts';
import { buildCluster } from '../topology/build.ts';
import { KUBEADM_1CP_2W } from '../topology/cluster.ts';
import { fitErrorMessage, selectHost } from './cycle.ts';
import { isSchedulerRunning, startScheduler, stopScheduler } from './scheduler.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(seed = 1, traces?: TraceRecord[]): Kernel {
  const k = bootKernel(registry, { seed, startTime: DEFAULT_START_TIME, ...(traces ? { ports: { trace: (r: TraceRecord) => traces.push(r) } } : {}) });
  k.act('topology', (ctx) => buildCluster(ctx, KUBEADM_1CP_2W));
  k.advance(5_000);
  return k;
}

const api = (k: Kernel, resource: string) => ({
  create: (body: JsonObject, ns = 'default') => {
    const r = k.act('create', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).create(ns, body));
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.object as JsonObject;
  },
  list: (ns: string | undefined = 'default') => {
    const r = k.act('list', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).list(ns));
    return (r.ok ? ((r.object as JsonObject).items ?? []) : []) as JsonObject[];
  },
  get: (name: string, ns: string | undefined = 'default') => {
    const r = k.act('get', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).get(ns, name));
    return r.ok ? (r.object as JsonObject) : undefined;
  },
});

const pod = (name: string, extra: JsonObject = {}): JsonObject => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec: { containers: [{ name: 'app', image: 'nginx:1.27' }], ...extra } });
const nodeOf = (p: JsonObject | undefined): string => String(((p?.spec ?? {}) as JsonObject).nodeName ?? '');
const schedulerEvents = (k: Kernel, name: string): JsonObject[] =>
  api(k, 'events.k8s.io/v1/events').list('default').filter((e) => (e.regarding as JsonObject).name === name && e.reportingController === 'default-scheduler');

describe('kube-scheduler', () => {
  test('with the scheduler stopped, a new Pod stays Pending with no events; a start schedules it', () => {
    const k = boot();
    k.act('stop', (ctx) => stopScheduler(ctx));
    expect(k.act('q', (ctx) => isSchedulerRunning(ctx))).toBe(false);
    api(k, 'v1/pods').create(pod('waits'));
    k.advance(600_000);
    const p = api(k, 'v1/pods').get('waits');
    expect(nodeOf(p)).toBe('');
    expect((p?.status as JsonObject).conditions).toBeUndefined();
    // The kubelets' Node events live in `default` too; none is about the Pod.
    expect(api(k, 'events.k8s.io/v1/events').list('default').filter((e) => JSON.stringify(e.regarding).includes('"waits"'))).toEqual([]);
    k.act('start', (ctx) => startScheduler(ctx, DEFAULT_APISERVER));
    k.advance(1_000);
    expect(['node01', 'node02']).toContain(nodeOf(api(k, 'v1/pods').get('waits')));
    expect(schedulerEvents(k, 'waits').map((e) => e.reason)).toEqual(['Scheduled']);
  });

  test('a Deployment spreads over the workers, the same way for the same seed', () => {
    const placement = (seed: number): { counts: Record<string, number>; hash: string } => {
      const k = boot(seed);
      api(k, 'apps/v1/deployments').create({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'web' },
        spec: { replicas: 6, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } } },
      });
      k.advance(5_000);
      const counts: Record<string, number> = {};
      for (const p of api(k, 'v1/pods').list('default')) counts[nodeOf(p)] = (counts[nodeOf(p)] ?? 0) + 1;
      return { counts, hash: k.hash() };
    };
    const a = placement(1);
    expect(placement(1)).toEqual(a);
    // Least-allocated scoring with the non-zero default requests alternates between the workers;
    // the tainted control plane gets none.
    expect(a.counts.controlplane).toBeUndefined();
    expect((a.counts.node01 ?? 0) + (a.counts.node02 ?? 0)).toBe(6);
    expect(Math.abs((a.counts.node01 ?? 0) - (a.counts.node02 ?? 0))).toBeLessThanOrEqual(1);
  });

  test('every decision is traced per node: the filter that rejected it and why', () => {
    const traces: TraceRecord[] = [];
    const k = boot(1, traces);
    api(k, 'v1/pods').create(pod('picky', { nodeSelector: { disktype: 'ssd' } }));
    k.advance(1_000);
    const filters = traces.filter((t) => t.kind === 'scheduler.filter' && t.subject === 'default/picky');
    expect(filters.map((t) => t.message)).toEqual([
      'default/picky: node controlplane rejected by TaintToleration: node(s) had untolerated taint(s) (UnschedulableAndUnresolvable)',
      "default/picky: node node01 rejected by NodeAffinity: node(s) didn't match Pod's node affinity/selector (UnschedulableAndUnresolvable)",
      "default/picky: node node02 rejected by NodeAffinity: node(s) didn't match Pod's node affinity/selector (UnschedulableAndUnresolvable)",
    ]);
    const sync = traces.find((t) => t.kind === 'controller.sync' && t.subject === 'default/picky');
    expect(filters.every((t) => t.causes?.includes(sync?.id as number))).toBe(true);
  });

  test('an unschedulable Pod with no relevant change is retried after five minutes; repeats form a series', () => {
    const k = boot();
    api(k, 'v1/pods').create(pod('big', { containers: [{ name: 'app', image: 'nginx:1.27', resources: { requests: { cpu: '3' } } }] }));
    k.advance(1_000);
    expect(schedulerEvents(k, 'big').length).toBe(1);
    k.advance(298_000);
    expect(schedulerEvents(k, 'big').length).toBe(1);
    // The leftover flush (every 30 s) moves it after 5m00s–5m30s. The first attempt's event
    // regards the Pod before its PodScheduled condition was written, the second the Pod after:
    // different resourceVersions, so not isomorphic (client-go tools/events getKey), a new Event.
    k.advance(32_000);
    const second = schedulerEvents(k, 'big');
    expect(second.length).toBe(2);
    expect(second.every((e) => e.series === undefined)).toBe(true);
    // The condition did not change, so the third attempt regards the same resourceVersion: a series.
    k.advance(330_000);
    const third = schedulerEvents(k, 'big');
    expect(third.length).toBe(2);
    expect(third.map((e) => (e.series as JsonObject | undefined)?.count)).toContain(2);
  });

  test('adding a toleration to a pending Pod schedules it with no further input', () => {
    const k = boot();
    api(k, 'v1/pods').create(pod('on-cp', { nodeSelector: { 'kubernetes.io/hostname': 'controlplane' } }));
    k.advance(1_000);
    expect(nodeOf(api(k, 'v1/pods').get('on-cp'))).toBe('');
    const r = k.act('patch', (ctx) =>
      createClient(ctx, DEFAULT_APISERVER).resource('v1/pods').patch('default', 'on-cp', { spec: { tolerations: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }] } }),
    );
    expect(r.ok).toBe(true);
    k.advance(1_000);
    expect(nodeOf(api(k, 'v1/pods').get('on-cp'))).toBe('controlplane');
    expect(schedulerEvents(k, 'on-cp').map((e) => e.reason)).toEqual(['FailedScheduling', 'Scheduled']);
  });

  test('a Pod for another scheduler is left alone', () => {
    const k = boot();
    api(k, 'v1/pods').create(pod('other', { schedulerName: 'my-scheduler' }));
    k.advance(10_000);
    expect(nodeOf(api(k, 'v1/pods').get('other'))).toBe('');
    expect(schedulerEvents(k, 'other')).toEqual([]);
  });
});

describe('FitError message and host selection', () => {
  test('reasons are sorted as strings, count first: "10 …" before "2 …"', () => {
    const explicit = [
      ...Array.from({ length: 10 }, (_, i) => ({ node: `a${i}`, status: { code: 'Unschedulable' as const, reasons: ['Insufficient cpu'] } })),
      ...Array.from({ length: 2 }, (_, i) => ({ node: `b${i}`, status: { code: 'UnschedulableAndUnresolvable' as const, reasons: ['node(s) were unschedulable'] } })),
    ];
    expect(fitErrorMessage(12, { explicit }, '', '')).toBe('0/12 nodes are available: 10 Insufficient cpu, 2 node(s) were unschedulable.');
  });

  test('the highest total wins; among equals, container/heap order (the first for small lists)', () => {
    const s = (node: string, total: number) => ({ node, total, plugins: {} });
    expect(selectHost([s('a', 10), s('b', 30), s('c', 20)])).toBe('b');
    expect(selectHost([s('a', 30), s('b', 30), s('c', 20)])).toBe('a');
    expect(selectHost([s('x', 5)])).toBe('x');
  });
});
