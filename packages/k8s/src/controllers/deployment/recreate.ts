// The Recreate strategy: scale every old ReplicaSet to zero, wait until their Pods are gone, then
// create or scale up the new ReplicaSet.
//
// upstream: pkg/controller/deployment/recreate.go

import type { ApiObject } from '../../apiserver/store.ts';
import { filterActiveReplicaSets } from '../controller_utils.ts';
import { uidOf, type ApiError } from '../objects.ts';
import { podPhase } from '../podutil.ts';
import type { SyncCtx } from '../types.ts';
import { syncRolloutStatus } from './progress.ts';
import { cleanupDeployment, getAllReplicaSetsAndSyncRevision, scaleReplicaSet } from './sync.ts';
import { deploymentComplete, getActualReplicaCountForReplicaSets, replicasOf, type Deployment } from './util.ts';

/** A Pod list per ReplicaSet UID (getPodMapForDeployment), in the ReplicaSets' order. */
export type PodMap = { uid: string; pods: ApiObject[] }[];

/** rolloutRecreate: one step of a Recreate rollout. */
export function rolloutRecreate(c: SyncCtx, d: Deployment, rsList: ApiObject[], podMap: PodMap): ApiError | undefined {
  // Don't create a new RS if not already existed, so that we avoid scaling up before scaling down.
  let r = getAllReplicaSetsAndSyncRevision(c, d, rsList, false);
  if ('error' in r) return r.error;
  let newRS = r.newRS;
  let oldRSs = r.oldRSs;
  let allRSs: (ApiObject | undefined)[] = [...oldRSs, newRS];
  const activeOldRSs = filterActiveReplicaSets(oldRSs);

  // scale down old replica sets.
  const down = scaleDownOldReplicaSetsForRecreate(c, activeOldRSs, d);
  if (down.error) return down.error;
  if (down.scaled) {
    // Update DeploymentStatus.
    return syncRolloutStatus(c, allRSs, newRS, d);
  }

  // Do not process a deployment when it has old pods running.
  if (oldPodsRunning(newRS, oldRSs, podMap)) return syncRolloutStatus(c, allRSs, newRS, d);

  // If we need to create a new RS, create it now.
  if (!newRS) {
    r = getAllReplicaSetsAndSyncRevision(c, d, rsList, true);
    if ('error' in r) return r.error;
    newRS = r.newRS;
    oldRSs = r.oldRSs;
    allRSs = [...oldRSs, newRS];
  }

  // scale up new replica set.
  const up = scaleReplicaSet(c, newRS as ApiObject, replicasOf(d.obj), d, false);
  if (up.error) return up.error;

  if (deploymentComplete(d, d.status)) {
    const err = cleanupDeployment(c, oldRSs, d);
    if (err) return err;
  }

  // Sync deployment status.
  return syncRolloutStatus(c, allRSs, newRS, d);
}

function scaleDownOldReplicaSetsForRecreate(c: SyncCtx, oldRSs: ApiObject[], d: Deployment): { scaled: boolean; error?: ApiError } {
  let scaled = false;
  for (let i = 0; i < oldRSs.length; i++) {
    const rs = oldRSs[i] as ApiObject;
    // Scaling not required.
    if (replicasOf(rs) === 0) continue;
    const r = scaleReplicaSet(c, rs, 0, d, false);
    if (r.error) return { scaled: false, error: r.error };
    if (r.scaled) {
      oldRSs[i] = r.rs;
      scaled = true;
    }
  }
  return { scaled };
}

/**
 * oldPodsRunning: whether old ReplicaSets still report replicas, or own a Pod that is not Failed or
 * Succeeded (Pending, Running and Unknown all count: an Unknown Pod may still run on a
 * partitioned node).
 */
function oldPodsRunning(newRS: ApiObject | undefined, oldRSs: ApiObject[], podMap: PodMap): boolean {
  if (getActualReplicaCountForReplicaSets(oldRSs) > 0) return true;
  for (const { uid, pods } of podMap) {
    // If the pods belong to the new ReplicaSet, ignore.
    if (newRS && uidOf(newRS) === uid) continue;
    for (const pod of pods) {
      const phase = podPhase(pod);
      if (phase === 'Failed' || phase === 'Succeeded') continue;
      return true;
    }
  }
  return false;
}
