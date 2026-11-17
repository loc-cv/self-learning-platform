// The ReplicaSet controller: keeps spec.replicas active Pods per ReplicaSet, adopting orphans that
// match its selector and releasing Pods that no longer do, and reports the counts in status.
//
// upstream: pkg/controller/replicaset/replica_set.go (NewBaseController's event handlers, addPod,
// updatePod, deletePod, resolveControllerRef, getPodReplicaSets, syncReplicaSet, claimPods,
// manageReplicas, slowStartBatch, getIndirectlyRelatedPods, getPodsToDelete,
// getPodsRankedByRelatedPodsOnSameNode)
//
// Not modeled: expectations (UIDTrackingControllerExpectations) and the consistency store
// (StaleControllerConsistencyReplicaSet). Both exist to keep a sync from acting on an informer cache
// that has not yet seen the controller's own writes; here a sync reads the store itself, which
// always has them. Goroutines that create or delete in parallel run one after the other in a
// defined order.

import type { Millis } from '@simlab/kernel';
import { jsonEqual, type JsonObject } from '../../apimachinery/json.ts';
import { labelSelectorAsSelector, selectorEmpty, selectorMatches } from '../../apimachinery/labels.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { claimPods } from '../controllerref.ts';
import { filterActivePods, filterClaimedPods, filterPodsByOwner, filterTerminatingPods, findMinNextPodAvailabilityCheck, isPodActive, activePodsWithRanksLess, SLOW_START_INITIAL_BATCH_SIZE } from '../controller_utils.ts';
import { getControllerOf, isDeleting, isNamespaceTerminating, isNotFound, keyOf, labelsOf, nameOf, namespaceOf, newControllerRef, num, resourceVersionOf, specOf, splitKey, type ApiError, type OwnerReference } from '../objects.ts';
import { createPods, deletePod } from '../podcontrol.ts';
import type { ControllerEvent, ControllerSpec, Reader, SyncCtx, SyncResult } from '../types.ts';
import { calculateStatus, updateReplicaSetStatus } from './replica_set_utils.ts';

/** BurstReplicas: at most this many Pods are created or deleted in one sync. */
export const BURST_REPLICAS = 500;

const RS = 'apps/v1/replicasets';
const KIND = 'ReplicaSet';
const API_VERSION = 'apps/v1';

/** resolveControllerRef: the ReplicaSet a controller reference names, if it is that exact object. */
function resolveControllerRef(read: Reader, namespace: string, ref: OwnerReference): ApiObject | undefined {
  if (ref.kind !== KIND) return undefined;
  const rs = read.get(RS, namespace, ref.name);
  if (!rs || (rs.metadata as JsonObject).uid !== ref.uid) return undefined;
  return rs;
}

/**
 * getPodReplicaSets (the lister's GetPodReplicaSets): ReplicaSets of the Pod's namespace whose
 * selector matches its labels; an empty selector matches nothing. Several matches are a user error
 * upstream logs; all are queued.
 */
function getPodReplicaSets(read: Reader, pod: ApiObject): ApiObject[] {
  if (Object.keys(labelsOf(pod)).length === 0) return [];
  const out: ApiObject[] = [];
  for (const rs of read.list(RS, namespaceOf(pod))) {
    const sel = labelSelectorAsSelector(specOf(rs).selector);
    if ('error' in sel) return [];
    if (selectorEmpty(sel) || !selectorMatches(sel, labelsOf(pod))) continue;
    out.push(rs);
  }
  return out;
}

/** deletePod handler: the owning ReplicaSet. */
function onPodDelete(read: Reader, pod: ApiObject): string[] {
  const ref = getControllerOf(pod);
  if (!ref) return [];
  const rs = resolveControllerRef(read, namespaceOf(pod), ref);
  return rs ? [keyOf(rs)] : [];
}

function onPodAdd(read: Reader, pod: ApiObject): string[] {
  // A Pod that shows up already being deleted (a restart, or a missed watch event).
  if (isDeleting(pod)) return onPodDelete(read, pod);
  const ref = getControllerOf(pod);
  if (ref) {
    const rs = resolveControllerRef(read, namespaceOf(pod), ref);
    return rs ? [keyOf(rs)] : [];
  }
  // An orphan: every matching ReplicaSet gets a chance to adopt it.
  return getPodReplicaSets(read, pod).map(keyOf);
}

function onPodUpdate(read: Reader, old: ApiObject, cur: ApiObject): string[] {
  if (resourceVersionOf(cur) === resourceVersionOf(old)) return [];
  const labelChanged = !jsonEqual(labelsOf(cur), labelsOf(old));
  if (isDeleting(cur)) return [...onPodDelete(read, cur), ...(labelChanged ? onPodDelete(read, old) : [])];
  const curRef = getControllerOf(cur);
  const oldRef = getControllerOf(old);
  const refChanged = !jsonEqual((curRef ?? null) as unknown as JsonObject, (oldRef ?? null) as unknown as JsonObject);
  const keys: string[] = [];
  if (refChanged && oldRef) {
    const rs = resolveControllerRef(read, namespaceOf(old), oldRef);
    if (rs) keys.push(keyOf(rs));
  }
  if (curRef) {
    const rs = resolveControllerRef(read, namespaceOf(cur), curRef);
    // Upstream also queues the ReplicaSet after minReadySeconds when the Pod just became ready;
    // the sync it triggers now requeues itself for that moment (FindMinNextPodAvailabilityCheck).
    if (rs) keys.push(keyOf(rs));
    return keys;
  }
  if (labelChanged || refChanged) keys.push(...getPodReplicaSets(read, cur).map(keyOf));
  return keys;
}

function podKeys(ev: ControllerEvent, read: Reader): string[] {
  let keys: string[];
  if (ev.type === 'DELETED') keys = onPodDelete(read, ev.object);
  else if (ev.type === 'ADDED' || !ev.old) keys = onPodAdd(read, ev.object);
  else keys = onPodUpdate(read, ev.old, ev.object);
  return [...new Set(keys)];
}

/**
 * slowStartBatch: calls fn in batches of 1, 2, 4, … up to `count`, stopping after the first batch
 * with an error. Returns the successes and the first error.
 */
export function slowStartBatch(count: number, initialBatchSize: number, fn: () => ApiError | undefined): { successes: number; error?: ApiError } {
  let remaining = count;
  let successes = 0;
  for (let batchSize = Math.min(remaining, initialBatchSize); batchSize > 0; batchSize = Math.min(2 * batchSize, remaining)) {
    const errors: ApiError[] = [];
    for (let i = 0; i < batchSize; i++) {
      const err = fn();
      if (err) errors.push(err);
    }
    successes += batchSize - errors.length;
    if (errors.length > 0) return { successes, error: errors[0] as ApiError };
    remaining -= batchSize;
  }
  return { successes };
}

/**
 * getIndirectlyRelatedPods: the Pods selected by any ReplicaSet with the same controller (the
 * Deployment's other ReplicaSets), each once.
 */
function getIndirectlyRelatedPods(c: SyncCtx, rs: ApiObject): ApiObject[] {
  const ref = getControllerOf(rs);
  if (!ref) return [];
  const seen = new Set<string>();
  const related: ApiObject[] = [];
  for (const other of c.list(RS)) {
    if (getControllerOf(other)?.uid !== ref.uid) continue;
    const sel = labelSelectorAsSelector(specOf(other).selector);
    if ('error' in sel) continue;
    for (const pod of c.list('v1/pods', namespaceOf(other))) {
      if (!selectorMatches(sel, labelsOf(pod))) continue;
      const uid = (pod.metadata as JsonObject).uid as string;
      if (seen.has(uid)) continue;
      seen.add(uid);
      related.push(pod);
    }
  }
  return related;
}

/**
 * getPodsToDelete: when only some Pods go, rank them (getPodsRankedByRelatedPodsOnSameNode: the
 * number of active related Pods on the same node) and take the first `diff`.
 */
export function getPodsToDelete(filteredPods: ApiObject[], relatedPods: readonly ApiObject[], diff: number, now: Millis): ApiObject[] {
  if (diff < filteredPods.length) {
    const podsOnNode = new Map<string, number>();
    for (const pod of relatedPods) {
      if (!isPodActive(pod)) continue;
      const node = String(specOf(pod).nodeName ?? '');
      podsOnNode.set(node, (podsOnNode.get(node) ?? 0) + 1);
    }
    const ranked = filteredPods.map((pod) => ({ pod, rank: podsOnNode.get(String(specOf(pod).nodeName ?? '')) ?? 0 }));
    const nowMicros = now * 1000;
    ranked.sort((a, b) => (activePodsWithRanksLess(a.pod, a.rank, b.pod, b.rank, nowMicros) ? -1 : activePodsWithRanksLess(b.pod, b.rank, a.pod, a.rank, nowMicros) ? 1 : 0));
    filteredPods = ranked.map((r) => r.pod);
  }
  return filteredPods.slice(0, diff);
}

/**
 * `replicaset.scale`: manageReplicas found the active Pods off spec.replicas and acts. The creates
 * and deletes that follow are its `controller.write` records.
 */
function traceScale(c: SyncCtx, rs: ApiObject, active: number, action: 'create' | 'delete', count: number, pods: string[]): void {
  const replicas = num(specOf(rs).replicas);
  const m = rs.metadata as JsonObject;
  c.trace(
    'replicaset.scale',
    `ReplicaSet ${namespaceOf(rs)}/${nameOf(rs)} has ${active} active Pod(s) of ${replicas}: ${action === 'create' ? 'creating' : 'deleting'} ${count}${pods.length > 0 ? ` (${pods.join(', ')})` : ''}`,
    { namespace: namespaceOf(rs), name: nameOf(rs), uid: String(m.uid ?? ''), replicas, active, action, count, pods },
    `${namespaceOf(rs)}/${nameOf(rs)}`,
  );
}

/** manageReplicas: create or delete Pods to bring the active count to spec.replicas. */
function manageReplicas(c: SyncCtx, activePods: ApiObject[], rs: ApiObject): ApiError | undefined {
  let diff = activePods.length - num(specOf(rs).replicas);
  const ns = namespaceOf(rs);
  if (diff < 0) {
    diff = Math.min(-diff, BURST_REPLICAS);
    traceScale(c, rs, activePods.length, 'create', diff, []);
    const template = specOf(rs).template as JsonObject;
    const ref = newControllerRef(rs, API_VERSION, KIND);
    const r = slowStartBatch(diff, SLOW_START_INITIAL_BATCH_SIZE, () => {
      const err = createPods(c, ns, template, rs, ref);
      // A terminating namespace refuses new Pods; that is not an error of this ReplicaSet.
      if (err && isNamespaceTerminating(err)) return undefined;
      return err;
    });
    return r.error;
  }
  if (diff > 0) {
    diff = Math.min(diff, BURST_REPLICAS);
    const podsToDelete = getPodsToDelete(activePods, getIndirectlyRelatedPods(c, rs), diff, c.now);
    traceScale(c, rs, activePods.length, 'delete', diff, podsToDelete.map(nameOf));
    let first: ApiError | undefined;
    for (const pod of podsToDelete) {
      const err = deletePod(c, ns, nameOf(pod), rs);
      if (err && !isNotFound(err) && !first) first = err;
    }
    return first;
  }
  return undefined;
}

export function syncReplicaSet(c: SyncCtx, key: string): SyncResult {
  const [namespace, name] = splitKey(key);
  const rs = c.get(RS, namespace, name);
  if (!rs) return { done: true };
  const selector = labelSelectorAsSelector(specOf(rs).selector);
  // An invalid selector is logged and the ReplicaSet left alone.
  if ('error' in selector) return { done: true };

  const allRSPods = filterPodsByOwner(c.list('v1/pods', namespace), rs, KIND, true);
  const allActivePods = filterActivePods(allRSPods);
  const claimed = claimPods({ client: c.client, controller: rs, selector, apiVersion: API_VERSION, kind: KIND, controllerResource: RS }, allActivePods);
  if (claimed.error) return { error: claimed.error.message };
  const activePods = claimed.claimed;
  // DeploymentReplicaSetTerminatingReplicas is beta and on at the pin.
  const terminatingPods = filterClaimedPods(rs, selector, filterTerminatingPods(allRSPods));

  const manageReplicasErr = isDeleting(rs) ? undefined : manageReplicas(c, activePods, rs);
  const newStatus = calculateStatus(rs, activePods, terminatingPods, manageReplicasErr, c.now);
  const updated = updateReplicaSetStatus(c.client, rs, newStatus);
  if ('error' in updated) return { error: updated.error.message };
  if (manageReplicasErr) return { error: manageReplicasErr.message };
  const u = updated.rs;
  const minReadySeconds = num(specOf(u).minReadySeconds);
  const st = (u.status ?? {}) as JsonObject;
  if (minReadySeconds > 0 && num(st.readyReplicas) !== num(st.availableReplicas)) {
    return { requeueAfter: findMinNextPodAvailabilityCheck(activePods, minReadySeconds, c.now) ?? minReadySeconds * 1000 };
  }
  return { done: true };
}

export const replicaSetController: ControllerSpec = {
  name: 'replicaset',
  component: 'kube-controller-manager',
  serviceAccount: 'replicaset-controller',
  // upstream: NewReplicaSetController: v1.EventSource{Component: "replicaset-controller"}
  eventSource: 'replicaset-controller',
  watches: [
    // addRS, updateRS, deleteRS: the ReplicaSet's own key.
    { resource: RS, keys: (ev) => [keyOf(ev.object)] },
    { resource: 'v1/pods', keys: podKeys },
  ],
  sync: syncReplicaSet,
  latency: 5,
};
