// The Deployment controller: owns ReplicaSets through their controller references and moves Pods
// from the old ReplicaSets to the one matching the current template, by the Deployment's strategy.
//
// upstream: pkg/controller/deployment/deployment_controller.go (event handlers, resolveControllerRef,
// getDeploymentForPod, getReplicaSetsForDeployment, getPodMapForDeployment, syncDeployment,
// handleErr with maxRetries)

import { jsonEqual, type JsonObject } from '../../apimachinery/json.ts';
import { labelSelectorAsSelector, selectorEmpty, selectorMatches } from '../../apimachinery/labels.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { claimReplicaSets } from '../controllerref.ts';
import { filterPodsByOwner } from '../controller_utils.ts';
import { generationOf, getControllerOf, isDeleting, isNamespaceTerminating, keyOf, labelsOf, namespaceOf, plainError, specOf, splitKey, uidOf, type ApiError, type OwnerReference } from '../objects.ts';
import type { ControllerEvent, ControllerSpec, Reader, SyncCtx, SyncResult } from '../types.ts';
import { rolloutRecreate, type PodMap } from './recreate.ts';
import { getRollbackTo, rollback } from './rollback.ts';
import { rolloutRolling } from './rolling.ts';
import { checkPausedConditions, isScalingEvent, sync, syncStatusOnly, updateDeploymentStatus } from './sync.ts';
import { deploymentOf, isPaused, strategyType } from './util.ts';

/**
 * maxRetries: a Deployment is retried 15 times before it is dropped out of the queue; with the
 * rate limiter's delays (5 ms · 2^n) that is about 2.7 minutes.
 */
export const MAX_RETRIES = 15;

const DEPLOYMENTS = 'apps/v1/deployments';
const RS = 'apps/v1/replicasets';

/** resolveControllerRef: the Deployment a controller reference names, if it is that exact object. */
function resolveControllerRef(read: Reader, namespace: string, ref: OwnerReference): ApiObject | undefined {
  // We can't look up by UID, so look up by Name and then verify UID. Don't even try to look up by
  // Name if it's the wrong Kind.
  if (ref.kind !== 'Deployment') return undefined;
  const d = read.get(DEPLOYMENTS, namespace, ref.name);
  if (!d || uidOf(d) !== ref.uid) return undefined;
  return d;
}

/**
 * getDeploymentsForReplicaSet (util.GetDeploymentsForReplicaSet): Deployments of the ReplicaSet's
 * namespace whose non-empty selector matches its labels.
 */
function getDeploymentsForReplicaSet(read: Reader, rs: ApiObject): ApiObject[] {
  if (Object.keys(labelsOf(rs)).length === 0) return [];
  const out: ApiObject[] = [];
  for (const d of read.list(DEPLOYMENTS, namespaceOf(rs))) {
    const sel = labelSelectorAsSelector(specOf(d).selector);
    if ('error' in sel) continue;
    // If a deployment with a nil or empty selector creeps in, it should match nothing, not everything.
    if (selectorEmpty(sel) || !selectorMatches(sel, labelsOf(rs))) continue;
    out.push(d);
  }
  return out;
}

/** deleteReplicaSet handler: the owning Deployment. */
function onReplicaSetDelete(read: Reader, rs: ApiObject): string[] {
  const ref = getControllerOf(rs);
  if (!ref) return [];
  const d = resolveControllerRef(read, namespaceOf(rs), ref);
  return d ? [keyOf(d)] : [];
}

function onReplicaSetAdd(read: Reader, rs: ApiObject): string[] {
  // On a restart of the controller manager, it's possible for an object to show up in a state
  // that is already pending deletion.
  if (isDeleting(rs)) return onReplicaSetDelete(read, rs);
  const ref = getControllerOf(rs);
  if (ref) {
    const d = resolveControllerRef(read, namespaceOf(rs), ref);
    return d ? [keyOf(d)] : [];
  }
  // Otherwise, it's an orphan. Get a list of all matching Deployments and sync them to see if
  // anyone wants to adopt it.
  return getDeploymentsForReplicaSet(read, rs).map(keyOf);
}

function onReplicaSetUpdate(read: Reader, old: ApiObject, cur: ApiObject): string[] {
  // Periodic resync will send update events for all known replica sets. Two different versions
  // of the same replica set will always have different RVs.
  if ((cur.metadata as JsonObject).resourceVersion === (old.metadata as JsonObject).resourceVersion) return [];
  const curRef = getControllerOf(cur);
  const oldRef = getControllerOf(old);
  const refChanged = !jsonEqual((curRef ?? null) as unknown as JsonObject, (oldRef ?? null) as unknown as JsonObject);
  const keys: string[] = [];
  if (refChanged && oldRef) {
    // The ControllerRef was changed. Sync the old controller, if any.
    const d = resolveControllerRef(read, namespaceOf(old), oldRef);
    if (d) keys.push(keyOf(d));
  }
  if (curRef) {
    const d = resolveControllerRef(read, namespaceOf(cur), curRef);
    if (d) keys.push(keyOf(d));
    return keys;
  }
  // Otherwise, it's an orphan. If anything changed, sync matching controllers to see if anyone
  // wants to adopt it now.
  const labelChanged = !jsonEqual(labelsOf(cur), labelsOf(old));
  if (labelChanged || refChanged) keys.push(...getDeploymentsForReplicaSet(read, cur).map(keyOf));
  return keys;
}

function replicaSetKeys(ev: ControllerEvent, read: Reader): string[] {
  let keys: string[];
  if (ev.type === 'DELETED') keys = onReplicaSetDelete(read, ev.object);
  else if (ev.type === 'ADDED' || !ev.old) keys = onReplicaSetAdd(read, ev.object);
  else keys = onReplicaSetUpdate(read, ev.old, ev.object);
  return [...new Set(keys)];
}

/**
 * deletePod handler: a Recreate Deployment waits for its old Pods to be gone, so the deletion of a
 * Pod of one of its ReplicaSets syncs it (getDeploymentForPod).
 */
function podKeys(ev: ControllerEvent, read: Reader): string[] {
  if (ev.type !== 'DELETED') return [];
  const pod = ev.object;
  const ref = getControllerOf(pod);
  if (!ref || ref.kind !== 'ReplicaSet') return [];
  const rs = read.get(RS, namespaceOf(pod), ref.name);
  if (!rs || uidOf(rs) !== ref.uid) return [];
  const dref = getControllerOf(rs);
  if (!dref) return [];
  const d = resolveControllerRef(read, namespaceOf(rs), dref);
  if (!d || strategyType(d) !== 'Recreate') return [];
  return [keyOf(d)];
}

/**
 * getReplicaSetsForDeployment: the ReplicaSets of the namespace the Deployment owns after adopting
 * matching orphans and releasing owned ones that no longer match.
 */
function getReplicaSetsForDeployment(c: SyncCtx, d: JsonObject): { rsList: ApiObject[] } | { error: ApiError } {
  // List all ReplicaSets to find those we own but that no longer match our selector. They will
  // be orphaned by ClaimReplicaSets().
  const all = c.list(RS, namespaceOf(d));
  const selector = labelSelectorAsSelector(specOf(d).selector);
  if ('error' in selector) return { error: plainError(`deployment ${namespaceOf(d)}/${(d.metadata as JsonObject).name as string} has invalid label selector: ${selector.error}`) };
  const r = claimReplicaSets({ client: c.client, controller: d, selector, apiVersion: 'apps/v1', kind: 'Deployment', controllerResource: DEPLOYMENTS }, all);
  return r.error ? { error: r.error } : { rsList: r.claimed };
}

/** getPodMapForDeployment: the Pods each ReplicaSet controls, by ReplicaSet UID. */
function getPodMapForDeployment(c: SyncCtx, rsList: ApiObject[]): PodMap {
  return rsList.map((rs) => ({ uid: uidOf(rs), pods: filterPodsByOwner(c.list('v1/pods', namespaceOf(rs)), rs, 'ReplicaSet', false) }));
}

/** handleErr: a NamespaceTerminating error is not retried; others are, up to maxRetries (the runtime's). */
function result(err: ApiError | undefined): SyncResult {
  if (!err || isNamespaceTerminating(err)) return { done: true };
  return { error: err.message };
}

export function syncDeployment(c: SyncCtx, key: string): SyncResult {
  const [namespace, name] = splitKey(key);
  const deployment = c.get(DEPLOYMENTS, namespace, name);
  if (!deployment) return { done: true };
  // Deep-copy otherwise we are mutating our cache.
  const d = deploymentOf(deployment);

  const selector = specOf(d.obj).selector;
  if (jsonEqual(selector ?? null, {})) {
    c.event(d.obj, 'Warning', 'SelectingAll', 'This deployment is selecting all pods. A non-empty selector is required.');
    if (d.status.observedGeneration < generationOf(d.obj)) {
      d.status.observedGeneration = generationOf(d.obj);
      updateDeploymentStatus(c, d);
    }
    return { done: true };
  }

  // List ReplicaSets owned by this Deployment, while reconciling ControllerRef through adoption/orphaning.
  const claimed = getReplicaSetsForDeployment(c, d.obj);
  if ('error' in claimed) return result(claimed.error);
  const rsList = claimed.rsList;

  if (isDeleting(d.obj)) return result(syncStatusOnly(c, d, rsList));

  // Update deployment conditions with an Unknown condition when pausing/resuming a deployment. In
  // this way, we can be sure that we won't timeout when a user resumes a Deployment with a set
  // progressDeadlineSeconds.
  const pausedErr = checkPausedConditions(c, d);
  if (pausedErr) return result(pausedErr);

  if (isPaused(d.obj)) return result(sync(c, d, rsList));

  // rollback is not re-entrant in case the underlying replica sets are updated with a new
  // revision so we should ensure that we won't proceed to update replica sets until we make sure
  // that the deployment has cleaned up its rollback spec in subsequent enqueues.
  if (getRollbackTo(d) !== undefined) return result(rollback(c, d, rsList));

  const scaling = isScalingEvent(c, d, rsList);
  if ('error' in scaling) return result(scaling.error);
  if (scaling.scaling) return result(sync(c, d, rsList));

  switch (strategyType(d.obj)) {
    case 'Recreate':
      return result(rolloutRecreate(c, d, rsList, getPodMapForDeployment(c, rsList)));
    case 'RollingUpdate':
      return result(rolloutRolling(c, d, rsList));
  }
  return { error: `unexpected deployment strategy type: ${strategyType(d.obj)}` };
}

export const deploymentController: ControllerSpec = {
  name: 'deployment',
  component: 'kube-controller-manager',
  serviceAccount: 'deployment-controller',
  // upstream: NewDeploymentController: v1.EventSource{Component: "deployment-controller"}
  eventSource: 'deployment-controller',
  watches: [
    // addDeployment, updateDeployment, deleteDeployment: the Deployment's own key.
    { resource: DEPLOYMENTS, keys: (ev) => [keyOf(ev.object)] },
    { resource: RS, keys: replicaSetKeys },
    { resource: 'v1/pods', keys: podKeys },
  ],
  sync: syncDeployment,
  latency: 5,
  maxRetries: MAX_RETRIES,
};
