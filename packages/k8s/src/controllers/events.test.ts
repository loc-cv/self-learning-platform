// The events.k8s.io/v1 recorder in virtual time: the event body as kube-scheduler writes it (seen
// through both Event APIs, against the golden fixtures), isomorphic events becoming a Series, the
// broadcaster's periodic finishing and refreshing of series, and rejected events.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from '../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import type { K8sSlice } from '../apiserver/store.ts';
import { createClient } from '../client/client.ts';
import type { JsonObject } from '../apimachinery/json.ts';
import { microTimeOf } from '../apimachinery/time.ts';
import { eventf, FINISH_TIME_MS, REFRESH_TIME_MS, startEventsBroadcaster, stopEventsBroadcaster, type EventsRecorderRef } from './events.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

const SCHEDULER_USER = { username: 'system:kube-scheduler', groups: ['system:authenticated'] };

function boot(traces?: TraceRecord[]): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ...(traces ? { ports: { trace: (r: TraceRecord) => traces.push(r) } } : {}) });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  const c = (ctx: Parameters<typeof createClient>[0]) => createClient(ctx, DEFAULT_APISERVER);
  k.act('pod', (ctx) =>
    c(ctx)
      .resource('v1/pods')
      .create('default', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web' }, spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } }),
  );
  k.act('node', (ctx) => c(ctx).resource('v1/nodes').create(undefined, { apiVersion: 'v1', kind: 'Node', metadata: { name: 'node-1' } }));
  return k;
}

/** kube-scheduler's recorder: NewRecorder(scheme, "default-scheduler") on host controlplane. */
const ref = (ctx: Parameters<typeof createClient>[0]): EventsRecorderRef => ({
  recorder: 'kube-scheduler',
  reportingController: 'default-scheduler',
  reportingInstance: 'default-scheduler-controlplane',
  client: createClient(ctx, DEFAULT_APISERVER, SCHEDULER_USER),
});

function get(k: Kernel, resource: string, ns: string | undefined, name: string): JsonObject {
  const r = k.act('get', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).get(ns, name));
  if (!r.ok) throw new Error(`get ${resource} ${name}: ${r.code}`);
  return r.object as JsonObject;
}

/** Records `reason` about the Pod `web` (or another object) as the scheduler does. */
function record(k: Kernel, opts: { reason?: string; note?: string; type?: 'Normal' | 'Warning'; regarding?: [string, string | undefined, string]; related?: [string, string | undefined, string] } = {}): void {
  const [res, ns, name] = opts.regarding ?? ['v1/pods', 'default', 'web'];
  const regarding = get(k, res, ns, name);
  const related = opts.related ? get(k, ...opts.related) : undefined;
  k.act('eventf', (ctx) => eventf(ctx, ref(ctx), regarding, related, opts.type ?? 'Warning', opts.reason ?? 'FailedScheduling', opts.reason === 'Scheduled' ? 'Binding' : 'Scheduling', opts.note ?? '0/1 nodes are available: 1 Insufficient cpu.'));
}

function events(k: Kernel, apiVersion: 'events.k8s.io/v1' | 'v1' = 'events.k8s.io/v1', ns = 'default'): JsonObject[] {
  const r = k.act('list', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(`${apiVersion}/events`).list(ns));
  if (!r.ok) throw new Error('list');
  return (r.object as JsonObject).items as JsonObject[];
}

const meta = (o: JsonObject | undefined): JsonObject => (o?.metadata ?? {}) as JsonObject;
const broadcaster = (k: Kernel) => (k.world.slices.k8s as K8sSlice).eventBroadcasters['kube-scheduler'];
const t0 = DEFAULT_START_TIME;

describe('events.k8s.io recorder', () => {
  test('an event has the body makeEvent builds, and the stored object passes strict validation', () => {
    const k = boot();
    const pod = get(k, 'v1/pods', 'default', 'web');
    record(k, { reason: 'Scheduled', type: 'Normal', note: 'Successfully assigned default/web to node-1' });
    expect(events(k)).toHaveLength(1);
    const e = get(k, 'events.k8s.io/v1/events', 'default', meta(events(k)[0]).name as string);
    const m = meta(e);
    // GenerateEventName: <name>.<UnixNano in hex>.
    expect(m.name).toBe(`web.${(BigInt(t0) * 1_000_000n).toString(16)}`);
    expect(m.namespace).toBe('default');
    const { metadata: _, deprecatedFirstTimestamp, deprecatedLastTimestamp, deprecatedSource, ...body } = e;
    // What the recorder sent, plus the zero deprecated fields every stored Event has (metav1.Time
    // and EventSource are not omitted when empty).
    expect([deprecatedFirstTimestamp, deprecatedLastTimestamp, deprecatedSource]).toEqual([null, null, {}]);
    expect(body).toEqual({
      apiVersion: 'events.k8s.io/v1',
      kind: 'Event',
      eventTime: microTimeOf(t0),
      reportingController: 'default-scheduler',
      reportingInstance: 'default-scheduler-controlplane',
      action: 'Binding',
      reason: 'Scheduled',
      regarding: { kind: 'Pod', namespace: 'default', name: 'web', uid: meta(pod).uid, apiVersion: 'v1', resourceVersion: meta(pod).resourceVersion },
      note: 'Successfully assigned default/web to node-1',
      type: 'Normal',
    });
  });

  test('seen as core/v1, a scheduler event has the shape of the golden replicaset-pods fixture', () => {
    const k = boot();
    record(k, { reason: 'Scheduled', type: 'Normal', note: 'Successfully assigned default/web to node-1' });
    const e = get(k, 'v1/events', 'default', meta(events(k, 'v1')[0]).name as string);
    const { metadata, involvedObject, ...rest } = e;
    // fixtures/golden/v1.37.2/controllers/replicaset-pods.yaml, `event --field-selector
    // involvedObject.kind=Pod`: no count, null first and last timestamps, an empty source.
    expect(rest).toEqual({
      action: 'Binding',
      apiVersion: 'v1',
      eventTime: microTimeOf(t0),
      firstTimestamp: null,
      kind: 'Event',
      lastTimestamp: null,
      message: 'Successfully assigned default/web to node-1',
      reason: 'Scheduled',
      reportingComponent: 'default-scheduler',
      reportingInstance: 'default-scheduler-controlplane',
      source: {},
      type: 'Normal',
    });
    expect(Object.keys(involvedObject as JsonObject).sort()).toEqual(['apiVersion', 'kind', 'name', 'namespace', 'resourceVersion', 'uid']);
    expect(Object.keys(metadata as JsonObject).sort()).toEqual(['creationTimestamp', 'name', 'namespace', 'resourceVersion', 'uid']);
    // `kubectl get events -o wide` (scheduling/failures.yaml) shows SOURCE `default-scheduler,
    // default-scheduler-controlplane`: the core view's reportingComponent and reportingInstance.
    // The events.k8s.io field selector maps reportingController to reportingComponent.
    const r = k.act('list', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('events.k8s.io/v1/events').list('default', { fieldSelector: 'reportingController=default-scheduler' }));
    expect(r.ok && ((r.object as JsonObject).items as JsonObject[]).length).toBe(1);
  });

  test('an event about a cluster-scoped object goes to the default namespace; related is referenced', () => {
    const k = boot();
    record(k, { reason: 'Preempted', type: 'Normal', regarding: ['v1/nodes', undefined, 'node-1'], related: ['v1/pods', 'default', 'web'], note: 'preempting' });
    const [e] = events(k);
    expect(meta(e).namespace).toBe('default');
    expect(meta(e).name).toMatch(/^node-1\.[0-9a-f]+$/);
    expect(e?.regarding).toMatchObject({ kind: 'Node', name: 'node-1', apiVersion: 'v1' });
    expect((e?.regarding as JsonObject).namespace).toBeUndefined();
    expect(e?.related).toMatchObject({ kind: 'Pod', namespace: 'default', name: 'web' });
  });

  test('a second isomorphic event starts a series, patched onto the first; later ones are only counted', () => {
    const k = boot();
    record(k);
    const first = events(k)[0] as JsonObject;
    expect(first.series).toBeUndefined();
    expect(k.nextEventTime()).toBeUndefined(); // no series, nothing pending
    k.advance(5000);
    record(k);
    let es = events(k);
    expect(es).toHaveLength(1);
    expect(meta(es[0]).name).toBe(meta(first).name);
    expect(es[0]?.series).toEqual({ count: 2, lastObservedTime: microTimeOf(t0 + 5000) });
    expect(meta(es[0]).resourceVersion).not.toBe(meta(first).resourceVersion);
    // Seen as core/v1 (pkg/apis/events/v1/conversion.go): the series as is, no count.
    expect(events(k, 'v1')[0]?.series).toEqual({ count: 2, lastObservedTime: microTimeOf(t0 + 5000) });
    expect(events(k, 'v1')[0]?.count).toBeUndefined();
    const rv = meta(es[0]).resourceVersion;
    k.advance(5000);
    record(k);
    es = events(k);
    expect(es[0]?.series).toEqual({ count: 2, lastObservedTime: microTimeOf(t0 + 5000) });
    expect(meta(es[0]).resourceVersion).toBe(rv);
    expect(broadcaster(k)?.cache[Object.keys(broadcaster(k)?.cache ?? {})[0] as string]?.series).toEqual({ count: 3, lastObserved: t0 + 10_000 });
    // A tick of finishSeries is pending on the 6-minute grid from the broadcaster's start.
    expect(k.nextEventTime()).toBe(t0 + FINISH_TIME_MS);
  });

  test('the note is not part of the key: a different note joins the series and keeps the first note', () => {
    const k = boot();
    record(k, { note: 'first' });
    k.advance(1000);
    record(k, { note: 'second' });
    const es = events(k);
    expect(es).toHaveLength(1);
    expect(es[0]?.note).toBe('first');
    expect((es[0]?.series as JsonObject).count).toBe(2);
    // Another reason is another event.
    record(k, { reason: 'Other', note: 'x' });
    expect(events(k)).toHaveLength(2);
  });

  test('finishSeries writes the final count 6 to 12 minutes after the last observation, then forgets the series', () => {
    const traces: TraceRecord[] = [];
    const k = boot(traces);
    record(k);
    k.advance(5000);
    record(k);
    k.advance(5000);
    record(k); // count 3 at t0 + 10 s, unwritten
    // Tick at t0 + 6 min: last observed less than 6 minutes before, nothing written.
    k.runUntil(t0 + FINISH_TIME_MS);
    expect((events(k)[0]?.series as JsonObject).count).toBe(2);
    expect(k.nextEventTime()).toBe(t0 + 2 * FINISH_TIME_MS);
    k.runUntil(t0 + 2 * FINISH_TIME_MS - 1);
    expect((events(k)[0]?.series as JsonObject).count).toBe(2);
    k.runUntil(t0 + 2 * FINISH_TIME_MS);
    expect(events(k)[0]?.series).toEqual({ count: 3, lastObservedTime: microTimeOf(t0 + 10_000) });
    expect(traces.some((r) => r.kind === 'event.series-finish')).toBe(true);
    expect(broadcaster(k)?.cache).toEqual({});
    expect(broadcaster(k)?.tick).toBeUndefined();
    expect(k.nextEventTime()).toBeUndefined();
    // The same event again is a new Event.
    k.advance(1000);
    record(k);
    const es = events(k);
    expect(es).toHaveLength(2);
    expect(es.filter((e) => e.series === undefined)).toHaveLength(1);
  });

  test('a singleton leaves the cache at the first tick more than 6 minutes after it', () => {
    const k = boot();
    record(k);
    // The tick at t0 + 6 min keeps it (not before t0); the one at t0 + 12 min drops it.
    k.runUntil(t0 + 2 * FINISH_TIME_MS - 1);
    record(k);
    expect(events(k)).toHaveLength(1);
    expect((events(k)[0]?.series as JsonObject).count).toBe(2);

    const k2 = boot();
    record(k2);
    k2.runUntil(t0 + 2 * FINISH_TIME_MS);
    record(k2);
    const es = events(k2);
    expect(es).toHaveLength(2);
    expect(es.every((e) => e.series === undefined)).toBe(true);
  });

  test('refreshExistingEventSeries writes every series every 30 minutes from the start', () => {
    const k = boot();
    // One event a minute, at 1 s past each minute, for 35 minutes.
    record(k);
    for (let i = 0; i < 35; i++) {
      k.runUntil(t0 + 1000 + i * 60_000);
      record(k);
    }
    // Written at count 2 (t0 + 1 s), then by the refresh at t0 + 30 min: the event at t0 and the
    // 30 at t0 + 1 s … t0 + 29 min 1 s.
    const series = events(k)[0]?.series as JsonObject;
    expect(series).toEqual({ count: 31, lastObservedTime: microTimeOf(t0 + 1000 + 29 * 60_000) });
    expect(t0 + REFRESH_TIME_MS).toBeLessThan(k.now);
    // The cache now holds what the server returned.
    const entry = Object.values(broadcaster(k)?.cache ?? {})[0];
    expect(meta(entry?.event).uid).toBeDefined();
    expect(entry?.series?.count).toBe(36);
  });

  test('the broadcaster start sets the grid of its periodic work', () => {
    const k = boot();
    k.act('start', (ctx) => startEventsBroadcaster(ctx, 'kube-scheduler', ref(ctx).client));
    k.advance(5 * 60_000);
    record(k);
    k.advance(1000);
    record(k);
    // Ticks at t0 + 6 and t0 + 12 minutes, not 6 minutes after the first event.
    expect(k.nextEventTime()).toBe(t0 + FINISH_TIME_MS);
  });

  test('a series whose event is gone is created again, under the first name, with the series', () => {
    const k = boot();
    record(k);
    const name = meta(events(k)[0]).name as string;
    k.act('delete', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('events.k8s.io/v1/events').delete('default', name));
    expect(events(k)).toHaveLength(0);
    k.advance(1000);
    record(k);
    const es = events(k);
    expect(es).toHaveLength(1);
    expect(meta(es[0]).name).toBe(name);
    expect(es[0]?.series).toEqual({ count: 2, lastObservedTime: microTimeOf(t0 + 1000) });
    expect(es[0]?.eventTime).toBe(microTimeOf(t0));
  });

  test('a note over 1024 bytes is rejected by the server and not retried', () => {
    const traces: TraceRecord[] = [];
    const k = boot(traces);
    record(k, { note: 'x'.repeat(1025) });
    expect(events(k)).toHaveLength(0);
    const rejected = traces.find((r) => r.kind === 'event.rejected');
    expect(rejected?.message).toContain('422');
    expect(rejected?.message).toContain('can have at most 1024 characters');
    expect(k.nextEventTime()).toBeUndefined();
  });

  test('stopping the broadcaster forgets the cache and cancels its periodic work', () => {
    const k = boot();
    record(k);
    record(k);
    expect(k.nextEventTime()).toBe(t0 + FINISH_TIME_MS);
    k.act('stop', (ctx) => stopEventsBroadcaster(ctx, 'kube-scheduler'));
    expect(k.nextEventTime()).toBeUndefined();
    expect(broadcaster(k)?.cache).toEqual({});
    // A stopped broadcaster drops events.
    record(k);
    expect(events(k)).toHaveLength(1);
    // A new one at the same instant has an empty cache and still names events uniquely.
    k.act('start', (ctx) => startEventsBroadcaster(ctx, 'kube-scheduler', ref(ctx).client));
    record(k);
    const es = events(k);
    expect(es).toHaveLength(2);
    expect(es.every((e) => e.series === undefined || (e.series as JsonObject).count === 2)).toBe(true);
  });

  test('recorder state survives a fork, and both forks finish the series alike', () => {
    const k = boot();
    record(k);
    record(k);
    record(k);
    const f = k.fork();
    k.runUntil(t0 + 2 * FINISH_TIME_MS);
    f.runUntil(t0 + 2 * FINISH_TIME_MS);
    expect(f.hash()).toBe(k.hash());
    expect((events(f)[0]?.series as JsonObject).count).toBe(3);
  });
});
