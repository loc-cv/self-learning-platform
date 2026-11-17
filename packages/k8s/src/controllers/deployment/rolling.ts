// The RollingUpdate strategy: grow the new ReplicaSet within maxSurge, shrink the old ones within
// maxUnavailable, unhealthy old replicas first.
//
// upstream: pkg/controller/deployment/rolling.go

import type { ApiObject } from '../../apiserver/store.ts';
import { filterActiveReplicaSets, replicaSetsByCreationTimestampLess, sortBy } from '../controller_utils.ts';
import { namespaceOf, nameOf, num, plainError, statusOf, type ApiError } from '../objects.ts';
import type { SyncCtx } from '../types.ts';
import { syncRolloutStatus } from './progress.ts';
import { cleanupDeployment, getAllReplicaSetsAndSyncRevision, scaleReplicaSet } from './sync.ts';
import { deploymentComplete, getAvailableReplicaCountForReplicaSets, getReplicaCountForReplicaSets, maxSurge, maxUnavailable, newRSNewReplicas, replicasOf, type Deployment } from './util.ts';

/** rolloutRolling: one step of a rolling update. */
export function rolloutRolling(c: SyncCtx, d: Deployment, rsList: ApiObject[]): ApiError | undefined {
  const r = getAllReplicaSetsAndSyncRevision(c, d, rsList, true);
  if ('error' in r) return r.error;
  const newRS = r.newRS as ApiObject;
  const oldRSs = r.oldRSs;
  const allRSs = [...oldRSs, newRS];

  // Scale up, if we can.
  const up = reconcileNewReplicaSet(c, allRSs, newRS, d);
  if (up.error) return up.error;
  if (up.scaled) {
    // Update DeploymentStatus
    return syncRolloutStatus(c, allRSs, newRS, d);
  }

  // Scale down, if we can.
  const down = reconcileOldReplicaSets(c, allRSs, filterActiveReplicaSets(oldRSs), newRS, d);
  if (down.error) return down.error;
  if (down.scaled) {
    // Update DeploymentStatus
    return syncRolloutStatus(c, allRSs, newRS, d);
  }

  if (deploymentComplete(d, d.status)) {
    const err = cleanupDeployment(c, oldRSs, d);
    if (err) return err;
  } else traceWaiting(c, d, allRSs, oldRSs, newRS);

  // Sync deployment status
  return syncRolloutStatus(c, allRSs, newRS, d);
}

/**
 * `deployment.rollout.waiting`: this step could neither grow the new ReplicaSet nor shrink an old
 * one, so the rollout waits for Pods to become available. The numbers are the ones the two
 * reconcile steps compare (maxTotalPods against the Pods there are, minAvailable against the
 * available ones). Trace only.
 */
function traceWaiting(c: SyncCtx, d: Deployment, allRSs: ApiObject[], oldRSs: ApiObject[], newRS: ApiObject): void {
  const replicas = replicasOf(d.obj);
  const data = {
    namespace: namespaceOf(d.obj),
    name: nameOf(d.obj),
    replicas,
    maxSurge: maxSurge(d.obj),
    maxUnavailable: maxUnavailable(d.obj),
    maxTotalPods: replicas + maxSurge(d.obj),
    currentPodCount: getReplicaCountForReplicaSets(allRSs),
    minAvailable: replicas - maxUnavailable(d.obj),
    availablePodCount: getAvailableReplicaCountForReplicaSets(allRSs),
    newReplicaSet: nameOf(newRS),
    newReplicas: replicasOf(newRS),
    newAvailable: num(statusOf(newRS).availableReplicas),
    oldReplicas: getReplicaCountForReplicaSets(oldRSs),
  };
  c.trace(
    'deployment.rollout.waiting',
    `Deployment ${data.namespace}/${data.name} waits: ${data.availablePodCount} available (at least ${data.minAvailable}), ${data.currentPodCount} Pods (at most ${data.maxTotalPods}), new ReplicaSet ${data.newAvailable}/${data.newReplicas} available`,
    data,
    `${data.namespace}/${data.name}`,
  );
}

function reconcileNewReplicaSet(c: SyncCtx, allRSs: ApiObject[], newRS: ApiObject, d: Deployment): { scaled: boolean; error?: ApiError } {
  if (replicasOf(newRS) === replicasOf(d.obj)) {
    // Scaling not required.
    return { scaled: false };
  }
  if (replicasOf(newRS) > replicasOf(d.obj)) {
    // Scale down.
    const r = scaleReplicaSet(c, newRS, replicasOf(d.obj), d, false, { step: 'the new ReplicaSet has more than the replicas' });
    return { scaled: r.scaled, ...(r.error ? { error: r.error } : {}) };
  }
  const count = newRSNewReplicas(d.obj, allRSs, newRS);
  if ('error' in count) return { scaled: false, error: plainError(count.error) };
  const r = scaleReplicaSet(c, newRS, count.value, d, false, { step: 'rolling update: scale up the new ReplicaSet', maxTotalPods: replicasOf(d.obj) + maxSurge(d.obj), currentPodCount: getReplicaCountForReplicaSets(allRSs) });
  return { scaled: r.scaled, ...(r.error ? { error: r.error } : {}) };
}

/**
 * reconcileOldReplicaSets: how far the old ReplicaSets may shrink (all Pods - minAvailable - the
 * new ReplicaSet's unavailable Pods), first by removing their unhealthy replicas, then healthy
 * ones while availability stays above minAvailable. Errors of the two steps are dropped, as upstream.
 */
function reconcileOldReplicaSets(c: SyncCtx, allRSs: ApiObject[], oldRSs: ApiObject[], newRS: ApiObject, d: Deployment): { scaled: boolean; error?: ApiError } {
  const oldPodsCount = getReplicaCountForReplicaSets(oldRSs);
  if (oldPodsCount === 0) {
    // Can't scale down further
    return { scaled: false };
  }
  const allPodsCount = getReplicaCountForReplicaSets(allRSs);
  const minAvailable = replicasOf(d.obj) - maxUnavailable(d.obj);
  const newRSUnavailablePodCount = replicasOf(newRS) - num(statusOf(newRS).availableReplicas);
  const maxScaledDown = allPodsCount - minAvailable - newRSUnavailablePodCount;
  if (maxScaledDown <= 0) return { scaled: false };

  // Clean up unhealthy replicas first, otherwise unhealthy replicas will block deployment and
  // cause timeout.
  const cleaned = cleanupUnhealthyReplicas(c, oldRSs, d, maxScaledDown);
  if (cleaned.error) return { scaled: false };

  // Scale down old replica sets, need check maxUnavailable to ensure we can scale down
  const all = [...cleaned.oldRSs, newRS];
  const scaledDown = scaleDownOldReplicaSetsForRollingUpdate(c, all, cleaned.oldRSs, d);
  if (scaledDown.error) return { scaled: false };
  return { scaled: cleaned.count + scaledDown.count > 0 };
}

/** cleanupUnhealthyReplicas: scales old ReplicaSets down by their unavailable replicas, oldest first. */
function cleanupUnhealthyReplicas(c: SyncCtx, oldRSs: ApiObject[], d: Deployment, maxCleanupCount: number): { oldRSs: ApiObject[]; count: number; error?: ApiError } {
  sortBy(oldRSs, replicaSetsByCreationTimestampLess);
  // Safely scale down all old replica sets with unhealthy replicas. Replica set will sort the pods
  // in the order such that not-ready < ready, unscheduled < scheduled, and pending < running.
  // This ensures that unhealthy replicas will been deleted first and won't increase
  // unavailability.
  let total = 0;
  for (let i = 0; i < oldRSs.length; i++) {
    const target = oldRSs[i] as ApiObject;
    if (total >= maxCleanupCount) break;
    if (replicasOf(target) === 0) {
      // cannot scale down this replica set.
      continue;
    }
    const available = num(statusOf(target).availableReplicas);
    if (replicasOf(target) === available) {
      // no unhealthy replicas found, no scaling required.
      continue;
    }
    const scaledDownCount = Math.min(maxCleanupCount - total, replicasOf(target) - available);
    const newReplicasCount = replicasOf(target) - scaledDownCount;
    if (newReplicasCount > replicasOf(target)) {
      return { oldRSs: [], count: 0, error: plainError(`when cleaning up unhealthy replicas, got invalid request to scale down ${namespaceOf(target)}/${nameOf(target)} ${replicasOf(target)} -> ${newReplicasCount}`) };
    }
    const r = scaleReplicaSet(c, target, newReplicasCount, d, false, { step: 'rolling update: remove unhealthy old replicas', maxCleanupCount, available });
    if (r.error) return { oldRSs: [], count: total, error: r.error };
    total += scaledDownCount;
    oldRSs[i] = r.rs;
  }
  return { oldRSs, count: total };
}

/**
 * scaleDownOldReplicaSetsForRollingUpdate: scales old ReplicaSets down, oldest first, by as much
 * as availability above minAvailable allows.
 */
function scaleDownOldReplicaSetsForRollingUpdate(c: SyncCtx, allRSs: ApiObject[], oldRSs: ApiObject[], d: Deployment): { count: number; error?: ApiError } {
  const minAvailable = replicasOf(d.obj) - maxUnavailable(d.obj);
  // Find the number of available pods.
  const availablePodCount = getAvailableReplicaCountForReplicaSets(allRSs);
  if (availablePodCount <= minAvailable) {
    // Cannot scale down.
    return { count: 0 };
  }
  sortBy(oldRSs, replicaSetsByCreationTimestampLess);
  let total = 0;
  const totalScaleDownCount = availablePodCount - minAvailable;
  for (const target of oldRSs) {
    if (total >= totalScaleDownCount) {
      // No further scaling required.
      break;
    }
    if (replicasOf(target) === 0) {
      // cannot scale down this ReplicaSet.
      continue;
    }
    // Scale down.
    const scaleDownCount = Math.min(replicasOf(target), totalScaleDownCount - total);
    const newReplicasCount = replicasOf(target) - scaleDownCount;
    if (newReplicasCount > replicasOf(target)) {
      return { count: 0, error: plainError(`when scaling down old RS, got invalid request to scale down ${namespaceOf(target)}/${nameOf(target)} ${replicasOf(target)} -> ${newReplicasCount}`) };
    }
    const r = scaleReplicaSet(c, target, newReplicasCount, d, false, { step: 'rolling update: scale down an old ReplicaSet', minAvailable, availablePodCount });
    if (r.error) return { count: total, error: r.error };
    total += scaleDownCount;
  }
  return { count: total };
}
