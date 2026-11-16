// The store: the content of an etcd data directory (docs/ARCHITECTURE.md §4.1). Objects are kept
// in their storage version, fully defaulted, as frozen values keyed by `<namespace>/<name>` (or
// `<name>`) per storage resource; every write takes the next revision, which becomes the
// object's resourceVersion. Watches are subscriptions in world data, fed after each write.
//
// upstream: etcd's key space `/registry/<resource>/<namespace>/<name>` (lists come back in key
// order, byte-wise); staging/src/k8s.io/apiserver/pkg/storage/cacher (a watcher whose selector
// stops matching an object sees DELETED, one that starts matching sees ADDED).

import { compareCodeUnits, keys, put, remove, type Ctx, type Table } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import type { ControllerState } from '../controllers/runtime.ts';
import type { RecorderState } from '../controllers/record.ts';

export const K8S = 'k8s';

/** A stored object: canonical JSON of the storage version. */
export type ApiObject = JsonObject;

export interface EtcdData {
  /** The last revision written; the next write takes revision + 1. */
  revision: number;
  /** Storage resource (`pods`, `deployments.apps`) → key → object. */
  resources: Record<string, Table<ApiObject>>;
  /** Keys that are not API objects: allocator ranges (`/registry/ranges/servicenodeports`). */
  ranges: Table<Json>;
  /** Recent changes, for watches that start from a past resourceVersion; keyed by padded revision. */
  history: Table<HistoryEntry>;
}

/**
 * One change as the watch cache remembers it. upstream: apiserver/pkg/storage/cacher
 * (watch_cache_history.go keeps at least 100 events; cacher.go DefaultEventFreshDuration, 75 s,
 * is how long an event is guaranteed to stay).
 */
export interface HistoryEntry {
  revision: number;
  /** Virtual time of the write, ms. */
  at: number;
  storage: string;
  type: WatchEventType;
  object: ApiObject;
  old?: ApiObject;
}

export const HISTORY_FRESH_MS = 75_000;
export const HISTORY_MIN_EVENTS = 100;
const historyKey = (rev: number): string => String(rev).padStart(15, '0');

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface WatchEvent {
  type: WatchEventType;
  /** The object in its storage version; the reader converts it. */
  object: ApiObject;
  /**
   * MODIFIED: the object as stored before this change. A watch carries only the new object; this
   * stands in for the informer cache's previous copy, which controllers' update handlers receive.
   */
  old?: ApiObject;
}

export interface WatchSubscription {
  id: string;
  /** The etcd data the watched server reads. */
  etcd: string;
  /** Storage resource. */
  storage: string;
  /** The API the watch was opened on: what events are converted to. */
  group: string;
  version: string;
  resource: string;
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  /** Who reads it, for cleanup when the owner goes away. */
  owner: Json;
  pending: WatchEvent[];
}

export interface K8sSlice {
  /** etcd data per data directory id. */
  etcd: Record<string, EtcdData>;
  watches: Table<WatchSubscription>;
  /** Running controllers by `<instance>/<name>` (controllers/runtime.ts ControllerState). */
  controllers: Table<ControllerState>;
  /** Event recorder state (correlator caches) per controller id (controllers/record.ts). */
  recorders: Table<RecorderState>;
}

export function emptyEtcd(): EtcdData {
  return { revision: 1, resources: {}, ranges: {}, history: {} };
}

export function k8sSlice(ctx: Ctx): K8sSlice {
  return ctx.slice<K8sSlice>(K8S);
}

/** The etcd data of a data directory, created empty on first use. */
export function etcdData(ctx: Ctx, id: string): EtcdData {
  const s = k8sSlice(ctx);
  let d = s.etcd[id];
  if (!d) {
    d = emptyEtcd();
    s.etcd[id] = d;
  }
  return d;
}

export function objectKey(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}/${name}` : name;
}

function table(d: EtcdData, storage: string): Table<ApiObject> {
  let t = d.resources[storage];
  if (!t) {
    t = {};
    d.resources[storage] = t;
  }
  return t;
}

export function storeGet(d: EtcdData, storage: string, key: string): ApiObject | undefined {
  return d.resources[storage]?.[key];
}

/** Objects of a resource in key order, optionally in one namespace. */
export function storeList(d: EtcdData, storage: string, namespace?: string): ApiObject[] {
  const t = d.resources[storage];
  if (!t) return [];
  const prefix = namespace ? `${namespace}/` : '';
  return keys(t)
    .filter((k) => k.startsWith(prefix))
    .map((k) => t[k] as ApiObject);
}

/** Every object of a resource in the store, regardless of namespace, with its key. */
export function storeEntries(d: EtcdData, storage: string): [string, ApiObject][] {
  const t = d.resources[storage];
  return t ? keys(t).map((k) => [k, t[k] as ApiObject]) : [];
}

function withRv(obj: ApiObject, rv: number): ApiObject {
  const meta = { ...((obj.metadata as JsonObject | undefined) ?? {}) };
  // resourceVersion sits after namespace/uid in Go's ObjectMeta order; rebuild in that order.
  const ordered: JsonObject = {};
  const ORDER = ['name', 'generateName', 'namespace', 'selfLink', 'uid', 'resourceVersion', 'generation', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'labels', 'annotations', 'ownerReferences', 'finalizers', 'managedFields'];
  meta.resourceVersion = String(rv);
  for (const k of ORDER) if (meta[k] !== undefined) ordered[k] = meta[k] as Json;
  for (const k of Object.keys(meta)) if (!(k in ordered)) ordered[k] = meta[k] as Json;
  const out: JsonObject = {};
  for (const k of Object.keys(obj)) out[k] = k === 'metadata' ? ordered : (obj[k] as Json);
  if (!('metadata' in out)) out.metadata = ordered;
  return out;
}

/** Field set of an object for field selector matching; supplied by the kind's strategy. */
export type FieldsOf = (storage: string, obj: ApiObject) => Record<string, string>;
/** Does a watch's selector set match an object? Supplied by the pipeline (selector parsing is code). */
export type WatchMatcher = (sub: WatchSubscription, obj: ApiObject) => boolean;

let watchMatcher: WatchMatcher = () => true;

/** Installed once by the API server module; the store itself knows no selector syntax. */
export function setWatchMatcher(m: WatchMatcher): void {
  watchMatcher = m;
}

export const watchTopic = (id: string): string => `k8s.watch:${id}`;

function remember(ctx: Ctx, d: EtcdData, storage: string, type: WatchEventType, obj: ApiObject, old: ApiObject | undefined): void {
  put(d.history, historyKey(d.revision), { revision: d.revision, at: ctx.now, storage, type, object: obj, ...(old ? { old } : {}) });
  const ks = keys(d.history);
  for (let i = 0; i < ks.length - HISTORY_MIN_EVENTS; i++) {
    const e = d.history[ks[i] as string] as HistoryEntry;
    if (e.at >= ctx.now - HISTORY_FRESH_MS) break;
    remove(d.history, ks[i] as string);
  }
}

/** The oldest revision a watch can start after, and the events after `rev` for a resource. */
export function historySince(d: EtcdData, storage: string, rev: number): { oldest: number; events: HistoryEntry[] } {
  const ks = keys(d.history);
  const first = ks.length > 0 ? (d.history[ks[0] as string] as HistoryEntry).revision : d.revision + 1;
  const events = ks.map((k) => d.history[k] as HistoryEntry).filter((e) => e.revision > rev && e.storage === storage);
  return { oldest: first - 1, events };
}

/** The watch event a subscriber sees for a change, given its selectors (cacher semantics). */
export function eventFor(sub: WatchSubscription, type: WatchEventType, obj: ApiObject, old: ApiObject | undefined): WatchEventType | undefined {
  const ns = (obj.metadata as JsonObject | undefined)?.namespace;
  if (sub.namespace !== undefined && sub.namespace !== ns) return undefined;
  const now = watchMatcher(sub, obj);
  if (type !== 'MODIFIED') return now ? type : undefined;
  const before = old !== undefined && watchMatcher(sub, old);
  return now && before ? 'MODIFIED' : now ? 'ADDED' : before ? 'DELETED' : undefined;
}

function deliver(ctx: Ctx, etcdId: string, storage: string, type: WatchEventType, obj: ApiObject, old: ApiObject | undefined): void {
  const s = k8sSlice(ctx);
  remember(ctx, etcdData(ctx, etcdId), storage, type, obj, old);
  for (const id of keys(s.watches)) {
    const sub = s.watches[id] as WatchSubscription;
    if (sub.etcd !== etcdId || sub.storage !== storage) continue;
    const ev = eventFor(sub, type, obj, old);
    if (!ev) continue;
    put(s.watches, id, { ...sub, pending: [...sub.pending, { type: ev, object: obj, ...(ev === 'MODIFIED' && old ? { old } : {}) }] });
    ctx.publish(watchTopic(id));
  }
}

/** Stores a new object at the next revision; returns it as stored. */
export function storeCreate(ctx: Ctx, etcdId: string, storage: string, key: string, obj: ApiObject): ApiObject {
  const d = etcdData(ctx, etcdId);
  d.revision += 1;
  const stored = put(table(d, storage), key, withRv(obj, d.revision));
  deliver(ctx, etcdId, storage, 'ADDED', stored, undefined);
  return stored;
}

/** Replaces an object at the next revision. */
export function storeUpdate(ctx: Ctx, etcdId: string, storage: string, key: string, obj: ApiObject): ApiObject {
  const d = etcdData(ctx, etcdId);
  const old = storeGet(d, storage, key);
  d.revision += 1;
  const stored = put(table(d, storage), key, withRv(obj, d.revision));
  deliver(ctx, etcdId, storage, 'MODIFIED', stored, old);
  return stored;
}

/** Removes an object; the DELETED event carries the deletion revision. Returns the last state. */
export function storeDelete(ctx: Ctx, etcdId: string, storage: string, key: string): ApiObject | undefined {
  const d = etcdData(ctx, etcdId);
  const old = storeGet(d, storage, key);
  if (!old) return undefined;
  d.revision += 1;
  remove(table(d, storage), key);
  deliver(ctx, etcdId, storage, 'DELETED', withRv(old, d.revision), undefined);
  return old;
}

/**
 * Opens a watch subscription. `initial` objects are queued as ADDED (a watch from "now");
 * `replay` changes since a past revision are queued as the subscriber would have seen them.
 */
export function openSubscription(ctx: Ctx, sub: Omit<WatchSubscription, 'id' | 'pending'>, initial: ApiObject[], replay: HistoryEntry[] = []): string {
  const s = k8sSlice(ctx);
  const id = `w${ctx.nextId('k8s.watch')}`;
  const full: WatchSubscription = { ...sub, id, pending: [] };
  full.pending = initial.filter((o) => watchMatcher(full, o)).map((o) => ({ type: 'ADDED', object: o }));
  for (const e of replay) {
    const ev = eventFor(full, e.type, e.object, e.old);
    if (ev) full.pending.push({ type: ev, object: e.object, ...(ev === 'MODIFIED' && e.old ? { old: e.old } : {}) });
  }
  put(s.watches, id, full);
  if (full.pending.length > 0) ctx.publish(watchTopic(id));
  return id;
}

/** Removes and returns the pending events of a subscription, oldest first. */
export function takeEvents(ctx: Ctx, id: string): WatchEvent[] {
  const s = k8sSlice(ctx);
  const sub = s.watches[id];
  if (!sub || sub.pending.length === 0) return [];
  put(s.watches, id, { ...sub, pending: [] });
  return sub.pending;
}

export function closeSubscription(ctx: Ctx, id: string): void {
  remove(k8sSlice(ctx).watches, id);
}

export function rangeGet(d: EtcdData, key: string): Json | undefined {
  return d.ranges[key];
}

/** Writes an allocator range; like any etcd write it takes a revision. */
export function rangePut(d: EtcdData, key: string, value: Json): void {
  d.revision += 1;
  put(d.ranges, key, value);
}

export { compareCodeUnits };
