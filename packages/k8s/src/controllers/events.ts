// The events.k8s.io/v1 event recorder: client-go's `tools/events` broadcaster and recorder, used by
// kube-scheduler (`fwk.EventRecorder().Eventf(pod, nil, type, reason, action, note)`). Unlike the
// legacy recorder (record.ts) it has no correlator: it keeps a cache of "isomorphic" events and
// turns a repeated event into a Series, written once at its second occurrence and then only by
// the broadcaster's periodic work.
//
// upstream: staging/src/k8s.io/client-go/tools/events/event_recorder.go (eventf, makeEvent),
// event_broadcaster.go (recordToSink, recordEvent, createPatchBytesForSeries, getKey,
// finishSeries, refreshExistingEventSeries, StartRecordingToSinkWithContext, EventSinkImpl,
// NewRecorder), tools/record/util/util.go (ValidateEventType, IsKeyNotFoundError,
// GenerateEventName), tools/reference/ref.go GetReference (record.ts objectReference).
//
// Ported: the event body, the isomorphic key, Series creation and counting, which occurrence is
// written and how (create; patch with fallback to create on 404), finishing a series 6 minutes
// after its last observation, refreshing every series every 30 minutes, dropping singletons from
// the cache after 6 minutes, and which failures abandon an event.
//
// Modeled, not ported (docs/decisions.md D-054):
// - The broadcaster is asynchronous; here an event is cached and written at the virtual instant
//   it is recorded. Event names take the virtual clock in nanoseconds made unique per recorder
//   (record.ts nextNano), eventTime and lastObservedTime the same instant at millisecond precision.
// - `wait.UntilWithContext` runs finishSeries every 6 minutes and refreshExistingEventSeries every
//   30 minutes from the broadcaster's start (`startEventsBroadcaster`, or the first event). Here
//   the ticks are exactly on that grid, never drifting; a kernel event is pending only while a
//   series is cached. Singletons are dropped lazily, as of the latest tick, whenever the
//   broadcaster next does anything, which is equivalent. Work of a tick at the same instant as an
//   event goes first; where both loops tick (every 30 minutes) finishSeries goes before refresh.
// - The cache is a Go map iterated in random order; here keys are visited in code-unit order.
// - The series patch is a strategic merge patch upstream; the pipeline takes JSON merge patches
//   only, and for `{"series":{…}}` both give the same object (D-052).
// - attemptRecording retries transport errors (12 tries, 10 s ± 25 % apart) and an AlreadyExists
//   answer to a series' fallback create. The client has no transport yet and the patch and create
//   happen at one instant, so neither can occur; nothing is retried.

import { keys, put, type Ctx, type HandlerSpec, type Millis } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { microTimeOf } from '../apimachinery/time.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { k8sSlice, type ApiObject } from '../apiserver/store.ts';
import type { ApiResponse, UserInfo } from '../apiserver/types.ts';
import { createClient, type Client } from '../client/client.ts';
import { eventName, nextNano, objectReference } from './record.ts';

// upstream: event_broadcaster.go const finishTime, refreshTime.
export const FINISH_TIME_MS = 6 * 60_000;
export const REFRESH_TIME_MS = 30 * 60_000;

export const EVENTS_TICK_EVENT = 'k8s.events.tick';

const EVENTS_RESOURCE = 'events.k8s.io/v1/events';

/** An entry of the broadcaster's eventCache. */
export interface CachedEvent {
  /**
   * The events.k8s.io/v1 Event as cached, without `series`: as recorded, or as the server
   * returned it after a refresh.
   */
  event: JsonObject;
  /** Its eventTime, virtual ms. */
  eventTime: Millis;
  series?: { count: number; lastObserved: Millis };
}

/** The state of one eventBroadcasterImpl and its sink. */
export interface EventBroadcasterState {
  /** When it started recording to its sink: the phase of its periodic work. */
  start: Millis;
  /** The sink's client, rebuilt for the periodic writes. */
  server: ApiServerConfig;
  user?: UserInfo;
  /** eventCache, by isomorphic key. */
  cache: Record<string, CachedEvent>;
  /** Last event-name timestamp, ns since the epoch, as a decimal string. */
  lastNano: string;
  /** The pending tick, while a series is cached. */
  tick?: { event: string; at: Millis };
  /** Shut down: events are dropped until it starts again. Kept for `lastNano`. */
  stopped?: true;
}

export interface EventsRecorderRef {
  /** Key of the broadcaster state: one per component (`kube-scheduler`). */
  recorder: string;
  /** NewRecorder's name: `default-scheduler`. */
  reportingController: string;
  /** `<reportingController>-<hostname>`: `default-scheduler-controlplane`. */
  reportingInstance: string;
  /** The sink's client (the component's identity). */
  client: Client;
  /** The trace record of the work that records the event (the scheduler's sync), for its causes. */
  cause?: number;
}

const s = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const traceSource = (recorder: string): string => `k8s.events/${recorder}`;

function newState(ctx: Ctx, client: Client): EventBroadcasterState {
  return { start: ctx.now, server: client.server, ...(client.user ? { user: client.user } : {}), cache: {}, lastNano: '0' };
}

function copyState(st: EventBroadcasterState): EventBroadcasterState {
  return { ...st, cache: { ...st.cache } };
}

/**
 * NewBroadcaster + StartRecordingToSinkWithContext: the broadcaster starts now with an empty
 * cache, which sets the phase of its periodic work. Without it a broadcaster starts with its first
 * event. Starting a running broadcaster does nothing.
 */
export function startEventsBroadcaster(ctx: Ctx, recorder: string, client: Client): void {
  const t = k8sSlice(ctx).eventBroadcasters;
  const st = t[recorder];
  if (st && !st.stopped) return;
  // A restarted process keeps the event-name clock monotonic, as a real clock is.
  put(t, recorder, { ...newState(ctx, client), lastNano: st?.lastNano ?? '0' });
}

/**
 * Shutdown: the cache and unwritten series counts are lost, the periodic work stops, and events
 * recorded afterwards are dropped (watch.Broadcaster.Action: "broadcaster already stopped") until
 * the broadcaster starts again.
 */
export function stopEventsBroadcaster(ctx: Ctx, recorder: string): void {
  const t = k8sSlice(ctx).eventBroadcasters;
  const st = t[recorder];
  if (!st || st.stopped) return;
  if (st.tick) ctx.cancel(st.tick.event);
  put(t, recorder, { start: st.start, server: st.server, ...(st.user ? { user: st.user } : {}), cache: {}, lastNano: st.lastNano, stopped: true });
}

/** getKey: everything but the note, the names and the times. */
function isomorphicKey(e: JsonObject): string {
  const ref = (v: Json | undefined): string[] => {
    const r = (v ?? {}) as JsonObject;
    // corev1.ObjectReference fields, compared as a Go struct.
    return [s(r.kind), s(r.namespace), s(r.name), s(r.uid), s(r.apiVersion), s(r.resourceVersion), s(r.fieldPath)];
  };
  return JSON.stringify([s(e.type), s(e.action), s(e.reason), s(e.reportingController), s(e.reportingInstance), ...ref(e.regarding), ...ref(e.related)]);
}

/** EventRecorder.Eventf: builds the event and hands it to the broadcaster (recordToSink). */
export function eventf(ctx: Ctx, rec: EventsRecorderRef, regarding: ApiObject, related: ApiObject | undefined, type: 'Normal' | 'Warning', reason: string, action: string, note: string): void {
  const refRegarding = objectReference(regarding);
  const refRelated = related ? objectReference(related) : undefined;
  // util.ValidateEventType: anything else is logged and dropped.
  if ((type as string) !== 'Normal' && (type as string) !== 'Warning') {
    ctx.trace({ source: traceSource(rec.recorder), kind: 'event.invalid', message: `Unsupported event type ${JSON.stringify(type)}: event ${reason} about ${s(refRegarding.kind)} ${s(refRegarding.name)} dropped`, data: { type, reason } });
    return;
  }
  const t = k8sSlice(ctx).eventBroadcasters;
  const prev = t[rec.recorder];
  if (prev?.stopped) {
    ctx.trace({ source: traceSource(rec.recorder), kind: 'event.dropped', message: `broadcaster already stopped: event ${reason} about ${s(refRegarding.kind)} ${s(refRegarding.name)} dropped`, data: { reason } });
    return;
  }
  const st = prev ? copyState(prev) : newState(ctx, rec.client);
  st.server = rec.client.server;
  if (rec.client.user) st.user = rec.client.user;
  else delete st.user;
  catchUp(ctx, rec.recorder, st);

  const now = ctx.now;
  // makeEvent
  const event: JsonObject = {
    apiVersion: 'events.k8s.io/v1',
    kind: 'Event',
    metadata: { name: eventName(s(refRegarding.name), nextNano(st, now), ctx), namespace: s(refRegarding.namespace) || 'default' },
    eventTime: microTimeOf(now),
    reportingController: rec.reportingController,
    reportingInstance: rec.reportingInstance,
    action,
    reason,
    regarding: refRegarding,
    ...(refRelated ? { related: refRelated } : {}),
    note,
    type,
  };

  // recordToSink
  const key = isomorphicKey(event);
  const cached = st.cache[key];
  let toRecord: CachedEvent | undefined;
  if (cached?.series) {
    // A running series: counted, written later by finishSeries or refreshExistingEventSeries.
    st.cache[key] = { ...cached, series: { count: cached.series.count + 1, lastObserved: now } };
    ctx.trace({ source: traceSource(rec.recorder), kind: 'event.series', message: `event ${reason} about ${s(refRegarding.kind)} ${s(refRegarding.name)} counted in its series (${cached.series.count + 1})`, data: { reason, count: cached.series.count + 1 } });
  } else if (cached) {
    // The second occurrence starts a series, written now.
    toRecord = { ...cached, series: { count: 2, lastObserved: now } };
    st.cache[key] = toRecord;
  } else {
    toRecord = { event, eventTime: now };
    st.cache[key] = toRecord;
  }
  reschedule(ctx, rec.recorder, st);
  put(t, rec.recorder, st);
  // attemptRecording: the server's answer does not go into the cache.
  if (toRecord && recordEvent(ctx, rec.recorder, rec.client, toRecord)) {
    const m = (toRecord.event.metadata ?? {}) as JsonObject;
    ctx.trace({
      source: traceSource(rec.recorder),
      kind: 'event.recorded',
      ...(rec.cause !== undefined ? { causes: [rec.cause] } : {}),
      subject: `${s(m.namespace)}/${s(m.name)}`,
      message: `${type} ${reason} about ${s(refRegarding.kind)} ${s(refRegarding.namespace) ? `${s(refRegarding.namespace)}/` : ''}${s(refRegarding.name)}: ${note}`,
      data: {
        api: 'events.k8s.io/v1',
        namespace: s(m.namespace),
        name: s(m.name),
        type,
        reason,
        message: note,
        regarding: { kind: s(refRegarding.kind), namespace: s(refRegarding.namespace), name: s(refRegarding.name), uid: s(refRegarding.uid), ...(s(refRegarding.fieldPath) ? { fieldPath: s(refRegarding.fieldPath) } : {}) },
        reportingController: rec.reportingController,
        reportingInstance: rec.reportingInstance,
        count: toRecord.series?.count ?? 1,
      },
    });
  }
}

/** recordEvent: a series is patched (created when gone), a new event created. */
function recordEvent(ctx: Ctx, recorder: string, client: Client, entry: CachedEvent): JsonObject | undefined {
  const events = client.resource(EVENTS_RESOURCE);
  const meta = (entry.event.metadata ?? {}) as JsonObject;
  // EventSinkImpl refuses an empty namespace; makeEvent never leaves it empty.
  const ns = s(meta.namespace);
  const name = s(meta.name);
  const series: JsonObject | undefined = entry.series ? { count: entry.series.count, lastObservedTime: microTimeOf(entry.series.lastObserved) } : undefined;
  let res: ApiResponse | undefined;
  if (series) {
    // createPatchBytesForSeries: the two-way merge patch from the event without its series to the
    // event is exactly the series.
    res = events.patch(ns, name, { series });
  }
  // Update can fail because the event may have been removed and it no longer exists.
  if (!res || (!res.ok && res.code === 404)) {
    const m = { ...meta };
    delete m.resourceVersion;
    res = events.create(ns, { ...entry.event, metadata: m, ...(series ? { series } : {}) });
  }
  if (res.ok) return res.object as JsonObject;
  // A StatusError (Invalid, Forbidden, AlreadyExists for a new event) abandons the event.
  const why = 'status' in res ? s(res.status.message as Json) : res.notSimulated;
  ctx.trace({ source: traceSource(recorder), kind: 'event.rejected', message: `Server rejected event ${ns}/${name} (will not retry!): ${res.code} ${why}`, data: { namespace: ns, name, code: res.code } });
  return undefined;
}

/** The latest tick of the periodic work at or before `t`. */
function tickAtOrBefore(st: EventBroadcasterState, t: Millis): Millis {
  return st.start + Math.floor((t - st.start) / FINISH_TIME_MS) * FINISH_TIME_MS;
}

/**
 * Brings the broadcaster up to now: the pending tick, if due, then the singletons the latest
 * tick would have dropped.
 */
function catchUp(ctx: Ctx, recorder: string, st: EventBroadcasterState): void {
  if (st.tick && st.tick.at <= ctx.now) {
    const at = st.tick.at;
    ctx.cancel(st.tick.event);
    delete st.tick;
    runTick(ctx, recorder, st, at);
  }
  // finishSeries: a singleton whose eventTime is more than finishTime before a tick is dropped.
  const last = tickAtOrBefore(st, ctx.now);
  for (const k of keys(st.cache)) {
    const e = st.cache[k] as CachedEvent;
    if (!e.series && e.eventTime < last - FINISH_TIME_MS) delete st.cache[k];
  }
}

/** The periodic work of one tick: finishSeries, and refreshExistingEventSeries on its grid. */
function runTick(ctx: Ctx, recorder: string, st: EventBroadcasterState, at: Millis): void {
  const client = createClient(ctx, st.server, st.user);
  // finishSeries: a series not observed for finishTime gets its final count written.
  for (const k of keys(st.cache)) {
    const e = st.cache[k] as CachedEvent;
    if (e.series) {
      if (e.series.lastObserved < at - FINISH_TIME_MS) {
        tracePeriodic(ctx, recorder, 'finish', e);
        recordEvent(ctx, recorder, client, e);
        delete st.cache[k];
      }
    } else if (e.eventTime < at - FINISH_TIME_MS) {
      delete st.cache[k];
    }
  }
  if ((at - st.start) % REFRESH_TIME_MS !== 0) return;
  // refreshExistingEventSeries: every series is written again (the event's TTL), and the cache
  // keeps what the server returned.
  for (const k of keys(st.cache)) {
    const e = st.cache[k] as CachedEvent;
    if (!e.series) continue;
    tracePeriodic(ctx, recorder, 'refresh', e);
    const saved = recordEvent(ctx, recorder, client, e);
    if (saved) {
      const event = { ...saved };
      delete event.series;
      st.cache[k] = { ...e, event };
    }
  }
}

function tracePeriodic(ctx: Ctx, recorder: string, why: 'finish' | 'refresh', e: CachedEvent): void {
  const m = (e.event.metadata ?? {}) as JsonObject;
  ctx.trace({
    source: traceSource(recorder),
    kind: `event.series-${why}`,
    message: `${why === 'finish' ? 'finishing' : 'refreshing'} the series of event ${s(m.namespace)}/${s(m.name)} (${s(e.event.reason)}), count ${e.series?.count ?? 0}`,
    data: { namespace: s(m.namespace), name: s(m.name), count: e.series?.count ?? 0 },
  });
}

/** Keeps one tick pending, at the next tick of the grid, while a series is cached. */
function reschedule(ctx: Ctx, recorder: string, st: EventBroadcasterState): void {
  const hasSeries = keys(st.cache).some((k) => (st.cache[k] as CachedEvent).series !== undefined);
  const at = hasSeries ? tickAtOrBefore(st, ctx.now) + FINISH_TIME_MS : undefined;
  if (st.tick && st.tick.at === at) return;
  if (st.tick) ctx.cancel(st.tick.event);
  delete st.tick;
  if (at !== undefined) st.tick = { event: ctx.schedule(at - ctx.now, EVENTS_TICK_EVENT, { recorder }), at };
}

/** The kernel handlers of the events.k8s.io broadcaster, registered by the k8s plugin. */
export const eventsHandlers: HandlerSpec[] = [
  {
    type: EVENTS_TICK_EVENT,
    handle(ctx, payload) {
      const { recorder } = payload as { recorder: string };
      const t = k8sSlice(ctx).eventBroadcasters;
      const prev = t[recorder];
      if (!prev || prev.stopped) return;
      const st = copyState(prev);
      catchUp(ctx, recorder, st);
      reschedule(ctx, recorder, st);
      put(t, recorder, st);
    },
  },
];
