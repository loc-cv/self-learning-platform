// ReplicaSet status: counting the Pods, the ReplicaFailure condition, the status write.
//
// upstream: pkg/controller/replicaset/replica_set_utils.go (updateReplicaSetStatus,
// calculateStatus, NewReplicaSetCondition, GetCondition, SetCondition, RemoveCondition)

import type { Millis } from '@simlab/kernel';
import { jsonEqual, type JsonObject } from '../../apimachinery/json.ts';
import { selectorFromSet, selectorMatches } from '../../apimachinery/labels.ts';
import { timeOf } from '../../apimachinery/time.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { Client } from '../../client/client.ts';
import { apiError, generationOf, labelsOf, namespaceOf, nameOf, num, specOf, statusOf, stringMap, type ApiError } from '../objects.ts';
import { isPodAvailable, isPodReady } from '../podutil.ts';

/** statusUpdateRetries: one retry after a failed status write. */
export const STATUS_UPDATE_RETRIES = 1;

export const REPLICA_SET_REPLICA_FAILURE = 'ReplicaFailure';

export interface ReplicaSetCondition {
  type: string;
  status: string;
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

/** apps/v1 ReplicaSetStatus as the controller computes it. */
export interface ReplicaSetStatus {
  replicas: number;
  fullyLabeledReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  /** *int32: undefined is nil. */
  terminatingReplicas?: number;
  observedGeneration: number;
  conditions: ReplicaSetCondition[];
}

export function readReplicaSetStatus(rs: ApiObject): ReplicaSetStatus {
  const s = statusOf(rs);
  return {
    replicas: num(s.replicas),
    fullyLabeledReplicas: num(s.fullyLabeledReplicas),
    readyReplicas: num(s.readyReplicas),
    availableReplicas: num(s.availableReplicas),
    ...(typeof s.terminatingReplicas === 'number' ? { terminatingReplicas: s.terminatingReplicas } : {}),
    observedGeneration: num(s.observedGeneration),
    conditions: Array.isArray(s.conditions) ? (s.conditions as unknown as ReplicaSetCondition[]) : [],
  };
}

/** The status as Go's encoding/json writes it: omitempty fields left out when zero. */
export function replicaSetStatusJson(s: ReplicaSetStatus): JsonObject {
  const out: JsonObject = { replicas: s.replicas };
  if (s.fullyLabeledReplicas) out.fullyLabeledReplicas = s.fullyLabeledReplicas;
  if (s.readyReplicas) out.readyReplicas = s.readyReplicas;
  if (s.availableReplicas) out.availableReplicas = s.availableReplicas;
  if (s.terminatingReplicas !== undefined) out.terminatingReplicas = s.terminatingReplicas;
  if (s.observedGeneration) out.observedGeneration = s.observedGeneration;
  if (s.conditions.length > 0) out.conditions = s.conditions as unknown as JsonObject[];
  return out;
}

export function newReplicaSetCondition(type: string, status: string, reason: string, message: string, now: Millis): ReplicaSetCondition {
  // omitempty: an empty reason or message is not written.
  return { type, status, lastTransitionTime: timeOf(now), ...(reason ? { reason } : {}), ...(message ? { message } : {}) };
}

export function getCondition(status: ReplicaSetStatus, type: string): ReplicaSetCondition | undefined {
  return status.conditions.find((c) => c.type === type);
}

/** SetCondition: replaces the condition of that type, moving it to the end, unless status and reason are unchanged. */
export function setCondition(status: ReplicaSetStatus, cond: ReplicaSetCondition): void {
  const cur = getCondition(status, cond.type);
  if (cur && cur.status === cond.status && cur.reason === cond.reason) return;
  status.conditions = [...status.conditions.filter((c) => c.type !== cond.type), cond];
}

export function removeCondition(status: ReplicaSetStatus, type: string): void {
  status.conditions = status.conditions.filter((c) => c.type !== type);
}

/**
 * calculateStatus: counts of the active Pods (fully labeled, ready, available), terminatingReplicas
 * (DeploymentReplicaSetTerminatingReplicas is beta and on at the pin), and the ReplicaFailure
 * condition set on a manageReplicas error and removed once it passes.
 */
export function calculateStatus(rs: ApiObject, activePods: readonly ApiObject[], terminatingPods: readonly ApiObject[], manageReplicasErr: ApiError | undefined, now: Millis): ReplicaSetStatus {
  const newStatus = readReplicaSetStatus(rs);
  const template = specOf(rs).template as JsonObject | undefined;
  const templateLabel = selectorFromSet(stringMap((template?.metadata as JsonObject | undefined)?.labels));
  const minReadySeconds = num(specOf(rs).minReadySeconds);
  let fullyLabeled = 0;
  let ready = 0;
  let available = 0;
  for (const pod of activePods) {
    if (selectorMatches(templateLabel, labelsOf(pod))) fullyLabeled++;
    if (isPodReady(pod)) {
      ready++;
      if (isPodAvailable(pod, minReadySeconds, now)) available++;
    }
  }
  const failureCond = getCondition(readReplicaSetStatus(rs), REPLICA_SET_REPLICA_FAILURE);
  if (manageReplicasErr && !failureCond) {
    const diff = activePods.length - num(specOf(rs).replicas);
    const reason = diff < 0 ? 'FailedCreate' : diff > 0 ? 'FailedDelete' : '';
    setCondition(newStatus, newReplicaSetCondition(REPLICA_SET_REPLICA_FAILURE, 'True', reason, manageReplicasErr.message, now));
  } else if (!manageReplicasErr && failureCond) {
    removeCondition(newStatus, REPLICA_SET_REPLICA_FAILURE);
  }
  newStatus.replicas = activePods.length;
  newStatus.fullyLabeledReplicas = fullyLabeled;
  newStatus.readyReplicas = ready;
  newStatus.availableReplicas = available;
  newStatus.terminatingReplicas = terminatingPods.length;
  return newStatus;
}

/**
 * updateReplicaSetStatus: writes the status (with observedGeneration = generation) unless nothing
 * changed; on failure re-reads the ReplicaSet and tries once more.
 */
export function updateReplicaSetStatus(client: Client, rs: ApiObject, newStatus: ReplicaSetStatus): { rs: ApiObject } | { error: ApiError } {
  const cur = readReplicaSetStatus(rs);
  if (
    cur.replicas === newStatus.replicas &&
    cur.fullyLabeledReplicas === newStatus.fullyLabeledReplicas &&
    cur.readyReplicas === newStatus.readyReplicas &&
    cur.availableReplicas === newStatus.availableReplicas &&
    cur.terminatingReplicas === newStatus.terminatingReplicas &&
    generationOf(rs) === cur.observedGeneration &&
    jsonEqual(cur.conditions as unknown as JsonObject[], newStatus.conditions as unknown as JsonObject[])
  ) {
    return { rs };
  }
  newStatus.observedGeneration = generationOf(rs);
  const rsc = client.resource('apps/v1/replicasets');
  let target = rs;
  let updateErr: ApiError | undefined;
  for (let i = 0; ; i++) {
    const res = rsc.updateStatus(namespaceOf(target), { ...target, status: replicaSetStatusJson(newStatus) });
    if (res.ok) return { rs: res.object as ApiObject };
    updateErr = apiError(res);
    if (i >= STATUS_UPDATE_RETRIES) break;
    const fresh = rsc.get(namespaceOf(target), nameOf(target));
    const getErr = apiError(fresh);
    if (getErr) return { error: getErr };
    target = (fresh.ok ? fresh.object : {}) as ApiObject;
  }
  return { error: updateErr as ApiError };
}
