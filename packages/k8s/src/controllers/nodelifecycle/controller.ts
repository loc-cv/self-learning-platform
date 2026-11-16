// The node lifecycle controller: the NoSchedule tainting pass (TaintNodesByCondition) and node
// health monitoring (health.ts). A cordoned node gets node.kubernetes.io/unschedulable:NoSchedule,
// and a node whose conditions report pressure, unavailability or not-ready gets the matching
// taint; the taints go away when the cause does. NoExecute taints and evictions wait for the
// DefaultTolerationSeconds admission plugin (phase 20b).
//
// upstream: pkg/controller/nodelifecycle/node_lifecycle_controller.go doNoScheduleTaintingPass,
// nodeConditionToTaintKeyStatusMap, taintKeyToNodeConditionMap; pkg/controller/util/node/
// controller_utils.go SwapNodeControllerTaint (timeAdded = now on added taints);
// pkg/controller/controller_utils.go AddOrUpdateTaintOnNode, RemoveTaintOffNode, PatchNodeTaints
// (the whole taint list is written; a strategic merge patch upstream, a JSON merge patch here with
// the same result, D-052).
//
// Latency. The real controller reacts within milliseconds, but after the scheduler: in every
// capture of fixtures/golden/v1.37.2/scheduling/cordoned.yaml, uncordoning a node let the
// scheduler retry while the unschedulable taint was still there, so the Pod failed once more
// before the taint's removal requeued it. 20 ms against the scheduler's 5 ms keeps that order.

import { jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { isObject } from '../../apimachinery/json.ts';
import { timeOf } from '../../apimachinery/time.ts';
import type { ControllerSpec, SyncCtx, SyncResult } from '../types.ts';
import { metaOf, nameOf, specOf, statusOf } from '../objects.ts';
import { observeNode, syncHealth, syncLease } from './health.ts';

export const NODE_LIFECYCLE = 'node-lifecycle';

/** upstream: v1.TaintNode* keys. */
export const TAINT_NODE_NOT_READY = 'node.kubernetes.io/not-ready';
export const TAINT_NODE_UNREACHABLE = 'node.kubernetes.io/unreachable';
export const TAINT_NODE_UNSCHEDULABLE = 'node.kubernetes.io/unschedulable';
export const TAINT_NODE_MEMORY_PRESSURE = 'node.kubernetes.io/memory-pressure';
export const TAINT_NODE_DISK_PRESSURE = 'node.kubernetes.io/disk-pressure';
export const TAINT_NODE_NETWORK_UNAVAILABLE = 'node.kubernetes.io/network-unavailable';
export const TAINT_NODE_PID_PRESSURE = 'node.kubernetes.io/pid-pressure';

const CONDITION_TO_TAINT: Record<string, Record<string, string>> = {
  Ready: { False: TAINT_NODE_NOT_READY, Unknown: TAINT_NODE_UNREACHABLE },
  MemoryPressure: { True: TAINT_NODE_MEMORY_PRESSURE },
  DiskPressure: { True: TAINT_NODE_DISK_PRESSURE },
  NetworkUnavailable: { True: TAINT_NODE_NETWORK_UNAVAILABLE },
  PIDPressure: { True: TAINT_NODE_PID_PRESSURE },
};

const CONTROLLED = new Set([TAINT_NODE_NOT_READY, TAINT_NODE_UNREACHABLE, TAINT_NODE_NETWORK_UNAVAILABLE, TAINT_NODE_MEMORY_PRESSURE, TAINT_NODE_DISK_PRESSURE, TAINT_NODE_PID_PRESSURE, TAINT_NODE_UNSCHEDULABLE]);

const arr = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter((x) => isObject(x)) as JsonObject[]) : []);

function sync(c: SyncCtx, key: string): SyncResult {
  if (key.startsWith('lease/')) return syncLease(c, key.slice('lease/'.length));
  if (key.startsWith('health/')) return syncHealth(c, key.slice('health/'.length));
  const name = key;
  const node = c.get('v1/nodes', undefined, name);
  if (!node) return { done: true };
  observeNode(c, node);
  const want: string[] = [];
  for (const cond of arr(statusOf(node).conditions)) {
    const key = CONDITION_TO_TAINT[String(cond.type)]?.[String(cond.status)];
    if (key) want.push(key);
  }
  if (specOf(node).unschedulable === true) want.push(TAINT_NODE_UNSCHEDULABLE);
  const taints = arr(specOf(node).taints);
  const have = taints.filter((t) => t.effect === 'NoSchedule' && CONTROLLED.has(String(t.key)));
  const toAdd = want.filter((k) => !have.some((t) => t.key === k));
  const toDel = have.filter((t) => !want.includes(String(t.key)));
  if (toAdd.length === 0 && toDel.length === 0) return { done: true };
  // AddOrUpdateTaint appends; RemoveTaintOffNode drops matching key and effect.
  let next = taints.filter((t) => !toDel.includes(t));
  for (const key of toAdd) next = [...next, { key, effect: 'NoSchedule', timeAdded: timeOf(c.now) }];
  if (jsonEqual(next, taints)) return { done: true };
  const r = c.client.resource('v1/nodes').patch(undefined, name, { metadata: { resourceVersion: String(metaOf(node).resourceVersion ?? '') }, spec: { taints: next.length > 0 ? next : null } });
  if (!r.ok) return { error: `failed to swap taints of node ${name}: ${r.code}` };
  return { done: true };
}

export const nodeLifecycleController: ControllerSpec = {
  name: NODE_LIFECYCLE,
  component: 'kube-controller-manager',
  serviceAccount: 'node-controller',
  eventSource: 'node-controller',
  watches: [
    { resource: 'v1/nodes', keys: (ev) => (ev.type === 'DELETED' ? [] : [nameOf(ev.object)]) },
    { resource: 'coordination.k8s.io/v1/leases', keys: (ev) => (ev.type !== 'DELETED' && metaOf(ev.object).namespace === 'kube-node-lease' ? [`lease/${nameOf(ev.object)}`] : []) },
  ],
  sync,
  latency: 20,
};
