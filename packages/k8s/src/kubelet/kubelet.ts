// The kubelet of a node (docs/ARCHITECTURE.md §4.8), on the controller runtime: one instance per
// node, named after it, acting as `system:node:<node>`. Its work queue holds Pod keys
// (`<namespace>/<name>/<uid>`) fed by the Pod watch (Pods bound to this node), by the PLEG
// (pleg.ts) and by its own requeues, plus the serial image puller's key. Node status and the Lease
// are periodic (node.ts).
//
// Starting a kubelet lists every Pod bound to the node and every Pod the runtime still has (the
// pod workers start from what the runtime reports, so running containers are adopted, not
// restarted); stopping it forgets its memory (back-offs, the reason cache, pulls in progress) while
// the runtime's containers keep running. Phase 26a ties start and stop to the kubelet.service unit.

import type { Ctx } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { enqueue, isRunning, startController, stopController } from '../controllers/runtime.ts';
import type { ControllerEvent, ControllerSpec, SyncCtx, SyncResult } from '../controllers/types.ts';
import { LOG_TOPIC } from '../runtime/logs.ts';
import { runtimeOf } from '../runtime/runtime.ts';
import { cancelHeartbeats, kubeletStarted, kubeletUser } from './node.ts';
import { KUBELET, kubeletId, podKey } from './pleg.ts';
import { PULL_KEY, syncPodKey, syncPuller } from './pods.ts';
import type { KubeletData } from './types.ts';

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const meta = (o: JsonObject): JsonObject => (o.metadata ?? {}) as JsonObject;

/** From a watch event to the pod worker: the config source's channel and the sync loop's pickup. */
export const KUBELET_LATENCY_MS = 5;

function keyOf(o: JsonObject): string {
  const m = meta(o);
  return podKey(str(m.namespace), str(m.name), str(m.uid));
}

function onNode(ev: ControllerEvent, node: string): boolean {
  return str(((ev.object.spec ?? {}) as JsonObject).nodeName) === node;
}

/**
 * podsDifferSemantically (pkg/kubelet/config/config.go): an update that changes only the status
 * is a reconcile, which does not sync the Pod; spec, labels, annotations and the deletion fields
 * do. (The binding that sets nodeName arrives as the Pod's first appearance on this node.)
 */
function differs(ev: ControllerEvent): boolean {
  if (ev.type !== 'MODIFIED' || !ev.old) return true;
  const a = ev.old as JsonObject;
  const b = ev.object as JsonObject;
  const pick = (o: JsonObject) => {
    const m = meta(o);
    return JSON.stringify([o.spec ?? null, m.labels ?? null, m.annotations ?? null, m.deletionTimestamp ?? null, m.deletionGracePeriodSeconds ?? null]);
  };
  if (str(((a.spec ?? {}) as JsonObject).nodeName) === '') return true;
  return pick(a) !== pick(b);
}

export const kubeletSpec: ControllerSpec = {
  name: KUBELET,
  component: 'kubelet',
  serviceAccount: '',
  userOf: (instance) => kubeletUser(instance),
  watches: [
    {
      resource: 'v1/pods',
      keys: (ev, _read, data) => (onNode(ev, String(data.node)) && differs(ev) ? [keyOf(ev.object as JsonObject)] : []),
    },
  ],
  sync(c: SyncCtx, key: string): SyncResult {
    if (key === PULL_KEY) return syncPuller(c);
    return syncPodKey(c, key);
  },
  latency: KUBELET_LATENCY_MS,
};

export interface KubeletNode {
  name: string;
  ip: string;
  podCIDR: string;
}

/** Starts the kubelet of `node` against an API server. */
export function startKubelet(ctx: Ctx, server: ApiServerConfig, node: KubeletNode): void {
  if (isRunning(ctx, node.name, KUBELET)) return;
  const data: KubeletData = {
    node: node.name,
    nodeIP: node.ip,
    podCIDR: node.podCIDR,
    started: ctx.now,
    pods: {},
    reasons: {},
    imageBackoff: {},
    pullErrors: {},
    crashBackoff: {},
    pulls: { queue: [], done: {} },
    heartbeat: { reportDelay: 0 },
    nextId: 1,
  };
  startController(ctx, node.name, KUBELET, server, data as unknown as Record<string, Json>);
  ctx.trace({ source: `k8s.kubelet/${node.name}`, kind: 'kubelet.start', message: `kubelet on ${node.name} started` });
  // Pods the runtime still has but the API no longer lists are found by the first relist.
  const rt = runtimeOf(ctx, node.name);
  const seen = new Set<string>();
  for (const sb of Object.values(rt.sandboxes)) {
    const key = podKey(sb.namespace, sb.name, sb.podUID);
    if (seen.has(key)) continue;
    seen.add(key);
    enqueue(ctx, kubeletId(node.name), key, KUBELET_LATENCY_MS, 'PLEG: first relist');
  }
  kubeletStarted(ctx, node.name);
}

/** Stops the kubelet: its memory is gone; containers keep running in the runtime. */
export function stopKubelet(ctx: Ctx, node: string): void {
  if (!isRunning(ctx, node, KUBELET)) return;
  cancelHeartbeats(ctx, node);
  stopController(ctx, node, KUBELET);
  ctx.trace({ source: `k8s.kubelet/${node}`, kind: 'kubelet.stop', message: `kubelet on ${node} stopped` });
  // The log streams it served end with its connections (kubelet/logs.ts).
  ctx.publish(LOG_TOPIC);
}

export function isKubeletRunning(ctx: Ctx, node: string): boolean {
  return isRunning(ctx, node, KUBELET);
}
