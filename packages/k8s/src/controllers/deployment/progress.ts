// Rollout progress: the Progressing condition (NewReplicaSetAvailable, ReplicaSetUpdated,
// ProgressDeadlineExceeded), ReplicaFailure carried over from the ReplicaSets, and requeueing a
// Deployment so the progress deadline is checked when it passes.
//
// upstream: pkg/controller/deployment/progress.go (syncRolloutStatus, getReplicaFailures,
// requeueStuckDeployment)

import type { Millis } from '@simlab/kernel';
import type { JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { BACKOFF_BASE_MS } from '../runtime.ts';
import { keyOf, nameOf, statusOf, type ApiError } from '../objects.ts';
import type { SyncCtx } from '../types.ts';
import { calculateStatus, updateDeploymentStatus } from './sync.ts';
import {
  DEPLOYMENT_PROGRESSING,
  DEPLOYMENT_REPLICA_FAILURE,
  NEW_RS_AVAILABLE_REASON,
  REPLICA_SET_UPDATED_REASON,
  TIMED_OUT_REASON,
  deploymentComplete,
  deploymentProgressing,
  deploymentStatusEqual,
  deploymentTimedOut,
  getDeploymentCondition,
  hasProgressDeadline,
  newDeploymentCondition,
  progressDeadlineSecondsOf,
  removeDeploymentCondition,
  replicaSetToDeploymentCondition,
  setDeploymentCondition,
  timeMillisOf,
  type Deployment,
  type DeploymentCondition,
  type DeploymentStatus,
} from './util.ts';

/** syncRolloutStatus: the status of a rollout in progress, including the Progressing condition. */
export function syncRolloutStatus(c: SyncCtx, allRSs: (ApiObject | undefined)[], newRS: ApiObject | undefined, d: Deployment): ApiError | undefined {
  const newStatus = calculateStatus(allRSs, newRS, d, c.now);
  // If there is no progressDeadlineSeconds set, remove any Progressing condition.
  if (!hasProgressDeadline(d.obj)) removeDeploymentCondition(newStatus, DEPLOYMENT_PROGRESSING);
  // If there is only one replica set that is active then that means we are not running a new
  // rollout and this is a resync where we don't need to estimate any progress. In such a case, we
  // should simply not estimate any progress for this deployment.
  const currentCond = getDeploymentCondition(d.status, DEPLOYMENT_PROGRESSING);
  const isCompleteDeployment = newStatus.replicas === newStatus.updatedReplicas && currentCond !== undefined && currentCond.reason === NEW_RS_AVAILABLE_REASON;
  // Check for progress only if there is a progress deadline set and the latest rollout hasn't
  // completed yet.
  if (hasProgressDeadline(d.obj) && !isCompleteDeployment) {
    if (deploymentComplete(d, newStatus)) {
      // Update the deployment conditions with a message for the new replica set that was
      // successfully deployed. If the condition already exists, we ignore this update.
      const msg = newRS ? `ReplicaSet "${nameOf(newRS)}" has successfully progressed.` : `Deployment "${nameOf(d.obj)}" has successfully progressed.`;
      setDeploymentCondition(newStatus, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'True', NEW_RS_AVAILABLE_REASON, msg, c.now));
    } else if (deploymentProgressing(d, newStatus)) {
      // If there is any progress made, continue by not checking if the deployment failed. This
      // behavior emulates the rolling updater progressDeadline check.
      const msg = newRS ? `ReplicaSet "${nameOf(newRS)}" is progressing.` : `Deployment "${nameOf(d.obj)}" is progressing.`;
      const condition = newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'True', REPLICA_SET_UPDATED_REASON, msg, c.now);
      // Update the current Progressing condition or add a new one if it doesn't exist. If a
      // Progressing condition with status=true already exists, we should update everything but
      // lastTransitionTime. SetDeploymentCondition already does that but it also is not going to
      // update conditions where the reason is not changed. We also need to update the
      // lastUpdateTime.
      if (currentCond) {
        if (currentCond.status === 'True') {
          if (currentCond.lastTransitionTime === undefined) delete condition.lastTransitionTime;
          else condition.lastTransitionTime = currentCond.lastTransitionTime;
        }
        removeDeploymentCondition(newStatus, DEPLOYMENT_PROGRESSING);
      }
      setDeploymentCondition(newStatus, condition);
    } else if (deploymentTimedOut(d, newStatus, c.now)) {
      // Update the deployment with a timeout condition. If the condition already exists, we
      // ignore this update.
      const msg = newRS ? `ReplicaSet "${nameOf(newRS)}" has timed out progressing.` : `Deployment "${nameOf(d.obj)}" has timed out progressing.`;
      setDeploymentCondition(newStatus, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'False', TIMED_OUT_REASON, msg, c.now));
    }
  }
  // Move failure conditions of all replica sets in deployment conditions. For now, only one
  // failure condition is returned from getReplicaFailures.
  const failures = getReplicaFailures(allRSs, newRS);
  if (failures.length > 0) setDeploymentCondition(newStatus, failures[0] as DeploymentCondition);
  else removeDeploymentCondition(newStatus, DEPLOYMENT_REPLICA_FAILURE);

  // Do not update if there is nothing new to add.
  if (deploymentStatusEqual(d.status, newStatus)) {
    // Requeue the deployment if required.
    requeueStuckDeployment(c, d, newStatus);
    return undefined;
  }
  d.status = newStatus;
  return updateDeploymentStatus(c, d);
}

/** getReplicaFailures: ReplicaFailure conditions of the new ReplicaSet, else of any ReplicaSet. */
function getReplicaFailures(allRSs: readonly (ApiObject | undefined)[], newRS: ApiObject | undefined): DeploymentCondition[] {
  const of = (rs: ApiObject): DeploymentCondition[] => {
    const conds = statusOf(rs).conditions;
    return Array.isArray(conds) ? (conds as JsonObject[]).filter((x) => x.type === DEPLOYMENT_REPLICA_FAILURE).map(replicaSetToDeploymentCondition) : [];
  };
  if (newRS) {
    const own = of(newRS);
    if (own.length > 0) return own;
  }
  return allRSs.flatMap((rs) => (rs ? of(rs) : []));
}

/**
 * requeueStuckDeployment: a Deployment in progress comes back when its deadline passes (one second
 * after, to be sure), or right away (rate limited) when that is less than a second away. Returns
 * the delay, or -1 when nothing was queued.
 */
export function requeueStuckDeployment(c: SyncCtx, d: Deployment, newStatus: DeploymentStatus): Millis {
  const currentCond = getDeploymentCondition(d.status, DEPLOYMENT_PROGRESSING);
  // Can't estimate progress if there is no deadline in the spec or progressing condition in the
  // current status.
  if (!hasProgressDeadline(d.obj) || !currentCond) return -1;
  // No need to estimate progress if the rollout is complete or already timed out.
  if (deploymentComplete(d, newStatus) || currentCond.reason === TIMED_OUT_REASON) return -1;
  // If there is no sign of progress at this point then there is a high chance that the deployment
  // is stuck. We should resync this deployment at some point in the future[1] and check whether it
  // has timed out. We definitely need this, otherwise we depend on the controller resync interval.
  const after = timeMillisOf(currentCond.lastUpdateTime) + progressDeadlineSecondsOf(d.obj) * 1000 - c.now;
  // If the remaining time is less than a second, then requeue the deployment immediately. Make
  // sure it will be checked by the controller after the deadline has passed.
  if (after < 1000) {
    // enqueueRateLimited: 5 ms · 2^(failures of the key so far), then the successful sync makes
    // the rate limiter forget the key. The failure count is the runtime's; after successful
    // syncs it is 0, and the base delay is used here in every case.
    c.enqueueAfter(keyOf(d.obj), BACKOFF_BASE_MS);
    return 0;
  }
  c.enqueueAfter(keyOf(d.obj), after + 1000);
  return after;
}
