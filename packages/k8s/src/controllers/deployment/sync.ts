// Deployment sync: finding or creating the new ReplicaSet, scaling (including proportional scaling
// of several active ReplicaSets), cleaning up old ReplicaSets, and the status.
//
// upstream: pkg/controller/deployment/sync.go
//
// Upstream discards the object an UpdateStatus returns and keeps working on its own copy `d`, so a
// second status write in the same sync carries the old resourceVersion and fails with a conflict;
// the key is requeued and the next sync starts from the stored object. The same happens here.

import type { JsonObject } from '../../apimachinery/json.ts';
import { cloneJson } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { computeHash } from '../hash/podtemplate.ts';
import { filterActiveReplicaSets, replicaSetsBySizeNewerLess, replicaSetsBySizeOlderLess, sortBy } from '../controller_utils.ts';
import { annotationsOf, apiError, generationOf, getControllerOf, isAlreadyExists, isDeleting, isNamespaceTerminating, isNotFound, nameOf, namespaceOf, newControllerRef, num, specOf, statusOf, uidOf, type ApiError } from '../objects.ts';
import type { SyncCtx } from '../types.ts';
import {
  DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY,
  DEPLOYMENT_AVAILABLE,
  DEPLOYMENT_PROGRESSING,
  FAILED_RS_CREATE_REASON,
  FOUND_NEW_RS_REASON,
  MINIMUM_REPLICAS_AVAILABLE,
  MINIMUM_REPLICAS_UNAVAILABLE,
  NEW_REPLICA_SET_REASON,
  PAUSED_DEPLOY_REASON,
  REVISION_ANNOTATION,
  RESUMED_DEPLOY_REASON,
  TIMED_OUT_REASON,
  deploymentBody,
  deploymentStatusEqual,
  equalIgnoreHash,
  findActiveOrLatest,
  findNewReplicaSet,
  findOldReplicaSets,
  getActualReplicaCountForReplicaSets,
  getAvailableReplicaCountForReplicaSets,
  getDeploymentCondition,
  getDesiredReplicasAnnotation,
  getReadyReplicaCountForReplicaSets,
  getReplicaCountForReplicaSets,
  getReplicaSetProportion,
  getTerminatingReplicaCountForReplicaSets,
  hasProgressDeadline,
  hasRevisionHistoryLimit,
  isPaused,
  isRollingUpdate,
  isSaturated,
  maxRevision,
  maxSurge,
  maxUnavailable,
  minReadySecondsOf,
  newDeploymentCondition,
  newRSNewReplicas,
  replicaSetsByRevisionLess,
  replicasAnnotationsNeedUpdate,
  replicasOf,
  setDeploymentCondition,
  setDeploymentRevision,
  setNewReplicaSetAnnotations,
  setReplicasAnnotations,
  type Deployment,
  type DeploymentStatus,
} from './util.ts';
import { getRollbackTo } from './rollback.ts';

const RS = 'apps/v1/replicasets';
const DEPLOYMENTS = 'apps/v1/deployments';

/** replicaSetNameSeparator */
const REPLICA_SET_NAME_SEPARATOR = '-';
/** maxRevHistoryLengthInChars: the revision-history annotation is kept below this length. */
const MAX_REV_HISTORY_LENGTH_IN_CHARS = 2000;
/** validation.DNS1123SubdomainMaxLength */
const DNS1123_SUBDOMAIN_MAX_LENGTH = 253;

/** The Deployment's status write (UpdateStatus) with the working copy as it is. */
export function updateDeploymentStatus(c: SyncCtx, d: Deployment): ApiError | undefined {
  return apiError(c.client.resource(DEPLOYMENTS).updateStatus(namespaceOf(d.obj), deploymentBody(d)));
}

/** syncStatusOnly: only the status, for a Deployment being deleted. */
export function syncStatusOnly(c: SyncCtx, d: Deployment, rsList: ApiObject[]): ApiError | undefined {
  const r = getAllReplicaSetsAndSyncRevision(c, d, rsList, false);
  if ('error' in r) return r.error;
  return syncDeploymentStatus(c, [...r.oldRSs, r.newRS], r.newRS, d);
}

/** sync: scaling and status, for a paused Deployment or a scaling event; no rollout. */
export function sync(c: SyncCtx, d: Deployment, rsList: ApiObject[]): ApiError | undefined {
  const r = getAllReplicaSetsAndSyncRevision(c, d, rsList, false);
  if ('error' in r) return r.error;
  const err = scale(c, d, r.newRS, r.oldRSs);
  if (err) return err;
  // Clean up the Deployment when it is paused and no rollback is in flight.
  if (isPaused(d.obj) && getRollbackTo(d) === undefined) {
    const e = cleanupDeployment(c, r.oldRSs, d);
    if (e) return e;
  }
  return syncDeploymentStatus(c, [...r.oldRSs, r.newRS], r.newRS, d);
}

/**
 * checkPausedConditions: the Progressing condition says DeploymentPaused while paused and
 * DeploymentResumed once resumed, unless the deadline already passed.
 */
export function checkPausedConditions(c: SyncCtx, d: Deployment): ApiError | undefined {
  if (!hasProgressDeadline(d.obj)) return undefined;
  const cond = getDeploymentCondition(d.status, DEPLOYMENT_PROGRESSING);
  if (cond && cond.reason === TIMED_OUT_REASON) return undefined;
  const pausedCondExists = cond !== undefined && cond.reason === PAUSED_DEPLOY_REASON;
  let needsUpdate = false;
  if (isPaused(d.obj) && !pausedCondExists) {
    setDeploymentCondition(d.status, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'Unknown', PAUSED_DEPLOY_REASON, 'Deployment is paused', c.now));
    needsUpdate = true;
  } else if (!isPaused(d.obj) && pausedCondExists) {
    setDeploymentCondition(d.status, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'Unknown', RESUMED_DEPLOY_REASON, 'Deployment is resumed', c.now));
    needsUpdate = true;
  }
  if (!needsUpdate) return undefined;
  return updateDeploymentStatus(c, d);
}

export type ReplicaSets = { newRS: ApiObject | undefined; oldRSs: ApiObject[] } | { error: ApiError };

/** getAllReplicaSetsAndSyncRevision: the new ReplicaSet (created when asked) and all old ones. */
export function getAllReplicaSetsAndSyncRevision(c: SyncCtx, d: Deployment, rsList: ApiObject[], createIfNotExisted: boolean): ReplicaSets {
  const { all } = findOldReplicaSets(d.obj, rsList);
  const r = getNewReplicaSet(c, d, rsList, all, createIfNotExisted);
  if ('error' in r) return r;
  return { newRS: r.rs, oldRSs: all };
}

/** generateReplicaSetName: `<deployment>-<hash>`, the name cut so the whole fits a DNS subdomain. */
function generateReplicaSetName(deploymentName: string, hash: string): string {
  const max = DNS1123_SUBDOMAIN_MAX_LENGTH - REPLICA_SET_NAME_SEPARATOR.length - hash.length;
  if (deploymentName.length > max && max > 0) return deploymentName.slice(0, max) + REPLICA_SET_NAME_SEPARATOR + hash;
  return deploymentName + REPLICA_SET_NAME_SEPARATOR + hash;
}

/**
 * getNewReplicaSet: the ReplicaSet whose template matches the Deployment's, with its revision and
 * annotations brought up to date; or, when asked, a new one named after the template's hash. A
 * name already taken by a different template raises status.collisionCount and fails the sync, so
 * the next one tries another hash.
 */
function getNewReplicaSet(c: SyncCtx, d: Deployment, rsList: ApiObject[], oldRSs: ApiObject[], createIfNotExisted: boolean): { rs: ApiObject | undefined } | { error: ApiError } {
  const existingNewRS = findNewReplicaSet(d.obj, rsList);
  const newRevision = String(maxRevision(oldRSs) + 1);

  if (existingNewRS) {
    const rsCopy = cloneJson(existingNewRS);
    // Set existing new replica set's annotation
    const annotationsUpdated = setNewReplicaSetAnnotations(d, rsCopy, newRevision, true, MAX_REV_HISTORY_LENGTH_IN_CHARS);
    const minReadySecondsNeedsUpdate = minReadySecondsOf(rsCopy) !== minReadySecondsOf(d.obj);
    if (annotationsUpdated || minReadySecondsNeedsUpdate) {
      const spec = rsCopy.spec as JsonObject;
      if (minReadySecondsOf(d.obj) === 0) delete spec.minReadySeconds;
      else spec.minReadySeconds = minReadySecondsOf(d.obj);
      const res = c.client.resource(RS).update(namespaceOf(rsCopy), rsCopy);
      const err = apiError(res);
      return err ? { error: err } : { rs: (res.ok ? res.object : rsCopy) as ApiObject };
    }
    // Should use the revision in existingNewRS's annotation, since it set by before
    let needsUpdate = setDeploymentRevision(d, annotationsOf(rsCopy)[REVISION_ANNOTATION] ?? '');
    // If no other Progressing condition has been recorded and we need to estimate the progress
    // of this deployment then it is likely that old users started caring about progress. In that
    // case we need to take into account the first time we noticed their new replica set.
    const cond = getDeploymentCondition(d.status, DEPLOYMENT_PROGRESSING);
    if (hasProgressDeadline(d.obj) && !cond) {
      setDeploymentCondition(d.status, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'True', FOUND_NEW_RS_REASON, `Found new replica set "${nameOf(rsCopy)}"`, c.now));
      needsUpdate = true;
    }
    if (needsUpdate) {
      const err = updateDeploymentStatus(c, d);
      if (err) return { error: err };
    }
    return { rs: rsCopy };
  }

  if (!createIfNotExisted) return { rs: undefined };

  // new ReplicaSet does not exist, create one.
  const newRSTemplate = cloneJson(specOf(d.obj).template as JsonObject);
  const hash = computeHash(newRSTemplate, d.status.collisionCount);
  const tmeta = (newRSTemplate.metadata ?? (newRSTemplate.metadata = {})) as JsonObject;
  tmeta.labels = { ...((tmeta.labels ?? {}) as JsonObject), [DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY]: hash };
  // labelsutil.CloneSelectorAndAddLabel: the hash joins matchLabels; matchExpressions are kept.
  const selector = cloneJson((specOf(d.obj).selector ?? {}) as JsonObject);
  selector.matchLabels = { ...((selector.matchLabels ?? {}) as JsonObject), [DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY]: hash };
  const newRS: JsonObject = {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: generateReplicaSetName(nameOf(d.obj), hash),
      namespace: namespaceOf(d.obj),
      ownerReferences: [newControllerRef(d.obj, 'apps/v1', 'Deployment')],
      labels: cloneJson(tmeta.labels),
    },
    spec: {
      replicas: 0,
      ...(minReadySecondsOf(d.obj) !== 0 ? { minReadySeconds: minReadySecondsOf(d.obj) } : {}),
      selector,
      template: newRSTemplate,
    },
  };
  const allRSs = [...oldRSs, newRS];
  const count = newRSNewReplicas(d.obj, allRSs, newRS);
  if ('error' in count) return { error: { message: count.error, code: 0, reason: '', causes: [] } };
  (newRS.spec as JsonObject).replicas = count.value;
  // Set new replica set's annotation
  setNewReplicaSetAnnotations(d, newRS, newRevision, false, MAX_REV_HISTORY_LENGTH_IN_CHARS);
  // Create the new ReplicaSet. If it already exists, then we need to check for possible
  // hash collisions. If there is any other error, we need to report it in the status of
  // the Deployment.
  let alreadyExists = false;
  const res = c.client.resource(RS).create(namespaceOf(d.obj), newRS);
  const createErr = apiError(res);
  let createdRS: ApiObject | undefined = res.ok ? (res.object as ApiObject) : undefined;
  if (isAlreadyExists(createErr)) {
    alreadyExists = true;
    // Fetch a copy of the ReplicaSet.
    const rs = c.get(RS, namespaceOf(newRS), nameOf(newRS));
    if (!rs) return { error: { message: `replicaset.apps "${nameOf(newRS)}" not found`, code: 404, reason: 'NotFound', causes: [] } };
    // If the Deployment owns the ReplicaSet and the ReplicaSet's PodTemplateSpec is semantically
    // deep equal to the PodTemplateSpec of the Deployment, it's the Deployment's new ReplicaSet.
    // Otherwise, this is a hash collision and we need to increment the collisionCount field in
    // the status of the Deployment and requeue to try the creation in the next sync.
    const ref = getControllerOf(rs);
    if (ref && ref.uid === uidOf(d.obj) && equalIgnoreHash(specOf(d.obj).template, specOf(rs).template)) {
      createdRS = rs;
    } else {
      // Matching ReplicaSet is not equal - increment the collisionCount in the DeploymentStatus
      // and requeue the Deployment.
      d.status.collisionCount = (d.status.collisionCount ?? 0) + 1;
      // Update the collisionCount for the Deployment and let it requeue by returning the original
      // error.
      updateDeploymentStatus(c, d);
      return { error: createErr as ApiError };
    }
  } else if (isNamespaceTerminating(createErr)) {
    // if the namespace is terminating, all subsequent creates will fail and we can safely do nothing
    return { error: createErr as ApiError };
  } else if (createErr) {
    const msg = `Failed to create new replica set "${nameOf(newRS)}": ${createErr.message}`;
    if (hasProgressDeadline(d.obj)) {
      setDeploymentCondition(d.status, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'False', FAILED_RS_CREATE_REASON, msg, c.now));
      // We don't really care about this error at this point, since we have a bigger issue to report.
      updateDeploymentStatus(c, d);
    }
    c.event(d.obj, 'Warning', FAILED_RS_CREATE_REASON, msg);
    return { error: createErr };
  }
  const created = createdRS as ApiObject;
  if (!alreadyExists && count.value > 0) {
    c.event(d.obj, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${nameOf(created)} from 0 to ${count.value}`);
  }
  let needsUpdate = setDeploymentRevision(d, newRevision);
  if (!alreadyExists && hasProgressDeadline(d.obj)) {
    setDeploymentCondition(d.status, newDeploymentCondition(DEPLOYMENT_PROGRESSING, 'True', NEW_REPLICA_SET_REASON, `Created new replica set "${nameOf(created)}"`, c.now));
    needsUpdate = true;
  }
  if (needsUpdate) {
    const err = updateDeploymentStatus(c, d);
    if (err) return { error: err };
  }
  return { rs: created };
}

/**
 * scale: scales the active ReplicaSets when the Deployment's replicas change. With one active
 * ReplicaSet (or none) it takes all; when the new one is saturated the old ones go to zero; in the
 * middle of a rolling update the change is spread over all active ReplicaSets in proportion to
 * their size, the leftover going to the largest (newest when growing, oldest when shrinking).
 */
function scale(c: SyncCtx, d: Deployment, newRS: ApiObject | undefined, oldRSs: ApiObject[]): ApiError | undefined {
  // If there is only one active replica set then we should scale that up to the full count of the
  // deployment. If there is no active replica set, then we should scale up the newest replica set.
  const activeOrLatest = findActiveOrLatest(newRS, oldRSs);
  if (activeOrLatest) {
    if (replicasOf(activeOrLatest) === replicasOf(d.obj)) return undefined;
    return scaleReplicaSet(c, activeOrLatest, replicasOf(d.obj), d, false).error;
  }
  // If the new replica set is saturated, old replica sets should be fully scaled down.
  if (isSaturated(d.obj, newRS)) {
    for (const old of filterActiveReplicaSets(oldRSs)) {
      const r = scaleReplicaSet(c, old, 0, d, false);
      if (r.error) return r.error;
    }
    return undefined;
  }
  // There are old replica sets with pods and the new replica set is not saturated.
  if (isRollingUpdate(d.obj)) {
    const allRSs = filterActiveReplicaSets([...oldRSs, newRS]);
    const allRSsReplicas = getReplicaCountForReplicaSets(allRSs);
    const allowedSize = replicasOf(d.obj) > 0 ? replicasOf(d.obj) + maxSurge(d.obj) : 0;
    // Number of additional replicas that can be either added or removed from the total replicas
    // count. These replicas should be distributed proportionally to the active replica sets.
    const toAdd = allowedSize - allRSsReplicas;
    if (toAdd > 0) sortBy(allRSs, replicaSetsBySizeNewerLess);
    else if (toAdd < 0) sortBy(allRSs, replicaSetsBySizeOlderLess);
    let added = 0;
    const nameToSize = new Map<string, number>();
    for (const rs of allRSs) {
      if (toAdd !== 0) {
        const proportion = getReplicaSetProportion(rs, d, toAdd, added);
        nameToSize.set(nameOf(rs), replicasOf(rs) + proportion);
        added += proportion;
      } else {
        nameToSize.set(nameOf(rs), replicasOf(rs));
      }
    }
    // Update all replica sets
    for (let i = 0; i < allRSs.length; i++) {
      const rs = allRSs[i] as ApiObject;
      // Add/remove any leftovers to the largest replica set.
      if (i === 0 && toAdd !== 0) {
        const size = (nameToSize.get(nameOf(rs)) ?? 0) + (toAdd - added);
        nameToSize.set(nameOf(rs), size < 0 ? 0 : size);
      }
      const r = scaleReplicaSet(c, rs, nameToSize.get(nameOf(rs)) ?? 0, d, true);
      if (r.error) return r.error;
    }
  }
  return undefined;
}

export interface ScaleResult {
  scaled: boolean;
  rs: ApiObject;
  error?: ApiError;
}

/**
 * scaleReplicaSet: sets spec.replicas and the desired-replicas and max-replicas annotations, and
 * records ScalingReplicaSet when the size changed.
 */
export function scaleReplicaSet(c: SyncCtx, rs: ApiObject, newScale: number, d: Deployment, forceUpdate: boolean): ScaleResult {
  // No need to scale
  if (!forceUpdate && replicasOf(rs) === newScale) return { scaled: false, rs };
  const sizeNeedsUpdate = replicasOf(rs) !== newScale;
  const desired = replicasOf(d.obj);
  const max = desired + maxSurge(d.obj);
  const annotationsNeedUpdate = replicasAnnotationsNeedUpdate(rs, desired, max);
  if (!sizeNeedsUpdate && !annotationsNeedUpdate) return { scaled: false, rs };
  const oldScale = replicasOf(rs);
  const rsCopy = cloneJson(rs);
  (rsCopy.spec as JsonObject).replicas = newScale;
  setReplicasAnnotations(rsCopy, desired, max);
  const res = c.client.resource(RS).update(namespaceOf(rsCopy), rsCopy);
  const err = apiError(res);
  if (err) return { scaled: false, rs, error: err };
  const updated = res.ok ? (res.object as ApiObject) : rsCopy;
  if (sizeNeedsUpdate) {
    const op = oldScale < newScale ? 'up' : 'down';
    c.event(d.obj, 'Normal', 'ScalingReplicaSet', `Scaled ${op} replica set ${nameOf(updated)} from ${oldScale} to ${newScale}`);
    return { scaled: true, rs: updated };
  }
  return { scaled: false, rs: updated };
}

/**
 * cleanupDeployment: deletes the oldest old ReplicaSets beyond revisionHistoryLimit, of those that
 * are scaled to zero, have no Pods and whose status is current.
 */
export function cleanupDeployment(c: SyncCtx, oldRSs: ApiObject[], d: Deployment): ApiError | undefined {
  if (!hasRevisionHistoryLimit(d.obj)) return undefined;
  // Avoid deleting replica set with deletion timestamp set
  const cleanable = oldRSs.filter((rs) => !isDeleting(rs));
  const diff = cleanable.length - num(specOf(d.obj).revisionHistoryLimit);
  if (diff <= 0) return undefined;
  sortBy(cleanable, replicaSetsByRevisionLess);
  for (let i = 0; i < diff; i++) {
    const rs = cleanable[i] as ApiObject;
    // Avoid delete replica set with non-zero replica counts
    if (num(statusOf(rs).replicas) !== 0 || replicasOf(rs) !== 0 || generationOf(rs) > num(statusOf(rs).observedGeneration) || isDeleting(rs)) continue;
    const err = apiError(c.client.resource(RS).delete(namespaceOf(rs), nameOf(rs)));
    if (err && !isNotFound(err)) return err;
  }
  return undefined;
}

/** syncDeploymentStatus: writes the status calculated from the ReplicaSets, when it changed. */
export function syncDeploymentStatus(c: SyncCtx, allRSs: (ApiObject | undefined)[], newRS: ApiObject | undefined, d: Deployment): ApiError | undefined {
  const newStatus = calculateStatus(allRSs, newRS, d, c.now);
  if (deploymentStatusEqual(d.status, newStatus)) return undefined;
  d.status = newStatus;
  return updateDeploymentStatus(c, d);
}

/**
 * calculateStatus: the replica counts of the ReplicaSets and the Available condition (available
 * replicas at least replicas - maxUnavailable). Other conditions are carried over.
 */
export function calculateStatus(allRSs: readonly (ApiObject | undefined)[], newRS: ApiObject | undefined, d: Deployment, now: number): DeploymentStatus {
  const availableReplicas = getAvailableReplicaCountForReplicaSets(allRSs);
  const totalReplicas = getReplicaCountForReplicaSets(allRSs);
  const unavailableReplicas = Math.max(0, totalReplicas - availableReplicas);
  const status: DeploymentStatus = {
    observedGeneration: generationOf(d.obj),
    replicas: getActualReplicaCountForReplicaSets(allRSs),
    updatedReplicas: getActualReplicaCountForReplicaSets([newRS]),
    readyReplicas: getReadyReplicaCountForReplicaSets(allRSs),
    availableReplicas,
    unavailableReplicas,
    conditions: d.status.conditions.map((x) => ({ ...x })),
    ...(d.status.collisionCount !== undefined ? { collisionCount: d.status.collisionCount } : {}),
  };
  // DeploymentReplicaSetTerminatingReplicas is beta and on at the pin.
  const terminating = getTerminatingReplicaCountForReplicaSets(allRSs);
  if (terminating !== undefined) status.terminatingReplicas = terminating;
  if (availableReplicas >= replicasOf(d.obj) - maxUnavailable(d.obj)) {
    setDeploymentCondition(status, newDeploymentCondition(DEPLOYMENT_AVAILABLE, 'True', MINIMUM_REPLICAS_AVAILABLE, 'Deployment has minimum availability.', now));
  } else {
    setDeploymentCondition(status, newDeploymentCondition(DEPLOYMENT_AVAILABLE, 'False', MINIMUM_REPLICAS_UNAVAILABLE, 'Deployment does not have minimum availability.', now));
  }
  return status;
}

/**
 * isScalingEvent: whether an active ReplicaSet's desired-replicas annotation differs from the
 * Deployment's replicas, which means the Deployment was scaled since the ReplicaSet was sized.
 */
export function isScalingEvent(c: SyncCtx, d: Deployment, rsList: ApiObject[]): { scaling: boolean } | { error: ApiError } {
  const r = getAllReplicaSetsAndSyncRevision(c, d, rsList, false);
  if ('error' in r) return r;
  for (const rs of filterActiveReplicaSets([...r.oldRSs, r.newRS])) {
    const desired = getDesiredReplicasAnnotation(rs);
    if (desired === undefined) continue;
    if (desired !== replicasOf(d.obj)) return { scaling: true };
  }
  return { scaling: false };
}
