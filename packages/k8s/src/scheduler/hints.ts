// Queueing hints: whether a cluster event may make a Pod that a plugin rejected schedulable. A Pod
// held as unschedulable is retried when the hint of any plugin that rejected it says Queue.
//
// upstream: each plugin's EventsToRegister and QueueingHintFn (pkg/scheduler/framework/plugins/):
//   nodeunschedulable: Node Add|UpdateNodeTaint → isSchedulableAfterNodeChange (unschedulable
//     true→false, or a new schedulable node); TargetPod UpdatePodToleration →
//     isSchedulableAfterTargetPodTolerationChange (now tolerates node.kubernetes.io/unschedulable)
//   nodename: Node Add (no hint function: always Queue)
//   tainttoleration: Node Add|UpdateNodeTaint → isSchedulableAfterNodeChange (was untolerated, now
//     tolerated); TargetPod UpdatePodToleration → Queue
//   nodeaffinity: Node Add|UpdateNodeLabel → isSchedulableAfterNodeChange (unmatched → matched)
//   nodeports: AssignedPod Delete → isSchedulableAfterAssignedPodDeleted (it held a conflicting
//     host port); Node Add (always Queue)
//   noderesources/fit.go: AssignedPod Delete → isSchedulableAfterAssignedPodDelete; Node
//     Add|UpdateNodeAllocatable → isSchedulableAfterNodeChange (the node fits the Pod's requests,
//     and on update some requested resource's allocatable increased)
// framework/events.go NodeSchedulingPropertiesChange decides which update types a Node update is;
// a plugin's hint runs only for the event types it registered.

import { jsonEqual, type Json } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { findUntoleratedTaint, matchesRequiredNodeAffinity, taintsOf, tolerationsOf, tolerationsTolerateTaint } from './helpers.ts';
import { portConflict, TAINT_NODE_UNSCHEDULABLE, fitsRequest } from './plugins/filters.ts';
import { podRequests, resourceList } from './resources.ts';
import { hostPorts, newNodeInfo } from './snapshot.ts';
import type { QueueingHint } from './types.ts';
import { labelsOf, metaOf, specOf, statusOf, str } from './util.ts';

/** A cluster event: a Node added or updated, an assigned Pod deleted, or the Pod itself updated. */
export type HintEvent =
  | { kind: 'NodeAdd'; node: ApiObject }
  | { kind: 'NodeUpdate'; old: ApiObject; node: ApiObject }
  | { kind: 'AssignedPodDelete'; pod: ApiObject }
  | { kind: 'TargetPodUpdate'; old: ApiObject; pod: ApiObject };

const taintsChanged = (a: ApiObject, b: ApiObject): boolean =>
  !jsonEqual(specOf(a).taints as Json | undefined, specOf(b).taints as Json | undefined) || (specOf(a).unschedulable === true) !== (specOf(b).unschedulable === true);
const labelsChanged = (a: ApiObject, b: ApiObject): boolean => !jsonEqual(labelsOf(a), labelsOf(b));
const allocatableChanged = (a: ApiObject, b: ApiObject): boolean => !jsonEqual(statusOf(a).allocatable as Json | undefined, statusOf(b).allocatable as Json | undefined);
const tolerationsChanged = (a: ApiObject, b: ApiObject): boolean => !jsonEqual(specOf(a).tolerations as Json | undefined, specOf(b).tolerations as Json | undefined);

type Hint = (pod: ApiObject, e: HintEvent) => QueueingHint;

const Q = (b: boolean): QueueingHint => (b ? 'Queue' : 'QueueSkip');

const nodeUnschedulable: Hint = (pod, e) => {
  if (e.kind === 'NodeAdd') return Q(specOf(e.node).unschedulable !== true);
  if (e.kind === 'NodeUpdate') return Q(taintsChanged(e.old, e.node) && specOf(e.old).unschedulable === true && specOf(e.node).unschedulable !== true);
  if (e.kind === 'TargetPodUpdate') return Q(tolerationsChanged(e.old, e.pod) && tolerationsTolerateTaint(tolerationsOf(e.pod), { key: TAINT_NODE_UNSCHEDULABLE, value: '', effect: 'NoSchedule' }));
  void pod;
  return 'QueueSkip';
};

const nodeName: Hint = (_pod, e) => Q(e.kind === 'NodeAdd');

const taintToleration: Hint = (pod, e) => {
  if (e.kind === 'NodeAdd') return Q(!findUntoleratedTaint(taintsOf(e.node), tolerationsOf(pod)));
  if (e.kind === 'NodeUpdate') {
    if (!taintsChanged(e.old, e.node)) return 'QueueSkip';
    const was = findUntoleratedTaint(taintsOf(e.old), tolerationsOf(pod)) !== undefined;
    const is = findUntoleratedTaint(taintsOf(e.node), tolerationsOf(pod)) !== undefined;
    return Q(was && !is);
  }
  if (e.kind === 'TargetPodUpdate') return Q(tolerationsChanged(e.old, e.pod));
  return 'QueueSkip';
};

const nodeAffinity: Hint = (pod, e) => {
  if (e.kind === 'NodeAdd') return Q(matchesRequiredNodeAffinity(pod, e.node));
  if (e.kind === 'NodeUpdate') return Q(labelsChanged(e.old, e.node) && matchesRequiredNodeAffinity(pod, e.node) && !matchesRequiredNodeAffinity(pod, e.old));
  return 'QueueSkip';
};

const assigned = (p: ApiObject): boolean => str(specOf(p).nodeName) !== '' || str(statusOf(p).nominatedNodeName) !== '';

const nodePorts: Hint = (pod, e) => {
  if (e.kind === 'NodeAdd') return 'Queue';
  if (e.kind === 'AssignedPodDelete') {
    if (!assigned(e.pod)) return 'QueueSkip';
    const freed = hostPorts(e.pod);
    if (freed.length === 0) return 'QueueSkip';
    return Q(hostPorts(pod).some((p) => portConflict(freed, p)));
  }
  return 'QueueSkip';
};

/** upstream: isFit — the Pod's requests against the node's allocatable alone (no Pods). */
function fitsEmpty(pod: ApiObject, node: ApiObject): boolean {
  return fitsRequest(podRequests(pod), newNodeInfo(node, [])).length === 0;
}

/** upstream: haveAnyRequestedResourcesIncreased. */
function requestedAllocatableIncreased(pod: ApiObject, old: ApiObject, node: ApiObject): boolean {
  const req = podRequests(pod);
  const a = resourceList(statusOf(old).allocatable as Json | undefined);
  const b = resourceList(statusOf(node).allocatable as Json | undefined);
  if ((b.pods ?? 0) > (a.pods ?? 0)) return true;
  for (const k of Object.keys(req)) if ((req[k] as number) > 0 && (b[k] ?? 0) > (a[k] ?? 0)) return true;
  return false;
}

const nodeResourcesFit: Hint = (pod, e) => {
  if (e.kind === 'AssignedPodDelete') return Q(assigned(e.pod));
  if (e.kind === 'NodeAdd') return Q(fitsEmpty(pod, e.node));
  if (e.kind === 'NodeUpdate') return Q(allocatableChanged(e.old, e.node) && fitsEmpty(pod, e.node) && requestedAllocatableIncreased(pod, e.old, e.node));
  return 'QueueSkip';
};

const HINTS: Record<string, Hint> = {
  NodeUnschedulable: nodeUnschedulable,
  NodeName: nodeName,
  TaintToleration: taintToleration,
  NodeAffinity: nodeAffinity,
  NodePorts: nodePorts,
  NodeResourcesFit: nodeResourcesFit,
};

/** Whether `e` may make `pod`, rejected by `plugins`, schedulable: any plugin's hint says Queue. */
export function worthRequeuing(pod: ApiObject, plugins: readonly string[], e: HintEvent): { queue: boolean; plugin?: string } {
  for (const p of plugins) {
    const h = HINTS[p];
    // A rejecting plugin without registered events (none here) would be retried only by the flush.
    if (h && h(pod, e) === 'Queue') return { queue: true, plugin: p };
  }
  return { queue: false };
}

/**
 * Whether an update of an unscheduled Pod changed anything but its status and bookkeeping.
 * upstream: backend/queue/scheduling_queue.go isPodUpdated (ignores resourceVersion, generation,
 * managedFields and status).
 */
export function isPodUpdated(old: ApiObject, pod: ApiObject): boolean {
  const strip = (p: ApiObject): Json => {
    const m = { ...metaOf(p) };
    delete m.resourceVersion;
    delete m.generation;
    delete m.managedFields;
    return { metadata: m, spec: p.spec ?? null } as Json;
  };
  return !jsonEqual(strip(old), strip(pod));
}
