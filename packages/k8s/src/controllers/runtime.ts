// The controller runtime (docs/ARCHITECTURE.md §4.3): watch-fed work queues in world data, one
// key per sync event, modeled latency, rate-limited retries, start and stop.
//
// A running controller holds one watch subscription per watched resource. When the store
// publishes `k8s.watch:<id>`, the waiter turns into a `k8s.controller.watch` event: the pending
// events are mapped to keys (the informer's event handlers) and queued after the controller's
// latency. One `k8s.controller.sync` event is pending per controller at a time, at the earliest
// due key; it syncs that key and schedules the next. Keys are unique in the queue, as in
// client-go's workqueue (staging/src/k8s.io/client-go/util/workqueue/queue.go: an Add of a queued
// key is a no-op; a delayed add of a queued key keeps the earlier time).
//
// Retries follow DefaultTypedControllerRateLimiter (util/workqueue/default_rate_limiters.go):
// per key 5 ms · 2^failures, at most 1000 s. Its overall 10 qps/100 burst bucket is not modeled:
// it only matters above a hundred failing keys at once.
//
// Starting a controller does what an informer does at start: list everything (a watch from
// "now" begins with ADDED for every object) and queue the keys. Stopping forgets the queue, as a
// stopped process forgets its memory.

import { keys, put, remove, type Contribution, type Ctx, type HandlerSpec, type Millis } from '@simlab/kernel';
import type { Json } from '../apimachinery/json.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { openWatch } from '../apiserver/pipeline.ts';
import { closeSubscription, etcdData, k8sSlice, objectKey, storeGet, storeList, takeEvents, watchTopic, type ApiObject } from '../apiserver/store.ts';
import { strategyFor } from '../apiserver/strategies.ts';
import type { UserInfo } from '../apiserver/types.ts';
import { createClient, gvr } from '../client/client.ts';
import { writeData } from '../client/writes.ts';
import { recordEvent } from './record.ts';
import type { ControllerEvent, ControllerSpec, Reader, SyncCtx, SyncResult } from './types.ts';

/** Registry contribution kind under which plugins contribute controllers. */
export const CONTROLLER = 'k8s.controller';

export const WATCH_EVENT = 'k8s.controller.watch';
export const SYNC_EVENT = 'k8s.controller.sync';

/** ItemExponentialFailureRateLimiter(5ms, 1000s) of DefaultTypedControllerRateLimiter. */
export const BACKOFF_BASE_MS = 5;
export const BACKOFF_MAX_MS = 1_000_000;

export interface QueueItem {
  key: string;
  /** Virtual time the key becomes due. */
  at: Millis;
  /** Why it was queued, in trace vocabulary: `MODIFIED apps/v1/replicasets default/web-5d7`. */
  cause: string;
}

export interface ControllerWatch {
  /** Index into the spec's `watches`. */
  index: number;
  subscription: string;
  waiter: string;
}

export interface ControllerState {
  /** `<instance>/<name>`: `kube-controller-manager/deployment`. */
  id: string;
  name: string;
  /** The process that runs it (one controller manager per cluster so far). */
  instance: string;
  server: ApiServerConfig;
  watches: ControllerWatch[];
  /** Keys waiting, each at most once, in arrival order. */
  queue: QueueItem[];
  /** Consecutive failures per key, for backoff and maxRetries. */
  failures: Record<string, number>;
  /** The pending sync event, if one is scheduled. */
  scheduled?: { event: string; at: Millis };
  /** Controller-specific bookkeeping (SyncCtx.data). */
  data: Record<string, Json>;
}

export function controllerSpec(ctx: Ctx, name: string): ControllerSpec {
  const s = ctx.registry.get<Contribution>(CONTROLLER, name);
  if (!s) throw new Error(`no controller named ${name} is registered`);
  return s as unknown as ControllerSpec;
}

/** Every registered controller, sorted by name. */
export function controllerSpecs(ctx: Ctx): ControllerSpec[] {
  return ctx.registry.list<Contribution>(CONTROLLER) as unknown as ControllerSpec[];
}

const controllerId = (instance: string, name: string): string => `${instance}/${name}`;

function stateOf(ctx: Ctx, id: string): ControllerState | undefined {
  return k8sSlice(ctx).controllers[id];
}

function save(ctx: Ctx, st: ControllerState): void {
  put(k8sSlice(ctx).controllers, st.id, st);
}

/** The user a controller acts as: its service account in kube-system. */
export function controllerUser(spec: ControllerSpec, instance?: string): UserInfo {
  if (spec.userOf && instance !== undefined) return spec.userOf(instance);
  if (spec.user) return spec.user;
  return {
    username: `system:serviceaccount:kube-system:${spec.serviceAccount}`,
    groups: ['system:serviceaccounts', 'system:serviceaccounts:kube-system', 'system:authenticated'],
  };
}

/** The informer cache stand-in: objects of the server's store, as stored. */
export function storeReader(ctx: Ctx, server: ApiServerConfig): Reader {
  const storage = (resource: string): string => {
    const g = gvr(resource);
    const st = strategyFor(g.group, g.resource);
    if (!st) throw new Error(`controller reads unknown resource ${resource}`);
    return st.storage;
  };
  return {
    get: (resource, namespace, name) => storeGet(etcdData(ctx, server.etcd), storage(resource), objectKey(namespace, name)),
    list: (resource, namespace) => storeList(etcdData(ctx, server.etcd), storage(resource), namespace),
  };
}

export function isRunning(ctx: Ctx, instance: string, name: string): boolean {
  return stateOf(ctx, controllerId(instance, name)) !== undefined;
}

/**
 * Starts a controller of `instance` against an API server: opens its watches (which begin with
 * every current object) and queues the keys they produce.
 */
export function startController(ctx: Ctx, instance: string, name: string, server: ApiServerConfig, data: Record<string, Json> = {}): void {
  const spec = controllerSpec(ctx, name);
  const id = controllerId(instance, name);
  if (stateOf(ctx, id)) return;
  let st: ControllerState = { id, name, instance, server, watches: [], queue: [], failures: {}, data };
  save(ctx, st);
  ctx.trace({ source: traceSource(spec), kind: 'controller.start', message: `${name} controller started`, data: { instance } });
  spec.watches.forEach((w, index) => {
    const g = gvr(w.resource);
    const opened = openWatch(ctx, server, { verb: 'watch', ...g, options: {} }, { controller: id });
    if (!('ok' in opened)) throw new Error(`controller ${name}: cannot watch ${w.resource}: ${JSON.stringify(opened)}`);
    const subscription = opened.ok.id;
    st = stateOf(ctx, id) as ControllerState;
    st = { ...st, watches: [...st.watches, { index, subscription, waiter: '' }] };
    save(ctx, st);
    // The initial ADDED events were queued before anyone waited: take them now.
    consume(ctx, spec, id, index, subscription, true);
  });
}

/** Stops a controller: closes its watches, drops its queue and pending sync. */
export function stopController(ctx: Ctx, instance: string, name: string): void {
  const id = controllerId(instance, name);
  const st = stateOf(ctx, id);
  if (!st) return;
  for (const w of st.watches) {
    if (w.waiter) ctx.unsubscribe(watchTopic(w.subscription), w.waiter);
    closeSubscription(ctx, w.subscription);
  }
  if (st.scheduled) ctx.cancel(st.scheduled.event);
  remove(k8sSlice(ctx).controllers, id);
  ctx.trace({ source: traceSource(controllerSpec(ctx, name)), kind: 'controller.stop', message: `${name} controller stopped`, data: { instance, dropped: st.queue.length } });
}

const traceSource = (spec: ControllerSpec): string => `k8s.controller/${spec.name}`;

function describeEvent(resource: string, ev: ControllerEvent): string {
  const m = ev.object.metadata as { namespace?: string; name?: string; resourceVersion?: string } | undefined;
  return `${ev.type} ${resource} ${objectKey(m?.namespace, m?.name ?? '')}`;
}

/** Takes a subscription's pending events, queues their keys, and waits for more. */
function consume(ctx: Ctx, spec: ControllerSpec, id: string, index: number, subscription: string, initial = false): void {
  const w = spec.watches[index];
  if (!w) return;
  const read = storeReader(ctx, (stateOf(ctx, id) as ControllerState).server);
  for (const e of takeEvents(ctx, subscription)) {
    const ev: ControllerEvent = { type: e.type, object: e.object, ...(e.old ? { old: e.old } : {}), ...(initial ? { initial: true } : {}) };
    const cause = describeEvent(w.resource, ev);
    for (const key of w.keys(ev, read, (stateOf(ctx, id) as ControllerState).data)) enqueue(ctx, id, key, spec.latency, cause);
  }
  const waiter = ctx.subscribe(watchTopic(subscription), WATCH_EVENT, { controller: id, subscription });
  const st = stateOf(ctx, id) as ControllerState;
  save(ctx, { ...st, watches: st.watches.map((x) => (x.subscription === subscription ? { ...x, waiter } : x)) });
}

/** Queues a key after `delay`; a key already queued keeps its place and the earlier time. */
export function enqueue(ctx: Ctx, id: string, key: string, delay: Millis, cause: string): void {
  const st = stateOf(ctx, id);
  if (!st) return;
  const at = ctx.now + delay;
  const i = st.queue.findIndex((q) => q.key === key);
  let queue: QueueItem[];
  if (i < 0) queue = [...st.queue, { key, at, cause }];
  else if (at < (st.queue[i] as QueueItem).at) queue = st.queue.map((q, j) => (j === i ? { key, at, cause } : q));
  else return;
  const next = { ...st, queue };
  save(ctx, next);
  reschedule(ctx, next);
}

/** Keeps exactly one sync event pending, at the earliest due key. */
function reschedule(ctx: Ctx, st: ControllerState): void {
  const first = earliest(st.queue);
  const at = first === undefined ? undefined : Math.max(ctx.now, (st.queue[first] as QueueItem).at);
  if (st.scheduled && st.scheduled.at === at) return;
  if (st.scheduled) ctx.cancel(st.scheduled.event);
  const next: ControllerState = { ...st };
  delete next.scheduled;
  if (at !== undefined) next.scheduled = { event: ctx.schedule(at - ctx.now, SYNC_EVENT, { controller: st.id }), at };
  save(ctx, next);
}

function earliest(queue: QueueItem[]): number | undefined {
  let best: number | undefined;
  queue.forEach((q, i) => {
    if (best === undefined || q.at < (queue[best] as QueueItem).at) best = i;
  });
  return best;
}

function backoff(failures: number, spec: ControllerSpec): Millis {
  const base = spec.backoff?.baseMs ?? BACKOFF_BASE_MS;
  const max = spec.backoff?.maxMs ?? BACKOFF_MAX_MS;
  const d = base * 2 ** failures;
  return d > max ? max : d;
}

function runSync(ctx: Ctx, id: string): void {
  let st = stateOf(ctx, id);
  if (!st) return;
  st = { ...st };
  delete st.scheduled;
  const i = earliest(st.queue);
  if (i === undefined || (st.queue[i] as QueueItem).at > ctx.now) {
    save(ctx, st);
    reschedule(ctx, st);
    return;
  }
  const item = st.queue[i] as QueueItem;
  st = { ...st, queue: st.queue.filter((_, j) => j !== i) };
  save(ctx, st);
  const spec = controllerSpec(ctx, st.name);
  const source = traceSource(spec);
  const syncId = ctx.trace({ source, kind: 'controller.sync', subject: item.key, message: `sync ${item.key}, queued by ${item.cause}`, data: { controller: st.name, instance: st.instance, key: item.key, cause: item.cause } });
  const result = spec.sync(syncCtx(ctx, spec, st, syncId, item.key), item.key);
  settle(ctx, spec, id, item.key, result, syncId);
}

function settle(ctx: Ctx, spec: ControllerSpec, id: string, key: string, result: SyncResult, syncId: number): void {
  const st = stateOf(ctx, id);
  if (!st) return;
  const source = traceSource(spec);
  if ('error' in result) {
    const n = st.failures[key] ?? 0;
    if (spec.maxRetries !== undefined && n >= spec.maxRetries) {
      const failures = { ...st.failures };
      delete failures[key];
      save(ctx, { ...st, failures });
      ctx.trace({ source, kind: 'controller.dropped', subject: key, message: `dropping ${key} out of the queue after ${n} retries: ${result.error}`, data: { controller: spec.name, instance: st.instance, key, retries: n, error: result.error }, causes: [syncId] });
    } else {
      save(ctx, { ...st, failures: { ...st.failures, [key]: n + 1 } });
      ctx.trace({ source, kind: 'controller.error', subject: key, message: `error syncing ${key}, retrying in ${backoff(n, spec)} ms: ${result.error}`, data: { controller: spec.name, instance: st.instance, key, retryIn: backoff(n, spec), error: result.error }, causes: [syncId] });
      enqueue(ctx, id, key, backoff(n, spec), `retry after error: ${result.error}`);
    }
  } else {
    if (st.failures[key] !== undefined) {
      const failures = { ...st.failures };
      delete failures[key];
      save(ctx, { ...st, failures });
    }
    if ('requeueAfter' in result) enqueue(ctx, id, key, result.requeueAfter, 'requeued by its own sync');
  }
  const after = stateOf(ctx, id);
  if (after) reschedule(ctx, after);
}

function describeRequest(verb: string, resource: string, namespace: string | undefined, name: string | undefined, subresource: string | undefined): string {
  return `${verb} ${resource}${subresource ? `/${subresource}` : ''} ${objectKey(namespace, name ?? '')}`;
}

function syncCtx(ctx: Ctx, spec: ControllerSpec, st: ControllerState, syncId: number, currentKey: string): SyncCtx {
  const source = traceSource(spec);
  const reader = storeReader(ctx, st.server);
  const client = createClient(ctx, st.server, controllerUser(spec, st.instance), (req, res) => {
    if (req.verb === 'get' || req.verb === 'list' || req.verb === 'watch') return;
    const body = req.body as { metadata?: { name?: string; generateName?: string } } | undefined;
    const name = req.name ?? (res.ok ? ((res.object as { metadata?: { name?: string } }).metadata?.name ?? undefined) : body?.metadata?.name ?? body?.metadata?.generateName);
    const what = describeRequest(req.verb, req.group ? `${req.group}/${req.resource}` : req.resource, req.namespace, name, req.subresource);
    const failure = res.ok ? '' : 'status' in res ? String(res.status.message ?? '') : 'notSimulated' in res ? res.notSimulated : '';
    ctx.trace({
      source,
      kind: res.ok ? 'controller.write' : 'controller.write-failed',
      subject: what,
      message: res.ok ? what : `${what}: ${res.code} ${failure}`,
      data: { ...writeData(req, res, name), controller: spec.name, instance: st.instance, key: currentKey },
      causes: [syncId],
    });
  });
  return {
    ctx,
    server: st.server,
    now: ctx.now,
    client,
    get: reader.get,
    list: reader.list,
    event(object: ApiObject, type, reason, message) {
      if (!spec.eventSource) throw new Error(`controller ${spec.name} records events but has no eventSource`);
      recordEvent(ctx, { recorder: st.id, component: spec.eventSource, client, cause: syncId }, object, type, reason, message);
    },
    enqueueAfter: (key, delay) => enqueue(ctx, st.id, key, delay, 'queued by a sync'),
    syncId,
    trace: (kind, message, data, subject, causes) => ctx.trace({ source, kind, message, ...(subject ? { subject } : {}), ...(data !== undefined ? { data } : {}), causes: [syncId, ...(causes ?? [])] }),
    data: () => (stateOf(ctx, st.id) as ControllerState).data,
    setData(key, value) {
      const cur = stateOf(ctx, st.id) as ControllerState;
      const data = { ...cur.data };
      if (value === undefined) delete data[key];
      else data[key] = value;
      save(ctx, { ...cur, data });
    },
  };
}

/** The kernel handlers of the runtime, registered by the k8s plugin. */
export const controllerHandlers: HandlerSpec[] = [
  {
    type: WATCH_EVENT,
    handle(ctx, payload) {
      const { controller, subscription } = payload as { controller: string; subscription: string };
      const st = stateOf(ctx, controller);
      const w = st?.watches.find((x) => x.subscription === subscription);
      if (!st || !w) return;
      consume(ctx, controllerSpec(ctx, st.name), st.id, w.index, subscription);
    },
  },
  {
    type: SYNC_EVENT,
    handle(ctx, payload) {
      runSync(ctx, (payload as { controller: string }).controller);
    },
  },
];

/** Running controllers of an instance, by name. */
export function runningControllers(ctx: Ctx, instance: string): string[] {
  const t = k8sSlice(ctx).controllers;
  return keys(t)
    .filter((k) => (t[k] as ControllerState).instance === instance)
    .map((k) => (t[k] as ControllerState).name);
}
