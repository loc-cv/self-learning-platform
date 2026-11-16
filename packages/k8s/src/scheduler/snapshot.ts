// The scheduler's view of the cluster at the start of a scheduling cycle: one NodeInfo per Node,
// built from the store (the scheduler's informer cache stands on it, docs/ARCHITECTURE.md §4.3).
//
// upstream: pkg/scheduler/backend/cache/snapshot.go, framework/types.go NodeInfo.AddPod
// (requested, non-zero requested, used ports), NewNodeInfo; eventhandlers.go (the cache holds
// assigned Pods that are not terminal: a Pod in phase Succeeded or Failed releases its resources).

import { isObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { creationMicros, nameOf, specOf, statusOf, str } from './util.ts';
import { arr, podNonZeroRequests, podRequests, resourceList, type ResourceList } from './resources.ts';
import type { HostPort, NodeInfo } from './types.ts';

/** upstream: podutil.IsPodTerminal. */
export function isTerminal(pod: ApiObject): boolean {
  const phase = str(statusOf(pod).phase);
  return phase === 'Succeeded' || phase === 'Failed';
}

/**
 * Host ports a Pod asks for: sidecar init containers' first, then the containers'; an empty host
 * IP is 0.0.0.0 and an empty protocol TCP (HostPortInfo.sanitize).
 * upstream: pkg/scheduler/util/utils.go GetHostPorts; kube-scheduler/framework/types.go HostPortInfo.
 */
export function hostPorts(pod: ApiObject): HostPort[] {
  const out: HostPort[] = [];
  const spec = specOf(pod);
  const sidecars = arr(spec.initContainers).filter((c) => c.restartPolicy === 'Always');
  for (const c of [...sidecars, ...arr(spec.containers)]) {
    for (const p of arr(c.ports)) {
      const port = typeof p.hostPort === 'number' ? p.hostPort : 0;
      if (port <= 0) continue;
      out.push({ ip: str(p.hostIP) || '0.0.0.0', protocol: str(p.protocol) || 'TCP', port });
    }
  }
  return out;
}

function addTo(into: ResourceList, l: ResourceList): void {
  for (const k of Object.keys(l)) into[k] = (into[k] ?? 0) + (l[k] as number);
}

export function newNodeInfo(node: ApiObject, pods: ApiObject[]): NodeInfo {
  const status = statusOf(node);
  const images: Record<string, number> = {};
  for (const img of arr(status.images)) {
    const size = typeof img.sizeBytes === 'number' ? img.sizeBytes : 0;
    for (const n of Array.isArray(img.names) ? img.names : []) if (typeof n === 'string') images[n] = size;
  }
  const info: NodeInfo = {
    name: nameOf(node),
    node,
    pods: [],
    requested: {},
    nonZeroRequested: {},
    allocatable: resourceList(isObject(status.allocatable) ? status.allocatable : undefined),
    usedPorts: [],
    images,
  };
  for (const p of pods) addPod(info, p);
  return info;
}

/** upstream: NodeInfo.AddPod. */
export function addPod(info: NodeInfo, pod: ApiObject): void {
  info.pods.push(pod);
  addTo(info.requested, podRequests(pod));
  addTo(info.nonZeroRequested, podNonZeroRequests(pod));
  info.usedPorts.push(...hostPorts(pod));
}

/**
 * Node infos in the cache's node order: the node tree lists nodes per zone in the order they were
 * added (by creation here, then name), and the simulated clusters have one zone.
 * upstream: backend/cache/node_tree.go.
 */
export function snapshot(nodes: ApiObject[], pods: ApiObject[]): NodeInfo[] {
  const byNode: Record<string, ApiObject[]> = {};
  for (const p of pods) {
    const n = str(specOf(p).nodeName);
    if (n === '' || isTerminal(p)) continue;
    (byNode[n] ??= []).push(p);
  }
  const ordered = [...nodes].sort((a, b) => creationMicros(a) - creationMicros(b) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
  return ordered.map((n) => newNodeInfo(n, byNode[nameOf(n)] ?? []));
}
