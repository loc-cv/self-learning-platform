// Node health monitoring of the node lifecycle controller: a node whose kubelet stops renewing its
// Lease (and posting status) is marked Unknown after the grace period, its Pods are marked not
// ready, and the NoSchedule pass then adds node.kubernetes.io/unreachable.
//
// upstream (v1.37.2): pkg/controller/nodelifecycle/node_lifecycle_controller.go monitorNodeHealth
// (every nodeMonitorPeriod = 5 s from the start; newly seen nodes get RegisteredNode and a fresh
// probe timestamp), tryUpdateNodeHealth (probeTimestamp = the controller's now whenever the Lease's
// renewTime or Ready's lastHeartbeatTime moves; unresponsive when now is after probeTimestamp +
// nodeMonitorGracePeriod = 50 s, or nodeStartupGracePeriod = 60 s before the first Ready; Ready,
// MemoryPressure, DiskPressure, PIDPressure become Unknown with NodeStatusUnknown "Kubelet stopped
// posting node status.", lastHeartbeatTime kept, lastTransitionTime now; an UpdateStatus of the
// Node), RecordNodeStatusChange (NodeNotReady on the transition), pkg/controller/util/node/
// controller_utils.go MarkPodsNotReady (Ready=False, a PUT of /status, the Pod event "Node is not
// ready"), RecordNodeEvent ("Node %s event: %s").
// Not modeled yet: NoExecute taints and taint-based eviction need the DefaultTolerationSeconds
// admission plugin first (phase 20b; STATUS.md), so zone disruption handling has nothing to act on.
//
// The 5 s monitor loop is not run as a timer: each node's deadline is an idle kernel event that
// a renewal moves, so a healthy cluster schedules no work and `settle` still finds it quiet.

import { put, type Ctx, type HandlerSpec, type Millis } from '@simlab/kernel';
import { cloneJson, isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { parseTime, timeOf } from '../../apimachinery/time.ts';
import { k8sSlice, type ApiObject } from '../../apiserver/store.ts';
import { enqueue } from '../runtime.ts';
import type { SyncCtx, SyncResult } from '../types.ts';
import { metaOf, nameOf, specOf, statusOf } from '../objects.ts';

export const NODE_MONITOR_PERIOD_MS = 5_000;
export const NODE_MONITOR_GRACE_MS = 50_000;
export const NODE_STARTUP_GRACE_MS = 60_000;
export const HEALTH_DEADLINE_EVENT = 'k8s.nodelifecycle.deadline';
/** The controller manager runs it; phase 27 makes the instance its process. */
const CONTROLLER_ID = 'kube-controller-manager/node-lifecycle';

interface Probe {
  /** probeTimestamp: the controller's time when it last saw the node alive. */
  at: Millis;
  renewTime: string;
  heartbeat: string;
  deadlineEvent?: string;
}

const arr = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObject) as JsonObject[]) : []);
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

function probes(c: SyncCtx): Record<string, Probe> {
  return (c.data().probes ?? {}) as unknown as Record<string, Probe>;
}

function readyOf(node: ApiObject): JsonObject | undefined {
  return arr(statusOf(node).conditions).find((x) => x.type === 'Ready');
}

/** The first monitor tick strictly after `t`, on the 5 s grid from the controller's start. */
function tickAfter(c: SyncCtx, t: Millis): Millis {
  if (typeof c.data().started !== 'number') c.setData('started', c.now);
  const start = Number(c.data().started);
  return start + (Math.floor((t - start) / NODE_MONITOR_PERIOD_MS) + 1) * NODE_MONITOR_PERIOD_MS;
}

function grace(node: ApiObject | undefined): Millis {
  return node && readyOf(node) ? NODE_MONITOR_GRACE_MS : NODE_STARTUP_GRACE_MS;
}

/** Records that the node looked alive now and moves its deadline. */
function observe(c: SyncCtx, name: string, renewTime: string, heartbeat: string): void {
  const all = { ...probes(c) };
  const old = all[name];
  if (old?.deadlineEvent) c.ctx.cancel(old.deadlineEvent);
  const node = c.get('v1/nodes', undefined, name);
  const at = c.now;
  const due = tickAfter(c, at + grace(node));
  const deadlineEvent = c.ctx.schedule(due - c.now, HEALTH_DEADLINE_EVENT, { controller: CONTROLLER_ID, node: name });
  all[name] = { at, renewTime, heartbeat, deadlineEvent };
  c.setData('probes', all as unknown as Json);
}

/** A Lease changed: a newer renewTime refreshes the probe timestamp. */
export function syncLease(c: SyncCtx, name: string): SyncResult {
  const lease = c.get('coordination.k8s.io/v1/leases', 'kube-node-lease', name);
  if (!lease) return { done: true };
  const renew = str(((lease.spec ?? {}) as JsonObject).renewTime);
  const p = probes(c)[name];
  if (!p || newer(renew, p.renewTime)) observe(c, name, renew, p?.heartbeat ?? heartbeatOf(c, name));
  return { done: true };
}

function newer(a: string, b: string): boolean {
  if (b === '') return a !== '';
  const ta = parseTime(a, true);
  const tb = parseTime(b, true);
  return 'micros' in ta && 'micros' in tb ? ta.micros > tb.micros : a !== b;
}

function heartbeatOf(c: SyncCtx, name: string): string {
  const node = c.get('v1/nodes', undefined, name);
  return node ? str(readyOf(node)?.lastHeartbeatTime) : '';
}

/** A Node changed: a new Ready heartbeat refreshes the probe; a node seen for the first time is registered. */
export function observeNode(c: SyncCtx, node: ApiObject): void {
  const name = nameOf(node);
  const p = probes(c)[name];
  const hb = str(readyOf(node)?.lastHeartbeatTime);
  if (!p) {
    c.event(node, 'Normal', 'RegisteredNode', `Node ${name} event: Registered Node ${name} in Controller`);
    observe(c, name, '', hb);
  } else if (hb !== p.heartbeat) observe(c, name, p.renewTime, hb);
}

/** The deadline passed without a renewal: tryUpdateNodeHealth marks the node Unknown. */
export function syncHealth(c: SyncCtx, name: string): SyncResult {
  const node = c.get('v1/nodes', undefined, name);
  const p = probes(c)[name];
  if (!node || !p) return { done: true };
  if (!(c.now > p.at + grace(node))) return { done: true };
  const conds = arr(statusOf(node).conditions).map((x) => cloneJson(x) as JsonObject);
  const ready = conds.find((x) => x.type === 'Ready');
  const wasReady = ready?.status === 'True';
  let changed = false;
  for (const type of ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure']) {
    const cur = conds.find((x) => x.type === type);
    if (!cur) {
      conds.push({ type, status: 'Unknown', lastHeartbeatTime: str(metaOf(node).creationTimestamp), lastTransitionTime: timeOf(c.now), reason: 'NodeStatusNeverUpdated', message: 'Kubelet never posted node status.' });
      changed = true;
    } else if (cur.status !== 'Unknown') {
      cur.status = 'Unknown';
      cur.reason = 'NodeStatusUnknown';
      cur.message = 'Kubelet stopped posting node status.';
      cur.lastTransitionTime = timeOf(c.now);
      changed = true;
    }
  }
  if (!changed) return { done: true };
  const r = c.client.resource('v1/nodes').updateStatus(undefined, { ...node, status: { ...statusOf(node), conditions: conds } } as JsonObject);
  if (!r.ok) return { error: `cannot update node ${name}: ${r.code}` };
  c.trace('nodelifecycle.unknown', `node ${name}: no Lease renewal or status since ${timeOf(p.at)}; conditions set to Unknown`, undefined, `node/${name}`);
  if (wasReady) {
    c.event(r.object as ApiObject, 'Normal', 'NodeNotReady', `Node ${name} status is now: NodeNotReady`);
    markPodsNotReady(c, name);
  }
  return { done: true };
}

function markPodsNotReady(c: SyncCtx, node: string): void {
  for (const pod of c.list('v1/pods')) {
    if (str(specOf(pod).nodeName) !== node) continue;
    const st = statusOf(pod);
    const conds = arr(st.conditions).map((x) => cloneJson(x) as JsonObject);
    const ready = conds.find((x) => x.type === 'Ready');
    if (!ready || ready.status === 'False') continue;
    ready.status = 'False';
    ready.lastTransitionTime = timeOf(c.now);
    const r = c.client.resource('v1/pods').updateStatus(str(metaOf(pod).namespace), { ...pod, status: { ...st, conditions: conds } } as JsonObject);
    if (r.ok) c.event(r.object as ApiObject, 'Warning', 'NodeNotReady', 'Node is not ready');
  }
}

export const healthHandlers: HandlerSpec[] = [
  {
    type: HEALTH_DEADLINE_EVENT,
    idle: true,
    handle(ctx: Ctx, payload) {
      const { controller, node } = payload as { controller: string; node: string };
      const st = k8sSlice(ctx).controllers[controller];
      if (!st) return;
      const all = { ...((st.data.probes ?? {}) as unknown as Record<string, Probe>) };
      const p = all[node];
      if (p) {
        const rest: Probe = { ...p };
        delete rest.deadlineEvent;
        all[node] = rest;
        put(k8sSlice(ctx).controllers, controller, { ...st, data: { ...st.data, probes: all as unknown as Json } });
      }
      enqueue(ctx, controller, `health/${node}`, 0, 'no Lease renewal within the grace period');
    },
  },
];
