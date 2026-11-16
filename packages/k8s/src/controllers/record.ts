// The core/v1 event recorder of a controller: client-go's legacy recorder with its EventCorrelator
// (aggregation, de-duplication with counts, the per-object spam filter), writing through the
// controller's client. Each controller has its own broadcaster upstream
// (pkg/controller/deployment/deployment_controller.go NewDeploymentController:
// record.NewBroadcaster), so each has its own correlator state, kept here in world data.
//
// upstream: staging/src/k8s.io/client-go/tools/record/event.go (makeEvent, generateEvent,
// recordToSink, recordEvent), events_cache.go (EventCorrelator, EventAggregator, eventLogger,
// EventSourceObjectSpamFilter), util/util.go (GenerateEventName).
//
// Modeled, not ported: the LRU caches (4096 entries each) evict the least recently used entry,
// tracked with a use counter; Go's `sets.PopAny` takes a random element, here the oldest; the
// recorder's broadcaster is asynchronous, here the write happens in the sync that recorded the
// event, at the same virtual instant; event names take the virtual clock in nanoseconds, made
// unique per recorder by counting up within a millisecond (a real clock never repeats).

import { put, type Ctx, type Millis } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { timeOf } from '../apimachinery/time.ts';
import { isDNS1123Subdomain } from '../apimachinery/validation/names.ts';
import { k8sSlice, type ApiObject } from '../apiserver/store.ts';
import type { Client } from '../client/client.ts';
import type { EventType } from './types.ts';

const MAX_LRU_CACHE_ENTRIES = 4096;
const DEFAULT_AGGREGATE_MAX_EVENTS = 10;
const DEFAULT_AGGREGATE_INTERVAL_MS = 600_000;
const DEFAULT_SPAM_BURST = 25;
const DEFAULT_SPAM_QPS = 1 / 300;

interface EventLog {
  count: number;
  firstTimestamp: string;
  name: string;
  resourceVersion: string;
  /** LRU use stamp. */
  u: number;
}

interface AggregateRecord {
  localKeys: string[];
  /** Virtual ms of the last similar event. */
  last: Millis;
  u: number;
}

interface SpamRecord {
  tokens: number;
  last: Millis;
  u: number;
}

export interface RecorderState {
  logs: Record<string, EventLog>;
  aggregates: Record<string, AggregateRecord>;
  spam: Record<string, SpamRecord>;
  /** Use counter for the LRU caches. */
  tick: number;
  /** Last event-name timestamp, ns since the epoch, as a decimal string. */
  lastNano: string;
}

export interface RecorderRef {
  /** Key of the recorder state: the controller id. */
  recorder: string;
  /** EventSource.Component. */
  component: string;
  /** EventSource.Host: empty for controllers. */
  host?: string;
  client: Client;
}

function emptyState(): RecorderState {
  return { logs: {}, aggregates: {}, spam: {}, tick: 0, lastNano: '0' };
}

/** ref.GetReference: the involvedObject of an event about `obj`. */
export function objectReference(obj: ApiObject): JsonObject {
  const m = (obj.metadata ?? {}) as JsonObject;
  const ref: JsonObject = {};
  if (typeof obj.kind === 'string') ref.kind = obj.kind;
  if (typeof m.namespace === 'string' && m.namespace !== '') ref.namespace = m.namespace;
  if (typeof m.name === 'string') ref.name = m.name;
  if (typeof m.uid === 'string') ref.uid = m.uid;
  if (typeof obj.apiVersion === 'string') ref.apiVersion = obj.apiVersion;
  if (typeof m.resourceVersion === 'string') ref.resourceVersion = m.resourceVersion;
  return ref;
}

const s = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

/** getEventKey: source, involvedObject, type, reason, message. */
function eventKey(e: JsonObject): string {
  const src = (e.source ?? {}) as JsonObject;
  const io = (e.involvedObject ?? {}) as JsonObject;
  return [s(src.component), s(src.host), s(io.kind), s(io.namespace), s(io.name), s(io.fieldPath), s(io.uid), s(io.apiVersion), s(e.type), s(e.reason), s(e.message)].join('');
}

/** getSpamKey: source, involvedObject, type. */
function spamKey(e: JsonObject): string {
  const src = (e.source ?? {}) as JsonObject;
  const io = (e.involvedObject ?? {}) as JsonObject;
  return [s(src.component), s(src.host), s(io.kind), s(io.namespace), s(io.name), s(io.uid), s(io.apiVersion), s(e.type)].join('');
}

/** EventAggregatorByReasonFunc: (aggregateKey, localKey). */
function aggregateKeys(e: JsonObject): [string, string] {
  const src = (e.source ?? {}) as JsonObject;
  const io = (e.involvedObject ?? {}) as JsonObject;
  return [
    [s(src.component), s(src.host), s(io.kind), s(io.namespace), s(io.name), s(io.uid), s(io.apiVersion), s(e.type), s(e.reason), s(e.reportingComponent), s(e.reportingInstance)].join(''),
    s(e.message),
  ];
}

/** Keeps a cache at MAX_LRU_CACHE_ENTRIES by dropping the least recently used entry. */
function evict<V extends { u: number }>(cache: Record<string, V>): void {
  const ks = Object.keys(cache);
  if (ks.length <= MAX_LRU_CACHE_ENTRIES) return;
  let oldest = ks[0] as string;
  for (const k of ks) if ((cache[k] as V).u < (cache[oldest] as V).u) oldest = k;
  delete cache[oldest];
}

/** A unique event-name timestamp: the clock in ns, counted up within one virtual millisecond. */
function nextNano(st: RecorderState, now: Millis): bigint {
  let n = BigInt(now) * 1_000_000n;
  const last = BigInt(st.lastNano);
  if (n <= last) n = last + 1n;
  st.lastNano = n.toString();
  return n;
}

/** EventRecorder.Event: builds the event, correlates it and writes it (create or patch). */
export function recordEvent(ctx: Ctx, rec: RecorderRef, obj: ApiObject, type: EventType, reason: string, message: string): void {
  const slice = k8sSlice(ctx);
  // A working copy; written back frozen at the end.
  const st: RecorderState = structuredCopy(slice.recorders[rec.recorder] ?? emptyState());
  const now = ctx.now;
  const t = timeOf(now);
  const ref = objectReference(obj);
  const namespace = s(ref.namespace) || 'default';
  const source: JsonObject = { component: rec.component, ...(rec.host ? { host: rec.host } : {}) };
  // makeEvent + generateEvent
  let event: JsonObject = {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: eventName(s(ref.name), nextNano(st, now), ctx), namespace },
    involvedObject: ref,
    reason,
    message,
    source,
    firstTimestamp: t,
    lastTimestamp: t,
    count: 1,
    type,
    eventTime: null,
    reportingComponent: rec.component,
    reportingInstance: rec.host ?? '',
  };

  // EventAggregate
  const evKey = eventKey(event);
  const [aggKey, localKey] = aggregateKeys(event);
  let agg = st.aggregates[aggKey];
  if (!agg || now - agg.last > DEFAULT_AGGREGATE_INTERVAL_MS) agg = { localKeys: [], last: 0, u: 0 };
  const localKeys = agg.localKeys.includes(localKey) ? [...agg.localKeys] : [...agg.localKeys, localKey];
  st.tick += 1;
  agg = { localKeys, last: now, u: st.tick };
  st.aggregates[aggKey] = agg;
  evict(st.aggregates);
  let cacheKey = evKey;
  if (localKeys.length >= DEFAULT_AGGREGATE_MAX_EVENTS) {
    // PopAny (modeled: the oldest), shared with the cached record as Go's map is.
    st.aggregates[aggKey] = { ...agg, localKeys: localKeys.slice(1) };
    event = {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: eventName(s(ref.name), nextNano(st, now), ctx), namespace },
      involvedObject: ref,
      reason,
      message: `(combined from similar events): ${message}`,
      source,
      firstTimestamp: t,
      lastTimestamp: t,
      count: 1,
      type,
      eventTime: null,
      reportingComponent: '',
      reportingInstance: '',
    };
    cacheKey = aggKey;
  }

  // eventObserve
  const last = st.logs[cacheKey];
  let patch: JsonObject | undefined;
  if (last && last.count > 0) {
    const meta = { ...(event.metadata as JsonObject), name: last.name, resourceVersion: last.resourceVersion };
    event = { ...event, metadata: meta, firstTimestamp: last.firstTimestamp, count: last.count + 1 };
    // CreateTwoWayMergePatch from the event with count 0, lastTimestamp at the epoch and no
    // message to the event: exactly these three fields differ.
    patch = { count: event.count as number, lastTimestamp: t, message: event.message as string };
  }
  st.tick += 1;
  st.logs[cacheKey] = { count: event.count as number, firstTimestamp: s(event.firstTimestamp), name: s((event.metadata as JsonObject).name), resourceVersion: s((event.metadata as JsonObject).resourceVersion), u: st.tick };
  evict(st.logs);

  // EventSourceObjectSpamFilter (golang.org/x/time/rate token bucket, full at first use)
  const sk = spamKey(event);
  const prev = st.spam[sk];
  let tokens = prev ? Math.min(DEFAULT_SPAM_BURST, prev.tokens + ((now - prev.last) / 1000) * DEFAULT_SPAM_QPS) : DEFAULT_SPAM_BURST;
  const accept = tokens >= 1;
  if (accept) tokens -= 1;
  st.tick += 1;
  st.spam[sk] = { tokens, last: now, u: st.tick };
  evict(st.spam);
  if (!accept) {
    put(slice.recorders, rec.recorder, st);
    ctx.trace({ source: `k8s.events/${rec.component}`, kind: 'event.filtered', message: `event ${reason} about ${s(ref.kind)} ${s(ref.name)} dropped by the spam filter`, data: { reason, message } });
    return;
  }

  // recordEvent: patch an existing event, or create (also when the patch finds none).
  const events = rec.client.resource('v1/events');
  let res = patch ? events.patch(namespace, s((event.metadata as JsonObject).name), patch) : undefined;
  if (!res || (!res.ok && res.code === 404)) {
    const meta = { ...(event.metadata as JsonObject) };
    delete meta.resourceVersion;
    res = events.create(namespace, { ...event, metadata: meta });
  }
  if (res.ok) {
    // UpdateState: keyed by the full event key of what the server returned.
    const saved = res.object as JsonObject;
    const sm = (saved.metadata ?? {}) as JsonObject;
    st.tick += 1;
    st.logs[eventKey(saved)] = { count: typeof saved.count === 'number' ? saved.count : 0, firstTimestamp: s(saved.firstTimestamp), name: s(sm.name), resourceVersion: s(sm.resourceVersion), u: st.tick };
    evict(st.logs);
  }
  // A rejected event is not retried (AlreadyExists, a terminating namespace, invalid); transport
  // errors would be retried every 10 s, up to 12 tries, once the client has a transport (07a).
  put(slice.recorders, rec.recorder, st);
}

/** GenerateEventName: `<name>.<ns in hex>`, or a UUID when that is not a valid name. */
function eventName(refName: string, nano: bigint, ctx: Ctx): string {
  const name = `${refName}.${nano.toString(16)}`;
  if (isDNS1123Subdomain(name).length === 0) return name;
  // uuid.New(): a version 4 UUID.
  const r = ctx.random('k8s.uuid');
  const hex = (n: number) => Array.from({ length: n }, () => r.int(16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + r.int(4)).toString(16)}${hex(3)}-${hex(12)}`;
}

function structuredCopy(st: RecorderState): RecorderState {
  return { logs: { ...st.logs }, aggregates: { ...st.aggregates }, spam: { ...st.spam }, tick: st.tick, lastNano: st.lastNano };
}
