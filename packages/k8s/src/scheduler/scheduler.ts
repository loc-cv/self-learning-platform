// kube-scheduler with the default profile, on the controller runtime (docs/ARCHITECTURE.md §4.3).
//
// Queue. The runtime's queue is the active queue: one key per Pod, due after the scheduler's
// latency. A Pod that fails is held as unschedulable (in the controller's data, with the plugins
// that rejected it) and comes back when
//   - a watch event makes it worth retrying: the queueing hint of any plugin that rejected it says
//     Queue (hints.ts), or the Pod itself was updated in a way that matters;
//   - or the leftover flush moves it: every 30 s the queue moves Pods that have been unschedulable
//     for longer than 5 minutes (podMaxInUnschedulablePodsDuration).
// A retried Pod goes to the backoff queue (1 s doubling per attempt, at most 10 s), from which it
// is popped early when the active queue is empty (SchedulerPopFromBackoffQ, on by default). The
// simulator's active queue is empty whenever nothing else waits, so a retried Pod is scheduled after
// the latency; with other Pods queued, it waits for its backoff to end.
//
// upstream: pkg/scheduler/schedule_one.go (ScheduleOne, schedulingCycle, handleSchedulingFailure,
// truncateMessage, updatePod, bind and the Scheduled event), eventhandlers.go (which Pods the
// scheduler queues: unassigned, its scheduler name, not terminating), backend/queue/
// scheduling_queue.go (DefaultPodInitialBackoffDuration 1 s, DefaultPodMaxBackoffDuration 10 s,
// DefaultPodMaxInUnschedulablePodsDuration 5 min, flushUnschedulablePodsLeftover every 30 s,
// isPodWorthRequeuing, isPodUpdated), pkg/api/v1/pod/util.go UpdatePodCondition (no write when the
// condition is unchanged) and CalculatePodConditionObservedGeneration.

import type { Ctx, Millis } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { cloneJson, isObject } from '../apimachinery/json.ts';
import { timeOf } from '../apimachinery/time.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { eventf, startEventsBroadcaster, stopEventsBroadcaster, type EventsRecorderRef } from '../controllers/events.ts';
import { isRunning, startController, stopController } from '../controllers/runtime.ts';
import { createClient } from '../client/client.ts';
import type { ControllerEvent, ControllerSpec, Reader, SyncCtx, SyncResult } from '../controllers/types.ts';
import { schedulePod, type CycleResult, type NodeVerdict } from './cycle.ts';
import { isPodUpdated, worthRequeuing, type HintEvent } from './hints.ts';
import { isTerminal, snapshot } from './snapshot.ts';
import { metaOf, nameOf, namespaceOf, specOf, statusOf, str, uidOf } from './util.ts';

export const KUBE_SCHEDULER = 'kube-scheduler';
/** The profile's scheduler name: Pods with another spec.schedulerName are not ours. */
export const DEFAULT_SCHEDULER_NAME = 'default-scheduler';
const CONTROLLER_NAME = 'scheduler';

export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 10_000;
export const MAX_IN_UNSCHEDULABLE_MS = 5 * 60_000;
export const FLUSH_INTERVAL_MS = 30_000;
/** events.k8s.io validation.NoteLengthLimit. */
const NOTE_LENGTH_LIMIT = 1024;
/**
 * From a watch event to the scheduling attempt. The informer delivers within milliseconds and a
 * cycle for a handful of nodes takes about a millisecond; 5 ms is the simulator's figure, the same
 * reaction time the controllers use (D-047).
 */
export const SCHEDULER_LATENCY_MS = 5;

interface Unschedulable {
  uid: string;
  plugins: string[];
  /** When it became unschedulable (the flush timestamp). */
  since: Millis;
}

interface SchedulerData {
  /** When this scheduler process started: the phase of the 30 s flush ticks. */
  started: Millis;
  /** Pods held as unschedulable, by `namespace/name`. */
  unschedulable: Record<string, Unschedulable>;
  /** Scheduling attempts per Pod key, for the backoff. */
  attempts: Record<string, number>;
}

const dataOf = (d: Readonly<Record<string, Json>>): SchedulerData => {
  const s = d as unknown as Partial<SchedulerData>;
  return { started: s.started ?? 0, unschedulable: { ...(s.unschedulable ?? {}) }, attempts: { ...(s.attempts ?? {}) } };
};

const podKey = (p: ApiObject): string => `${namespaceOf(p)}/${nameOf(p)}`;

/** upstream: eventhandlers.go — an unassigned Pod for this profile that is not being deleted. */
export function isOurs(p: ApiObject): boolean {
  const spec = specOf(p);
  const name = str(spec.schedulerName) || DEFAULT_SCHEDULER_NAME;
  return str(spec.nodeName) === '' && name === DEFAULT_SCHEDULER_NAME && metaOf(p).deletionTimestamp === undefined && !isTerminal(p);
}

function requeueFor(d: SchedulerData, e: HintEvent, read: Reader): string[] {
  const out: string[] = [];
  for (const key of Object.keys(d.unschedulable).sort()) {
    const u = d.unschedulable[key] as Unschedulable;
    const [ns, name] = key.split('/') as [string, string];
    const pod = read.get('v1/pods', ns, name);
    if (!pod || uidOf(pod) !== u.uid) continue;
    if (worthRequeuing(pod, u.plugins, e).queue) out.push(key);
  }
  return out;
}

function podKeys(ev: ControllerEvent, read: Reader, data: Readonly<Record<string, Json>>): string[] {
  const d = dataOf(data);
  const p = ev.object;
  const key = podKey(p);
  const old = ev.old;
  // An assigned Pod that went away (deleted, or terminal) frees its node's resources and ports.
  const wasAssigned = old ? str(specOf(old).nodeName) !== '' && !isTerminal(old) : false;
  if (ev.type === 'DELETED') {
    const out = d.unschedulable[key] ? [key] : [];
    if (str(specOf(p).nodeName) !== '') out.push(...requeueFor(d, { kind: 'AssignedPodDelete', pod: p }, read));
    return out;
  }
  if (ev.type === 'MODIFIED' && wasAssigned && isTerminal(p)) return requeueFor(d, { kind: 'AssignedPodDelete', pod: p }, read);
  if (!isOurs(p)) return d.unschedulable[key] ? [key] : [];
  const held = d.unschedulable[key];
  if (held && held.uid === uidOf(p)) {
    if (ev.type !== 'MODIFIED' || !old || !isPodUpdated(old, p)) return [];
    return worthRequeuing(p, held.plugins, { kind: 'TargetPodUpdate', old, pod: p }).queue ? [key] : [];
  }
  return [key];
}

function nodeKeys(ev: ControllerEvent, read: Reader, data: Readonly<Record<string, Json>>): string[] {
  const d = dataOf(data);
  if (ev.type === 'ADDED') return requeueFor(d, { kind: 'NodeAdd', node: ev.object }, read);
  if (ev.type === 'MODIFIED' && ev.old) return requeueFor(d, { kind: 'NodeUpdate', old: ev.old, node: ev.object }, read);
  return [];
}

/** The first flush tick at or after `at`, on the 30 s grid from the process start. */
function flushTime(started: Millis, at: Millis): Millis {
  const k = Math.ceil((at - started) / FLUSH_INTERVAL_MS);
  return started + Math.max(1, k) * FLUSH_INTERVAL_MS;
}

function backoff(attempts: number): Millis {
  let d = INITIAL_BACKOFF_MS;
  for (let i = 1; i < attempts; i++) {
    d *= 2;
    if (d > MAX_BACKOFF_MS) return MAX_BACKOFF_MS;
  }
  return d;
}

function setData(c: SyncCtx, d: SchedulerData): void {
  // The world freezes what it stores: hand it copies, keep mutating `d`.
  c.setData('unschedulable', { ...d.unschedulable } as unknown as Json);
  c.setData('attempts', { ...d.attempts } as unknown as Json);
}

export function truncateMessage(message: string): string {
  if (message.length <= NOTE_LENGTH_LIMIT) return message;
  const suffix = ' ...';
  return message.slice(0, NOTE_LENGTH_LIMIT - suffix.length) + suffix;
}

function recorder(c: SyncCtx): EventsRecorderRef {
  const host = (c.data().host as string | undefined) ?? 'controlplane';
  return { recorder: KUBE_SCHEDULER, reportingController: DEFAULT_SCHEDULER_NAME, reportingInstance: `${DEFAULT_SCHEDULER_NAME}-${host}`, client: c.client, cause: c.syncId };
}

/**
 * One `scheduler.filter` record per node: the plugin that rejected it and its reasons, the very
 * strings FitError.Error counts in the FailedScheduling message (cycle.ts fitErrorMessage). The
 * decision record that follows names these records in its causes. Returns their ids.
 */
function traceVerdicts(c: SyncCtx, key: string, pod: ApiObject, verdicts: NodeVerdict[]): number[] {
  return verdicts.map((v) => {
    const msg = v.status.code === 'Success' ? `${key}: node ${v.node} passed every filter` : `${key}: node ${v.node} rejected by ${v.plugin ?? 'PreFilter'}: ${v.status.reasons.join(', ')} (${v.status.code})`;
    return c.trace('scheduler.filter', msg, { ...podData(pod), node: v.node, ...(v.plugin ? { plugin: v.plugin } : {}), code: v.status.code, reasons: v.status.reasons }, key);
  });
}

/** The Pod a scheduling record is about: `pod` is the queue key, the rest its coordinates. */
function podData(pod: ApiObject): JsonObject {
  return { pod: podKey(pod), namespace: namespaceOf(pod), name: nameOf(pod), uid: uidOf(pod) };
}

function sync(c: SyncCtx, key: string): SyncResult {
  const d = dataOf(c.data());
  const [namespace, name] = key.split('/') as [string, string];
  const pod = c.get('v1/pods', namespace, name);
  if (!pod || !isOurs(pod)) {
    if (d.unschedulable[key] || d.attempts[key] !== undefined) {
      delete d.unschedulable[key];
      delete d.attempts[key];
      setData(c, d);
    }
    return { done: true };
  }
  // A retried Pod waits out its backoff unless nothing else is queued (PopFromBackoffQ).
  const attempts = d.attempts[key] ?? 0;
  const held = d.unschedulable[key];
  if (held) {
    delete d.unschedulable[key];
    setData(c, d);
  }

  const nodes = snapshot(c.list('v1/nodes'), c.list('v1/pods'));
  const random = c.ctx.random('k8s.scheduler.filter-order');
  const result: CycleResult & { victimsExist?: boolean } = schedulePod(pod, nodes, { order: (f) => (f.length > 1 ? random.shuffle(f) : f) });
  const verdictIds = traceVerdicts(c, key, pod, result.verdicts);

  if (result.kind === 'scheduled') {
    const scoreIds = result.scores.map((s) => c.trace('scheduler.score', `${key}: node ${s.node} scored ${s.total}`, { ...podData(pod), node: s.node, total: s.total, plugins: s.plugins as unknown as Json }, key));
    const res = c.client.request({
      verb: 'create', group: '', version: 'v1', resource: 'pods', subresource: 'binding', namespace, name,
      body: { apiVersion: 'v1', kind: 'Binding', metadata: { name, namespace, uid: uidOf(pod) }, target: { kind: 'Node', name: result.node } },
    });
    delete d.attempts[key];
    setData(c, d);
    if (!res.ok) {
      const why = 'status' in res ? String(res.status.message ?? '') : 'notSimulated' in res ? res.notSimulated : '';
      c.trace('scheduler.bind-failed', `${key}: binding to ${result.node} failed: ${res.code}`, { ...podData(pod), node: result.node, code: res.code, message: why }, key, [...verdictIds, ...scoreIds]);
      return { done: true };
    }
    c.trace('scheduler.bound', `${key}: bound to ${result.node} (${result.feasible} feasible of ${nodes.length})`, { ...podData(pod), node: result.node, feasible: result.feasible, nodes: nodes.length }, key, [...verdictIds, ...scoreIds]);
    eventf(c.ctx, recorder(c), pod, undefined, 'Normal', 'Scheduled', 'Binding', `Successfully assigned ${namespace}/${name} to ${result.node}`);
    return { done: true };
  }

  if (result.victimsExist) {
    c.ctx.gap({ kind: 'behavior', program: KUBE_SCHEDULER, what: 'preemption of lower-priority Pods', commandLine: '', machine: (c.data().host as string | undefined) ?? 'controlplane' });
  }
  c.trace('scheduler.unschedulable', `${key}: ${result.message}`, { ...podData(pod), plugins: result.plugins, nodes: nodes.length, message: result.message }, key, verdictIds);
  d.attempts[key] = attempts + 1;
  d.unschedulable[key] = { uid: uidOf(pod), plugins: result.plugins, since: c.now };
  setData(c, d);
  eventf(c.ctx, recorder(c), pod, undefined, 'Warning', 'FailedScheduling', 'Scheduling', truncateMessage(result.message));
  writeUnschedulableCondition(c, pod, result.message);
  // The leftover flush retries it after five minutes, on the 30 s grid.
  const started = typeof c.data().started === 'number' ? (c.data().started as number) : 0;
  const due = flushTime(started, c.now + MAX_IN_UNSCHEDULABLE_MS);
  return { requeueAfter: Math.max(due - c.now, backoff(attempts + 1)) };
}

/** updatePod: the PodScheduled=False condition, written only when it changed. */
function writeUnschedulableCondition(c: SyncCtx, pod: ApiObject, message: string): void {
  const status = statusOf(pod);
  const conditions = Array.isArray(status.conditions) ? (status.conditions.filter((x) => isObject(x)) as JsonObject[]) : [];
  const i = conditions.findIndex((x) => x.type === 'PodScheduled');
  const old = i >= 0 ? conditions[i] : undefined;
  const generation = typeof metaOf(pod).generation === 'number' ? (metaOf(pod).generation as number) : 0;
  const cond: JsonObject = {
    type: 'PodScheduled',
    status: 'False',
    // PodObservedGenerationTracking is on by default: the Pod's generation.
    ...(generation !== 0 ? { observedGeneration: generation } : {}),
    lastProbeTime: null,
    lastTransitionTime: old && old.status === 'False' ? (old.lastTransitionTime ?? null) : timeOf(c.now),
    reason: 'Unschedulable',
    message,
  };
  if (old && old.status === cond.status && old.reason === cond.reason && old.message === cond.message && old.lastTransitionTime === cond.lastTransitionTime) return;
  const next = cloneJson(conditions);
  if (i >= 0) next[i] = cond;
  else next.push(cond);
  c.client.resource('v1/pods').patch(namespaceOf(pod), nameOf(pod), { status: { conditions: next } }, { subresource: 'status' });
}

export const schedulerSpec: ControllerSpec = {
  name: CONTROLLER_NAME,
  component: 'kube-scheduler',
  serviceAccount: '',
  // kubeadm's scheduler.conf authenticates with a client certificate for this user.
  user: { username: 'system:kube-scheduler', groups: ['system:authenticated'] },
  watches: [
    { resource: 'v1/pods', keys: podKeys },
    { resource: 'v1/nodes', keys: nodeKeys },
  ],
  sync,
  latency: SCHEDULER_LATENCY_MS,
};

export interface SchedulerOptions {
  /** The machine it runs on: the event recorder's instance is `default-scheduler-<host>`. */
  host?: string;
}

/** Starts kube-scheduler against `server`: it lists every Pod and Node and queues what it can schedule. */
export function startScheduler(ctx: Ctx, server: ApiServerConfig, opts: SchedulerOptions = {}): void {
  if (isRunning(ctx, KUBE_SCHEDULER, CONTROLLER_NAME)) return;
  // The process's events.k8s.io broadcaster starts with it (its 6-minute series grid too).
  startEventsBroadcaster(ctx, KUBE_SCHEDULER, createClient(ctx, server, schedulerSpec.user));
  startController(ctx, KUBE_SCHEDULER, CONTROLLER_NAME, server, { started: ctx.now, host: opts.host ?? 'controlplane', unschedulable: {}, attempts: {} });
}

/** Stops it: its queue and everything it held are forgotten, as when the process exits. */
export function stopScheduler(ctx: Ctx): void {
  stopController(ctx, KUBE_SCHEDULER, CONTROLLER_NAME);
  stopEventsBroadcaster(ctx, KUBE_SCHEDULER);
}

export function isSchedulerRunning(ctx: Ctx): boolean {
  return isRunning(ctx, KUBE_SCHEDULER, CONTROLLER_NAME);
}

