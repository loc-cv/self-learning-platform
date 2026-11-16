// The kubelet's node side: the events it records when it starts, the Lease it renews and the
// Node status it posts.
//
// upstream (v1.37.2):
// - Lease: component-helpers/apimachinery/lease/controller.go (renew every 10 s with jitter 0.04,
//   sliding; a PUT of the last object with leaseDurationSeconds 40 and renewTime; at start a GET
//   first); pkg/kubelet/kubelet.go (Run, not Start: the Lease is never deleted).
// - Status: pkg/kubelet/kubelet_node_status.go syncNodeStatus every nodeStatusUpdateFrequency
//   (10 s, jitter 0.04, sliding), tryUpdateNodeStatus (patch only when something changed, ignoring
//   lastHeartbeatTime, or when nodeStatusReportFrequency 5 m plus a delay drawn in [-2.5 m, 2.5 m)
//   after a change has passed; the first sync of a process always patches); nodestatus/setters.go
//   (every condition's lastHeartbeatTime is now; lastTransitionTime moves only with the status;
//   Ready's KubeletReady text; NodeReady/NodeNotReady on a transition; Images: size descending
//   then ID descending, at most 50, names = repo digests then tags, at most 5).
// - Image list cache refreshed every 30 s (images/image_gc_manager.go).
// - Start events (kubelet.go BirthCry, kubelet_node_status.go registerWithAPIServer → setNodeStatus
//   on a fresh Node, cm/node_container_manager_linux.go): Starting, the three pressure conditions,
//   NodeAllocatableEnforced. InvalidDiskCapacity, a startup race of image GC against cAdvisor, is
//   left out (D-062).
// kubeadm's KubeletConfiguration sets both frequencies to 0s, which means the defaults.

import { put, type Ctx, type HandlerSpec, type Millis } from '@simlab/kernel';
import { cloneJson, isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { microTimeOf, timeOf } from '../apimachinery/time.ts';
import { k8sSlice, type ApiObject } from '../apiserver/store.ts';
import { createClient, type Client } from '../client/client.ts';
import { recordEvent } from '../controllers/record.ts';
import type { ControllerState } from '../controllers/runtime.ts';
import { runtimeOf } from '../runtime/runtime.ts';
import { jitter } from './latency.ts';
import { kubeletId } from './pleg.ts';
import type { HeartbeatState, KubeletData } from './types.ts';

export const HEARTBEAT_EVENT = 'k8s.kubelet.heartbeat';
const RENEW_MS = 10_000;
const STATUS_MS = 10_000;
const REPORT_MS = 5 * 60_000;
const IMAGE_CACHE_MS = 30_000;
const MAX_IMAGES = 50;
const MAX_NAMES = 5;
const LEASE_DURATION_S = 40;

const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

export function kubeletUser(node: string): { username: string; groups: string[] } {
  return { username: `system:node:${node}`, groups: ['system:nodes', 'system:authenticated'] };
}

function state(ctx: Ctx, node: string): ControllerState | undefined {
  return k8sSlice(ctx).controllers[kubeletId(node)];
}

function data(st: ControllerState): KubeletData {
  return st.data as unknown as KubeletData;
}

function setHeartbeat(ctx: Ctx, node: string, hb: HeartbeatState): void {
  const st = state(ctx, node);
  if (!st) return;
  put(k8sSlice(ctx).controllers, st.id, { ...st, data: { ...st.data, heartbeat: hb as unknown as Json } });
}

function client(ctx: Ctx, st: ControllerState, node: string): Client {
  return createClient(ctx, st.server, kubeletUser(node));
}

/** The kubelet's Node reference: with the Node's UID once it has seen the Node (nodeRefWithUID). */
function nodeRef(node: string, uid?: string): JsonObject {
  return { kind: 'Node', name: node, ...(uid ? { uid } : {}), apiVersion: 'v1' };
}

function nodeEvent(ctx: Ctx, st: ControllerState, node: string, type: 'Normal' | 'Warning', reason: string, message: string, withUid: boolean): void {
  const n = client(ctx, st, node).resource('v1/nodes').get(undefined, node);
  const uid = n.ok ? str(obj((n.object as JsonObject).metadata).uid) : undefined;
  const ref = nodeRef(node, withUid ? uid : undefined);
  recordEvent(ctx, { recorder: st.id, component: 'kubelet', host: node, client: client(ctx, st, node) }, { kind: 'Node', apiVersion: 'v1', metadata: { name: node } } as ApiObject, type, reason, message, ref);
}

/** What a kubelet does when its process starts, on a node that is already registered. */
export function kubeletStarted(ctx: Ctx, node: string): void {
  const st = state(ctx, node);
  if (!st) return;
  nodeEvent(ctx, st, node, 'Normal', 'Starting', 'Starting kubelet.', true);
  for (const reason of ['NodeHasSufficientMemory', 'NodeHasNoDiskPressure', 'NodeHasSufficientPID']) nodeEvent(ctx, st, node, 'Normal', reason, `Node ${node} status is now: ${reason}`, true);
  nodeEvent(ctx, st, node, 'Normal', 'NodeAllocatableEnforced', 'Updated Node Allocatable limit across pods', false);
  renewLease(ctx, node, true);
  syncNodeStatus(ctx, node);
}

function schedule(ctx: Ctx, node: string, what: 'lease' | 'status', period: Millis): string {
  return ctx.schedule(jitter(ctx, `k8s.kubelet.heartbeat.${what}`, period, 0.04), HEARTBEAT_EVENT, { node, what });
}

/** Renews the node's Lease (a PUT of the last object, with renewTime now). */
function renewLease(ctx: Ctx, node: string, first = false): void {
  const st = state(ctx, node);
  if (!st) return;
  const leases = client(ctx, st, node).resource('coordination.k8s.io/v1/leases');
  const got = leases.get('kube-node-lease', node);
  if (got.ok) {
    const lease = cloneJson(got.object as Json) as JsonObject;
    lease.spec = { ...obj(lease.spec), leaseDurationSeconds: LEASE_DURATION_S, renewTime: microTimeOf(ctx.now) };
    leases.update('kube-node-lease', lease);
  } else if (first) {
    const n = client(ctx, st, node).resource('v1/nodes').get(undefined, node);
    const uid = n.ok ? str(obj((n.object as JsonObject).metadata).uid) : '';
    leases.create('kube-node-lease', {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: node, namespace: 'kube-node-lease', ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: node, uid }] },
      spec: { holderIdentity: node, leaseDurationSeconds: LEASE_DURATION_S, renewTime: microTimeOf(ctx.now) },
    });
  }
  const hb = data(state(ctx, node) as ControllerState).heartbeat;
  setHeartbeat(ctx, node, { ...hb, leaseEvent: schedule(ctx, node, 'lease', RENEW_MS) });
}

function imageList(ctx: Ctx, node: string): { names: string[]; sizeBytes: number }[] {
  const rt = runtimeOf(ctx, node);
  return Object.values(rt.images)
    .sort((a, b) => b.size - a.size || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, MAX_IMAGES)
    .map((i) => ({ names: [...i.repoDigests, ...i.repoTags].slice(0, MAX_NAMES), sizeBytes: i.size }));
}

const withoutHeartbeat = (conds: JsonObject[]): string => JSON.stringify(conds.map((c) => ({ ...c, lastHeartbeatTime: null })));

/** syncNodeStatus: recompute, and patch when it changed or the report period expired. */
function syncNodeStatus(ctx: Ctx, node: string): void {
  const st = state(ctx, node);
  if (!st) return;
  let hb = data(st).heartbeat;
  const nodes = client(ctx, st, node).resource('v1/nodes');
  const got = nodes.get(undefined, node);
  if (got.ok) {
    const cur = got.object as JsonObject;
    const status = obj(cur.status);
    if (!hb.images || ctx.now - hb.images.at >= IMAGE_CACHE_MS) hb = { ...hb, images: { at: ctx.now, list: imageList(ctx, node) } };
    const now = timeOf(ctx.now);
    const oldConds = (Array.isArray(status.conditions) ? status.conditions : []).filter(isObject) as JsonObject[];
    const setter = (type: string, s: string, reason: string, message: string): JsonObject => {
      const prev = oldConds.find((c) => c.type === type);
      const same = prev && prev.status === s;
      return { type, status: s, lastHeartbeatTime: now, lastTransitionTime: same ? str(prev.lastTransitionTime) : now, reason: same && type !== 'Ready' ? str(prev.reason) : reason, message: same && type !== 'Ready' ? str(prev.message) : message };
    };
    const conds = [
      setter('MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'),
      setter('DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'),
      setter('PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'),
      setter('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status'),
    ];
    // Conditions other components own (NetworkUnavailable) stay.
    const others = oldConds.filter((c) => !['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].includes(str(c.type)));
    const next: JsonObject = { ...status, conditions: [...others, ...conds], images: hb.images?.list ?? [] };
    if ((hb.images?.list ?? []).length === 0) delete next.images;
    const changed = withoutHeartbeat(oldConds) !== withoutHeartbeat([...others, ...conds]) || JSON.stringify(status.images ?? null) !== JSON.stringify(next.images ?? null);
    const expired = hb.lastReport === undefined || ctx.now - hb.lastReport >= REPORT_MS + hb.reportDelay;
    if (changed || expired) {
      const r = nodes.updateStatus(undefined, { ...cur, status: next });
      if (r.ok) {
        // A change (or the first report) draws a new delay; a period-only patch resets it.
        const delay = changed || hb.lastReport === undefined ? Math.floor(REPORT_MS * (ctx.random('k8s.kubelet.report-delay').float() - 0.5)) : 0;
        const readyBefore = str(oldConds.find((c) => c.type === 'Ready')?.status);
        if (readyBefore !== 'True' && readyBefore !== '') {
          for (const c of conds.slice(0, 3)) {
            const prev = oldConds.find((o) => o.type === c.type);
            if (prev && prev.status !== c.status) nodeEvent(ctx, st, node, 'Normal', c.type === 'MemoryPressure' ? 'NodeHasSufficientMemory' : c.type === 'DiskPressure' ? 'NodeHasNoDiskPressure' : 'NodeHasSufficientPID', `Node ${node} status is now: ${c.type === 'MemoryPressure' ? 'NodeHasSufficientMemory' : c.type === 'DiskPressure' ? 'NodeHasNoDiskPressure' : 'NodeHasSufficientPID'}`, true);
          }
          nodeEvent(ctx, st, node, 'Normal', 'NodeReady', `Node ${node} status is now: NodeReady`, true);
        }
        hb = { ...hb, lastReport: ctx.now, reportDelay: delay, ready: 'True' };
      }
    }
  }
  const latest = state(ctx, node);
  if (!latest) return;
  setHeartbeat(ctx, node, { ...hb, leaseEvent: data(latest).heartbeat.leaseEvent, statusEvent: schedule(ctx, node, 'status', STATUS_MS) } as HeartbeatState);
}

export function cancelHeartbeats(ctx: Ctx, node: string): void {
  const st = state(ctx, node);
  if (!st) return;
  const hb = data(st).heartbeat;
  if (hb.leaseEvent) ctx.cancel(hb.leaseEvent);
  if (hb.statusEvent) ctx.cancel(hb.statusEvent);
}

export const nodeHandlers: HandlerSpec[] = [
  {
    type: HEARTBEAT_EVENT,
    // Periodic background work: `settle` does not wait for it.
    idle: true,
    handle(ctx, payload) {
      const { node, what } = payload as { node: string; what: 'lease' | 'status' };
      if (!state(ctx, node)) return;
      if (what === 'lease') renewLease(ctx, node);
      else syncNodeStatus(ctx, node);
    },
  },
];
