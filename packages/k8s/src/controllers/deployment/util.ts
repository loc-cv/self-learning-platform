// Deployment helpers: annotations, revisions, conditions, replica arithmetic, ReplicaSet lookups.
//
// upstream: pkg/controller/deployment/util/deployment_util.go
//
// A Deployment `d` is the controller's mutable copy (cloneJson of the stored object); functions
// that upstream calls with *apps.Deployment and that change it change `d` in place, as upstream.

import type { Millis } from '@simlab/kernel';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { getScaledValueFromIntOrPercent, type IntOrString } from '../../apimachinery/intstr.ts';
import { timeOf } from '../../apimachinery/time.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { replicaSetsByCreationTimestampLess, sortBy } from '../controller_utils.ts';
import { annotationsOf, generationOf, num, specOf, statusOf, timeMillis, uidOf } from '../objects.ts';

export const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
export const REVISION_HISTORY_ANNOTATION = 'deployment.kubernetes.io/revision-history';
export const DESIRED_REPLICAS_ANNOTATION = 'deployment.kubernetes.io/desired-replicas';
export const MAX_REPLICAS_ANNOTATION = 'deployment.kubernetes.io/max-replicas';
// upstream: staging/src/k8s.io/api/apps/v1/types.go DeprecatedRollbackTo, DefaultDeploymentUniqueLabelKey
export const DEPRECATED_ROLLBACK_TO = 'deprecated.deployment.rollback.to';
export const DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY = 'pod-template-hash';
// upstream: staging/src/k8s.io/api/core/v1/annotation_key_constants.go LastAppliedConfigAnnotation
const LAST_APPLIED_CONFIG_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';

// Event and condition reasons.
export const ROLLBACK_REVISION_NOT_FOUND = 'DeploymentRollbackRevisionNotFound';
export const ROLLBACK_TEMPLATE_UNCHANGED = 'DeploymentRollbackTemplateUnchanged';
export const ROLLBACK_DONE = 'DeploymentRollback';
export const REPLICA_SET_UPDATED_REASON = 'ReplicaSetUpdated';
export const FAILED_RS_CREATE_REASON = 'ReplicaSetCreateError';
export const NEW_REPLICA_SET_REASON = 'NewReplicaSetCreated';
export const FOUND_NEW_RS_REASON = 'FoundNewReplicaSet';
export const NEW_RS_AVAILABLE_REASON = 'NewReplicaSetAvailable';
export const TIMED_OUT_REASON = 'ProgressDeadlineExceeded';
export const PAUSED_DEPLOY_REASON = 'DeploymentPaused';
export const RESUMED_DEPLOY_REASON = 'DeploymentResumed';
export const MINIMUM_REPLICAS_AVAILABLE = 'MinimumReplicasAvailable';
export const MINIMUM_REPLICAS_UNAVAILABLE = 'MinimumReplicasUnavailable';

export const DEPLOYMENT_AVAILABLE = 'Available';
export const DEPLOYMENT_PROGRESSING = 'Progressing';
export const DEPLOYMENT_REPLICA_FAILURE = 'ReplicaFailure';

const MAX_INT32 = 2147483647;

// ---- spec and status accessors -------------------------------------------------------------

/** *(spec.replicas), defaulted by the API server. */
export const replicasOf = (o: ApiObject | undefined): number => (o ? num(specOf(o).replicas) : 0);
export const strategyType = (d: ApiObject): string => String((specOf(d).strategy as JsonObject | undefined)?.type ?? '');
export const minReadySecondsOf = (o: ApiObject): number => num(specOf(o).minReadySeconds);
export const isPaused = (d: ApiObject): boolean => specOf(d).paused === true;
const rollingUpdate = (d: ApiObject): JsonObject => ((specOf(d).strategy as JsonObject | undefined)?.rollingUpdate ?? {}) as JsonObject;
const templateOf = (o: ApiObject): JsonObject => (isObject(specOf(o).template) ? (specOf(o).template as JsonObject) : {});

export interface DeploymentCondition {
  type: string;
  status: string;
  lastUpdateTime?: string;
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

/** apps/v1 DeploymentStatus as the controller holds it. */
export interface DeploymentStatus {
  observedGeneration: number;
  replicas: number;
  updatedReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  unavailableReplicas: number;
  /** *int32: undefined is nil. */
  terminatingReplicas?: number;
  conditions: DeploymentCondition[];
  /** *int32: undefined is nil. */
  collisionCount?: number;
}

export function readDeploymentStatus(d: ApiObject): DeploymentStatus {
  const s = statusOf(d);
  return {
    observedGeneration: num(s.observedGeneration),
    replicas: num(s.replicas),
    updatedReplicas: num(s.updatedReplicas),
    readyReplicas: num(s.readyReplicas),
    availableReplicas: num(s.availableReplicas),
    unavailableReplicas: num(s.unavailableReplicas),
    ...(typeof s.terminatingReplicas === 'number' ? { terminatingReplicas: s.terminatingReplicas } : {}),
    conditions: Array.isArray(s.conditions) ? (cloneJson(s.conditions) as unknown as DeploymentCondition[]) : [],
    ...(typeof s.collisionCount === 'number' ? { collisionCount: s.collisionCount } : {}),
  };
}

/** The status as Go's encoding/json writes it (omitempty fields left out when zero), in field order. */
export function deploymentStatusJson(s: DeploymentStatus): JsonObject {
  const out: JsonObject = {};
  if (s.observedGeneration) out.observedGeneration = s.observedGeneration;
  if (s.replicas) out.replicas = s.replicas;
  if (s.updatedReplicas) out.updatedReplicas = s.updatedReplicas;
  if (s.readyReplicas) out.readyReplicas = s.readyReplicas;
  if (s.availableReplicas) out.availableReplicas = s.availableReplicas;
  if (s.unavailableReplicas) out.unavailableReplicas = s.unavailableReplicas;
  if (s.terminatingReplicas !== undefined) out.terminatingReplicas = s.terminatingReplicas;
  if (s.conditions.length > 0) out.conditions = s.conditions as unknown as JsonObject[];
  if (s.collisionCount !== undefined) out.collisionCount = s.collisionCount;
  return out;
}

/** reflect.DeepEqual of two statuses. */
export const deploymentStatusEqual = (a: DeploymentStatus, b: DeploymentStatus): boolean => jsonEqual(deploymentStatusJson(a), deploymentStatusJson(b));

/** The controller's working copy of a Deployment: the object, with its status typed. */
export interface Deployment {
  /** The mutable object; `status` is written from `status` below before every write. */
  obj: JsonObject;
  status: DeploymentStatus;
}

export function deploymentOf(stored: ApiObject): Deployment {
  const obj = cloneJson(stored);
  return { obj, status: readDeploymentStatus(obj) };
}

/** The object to send: the working copy with its current status. */
export function deploymentBody(d: Deployment): JsonObject {
  return { ...d.obj, status: deploymentStatusJson(d.status) };
}

// ---- conditions -----------------------------------------------------------------------------

/** NewDeploymentCondition: both times now. */
export function newDeploymentCondition(type: string, status: string, reason: string, message: string, now: Millis): DeploymentCondition {
  const t = timeOf(now);
  return { type, status, lastUpdateTime: t, lastTransitionTime: t, ...(reason ? { reason } : {}), ...(message ? { message } : {}) };
}

export function getDeploymentCondition(status: DeploymentStatus, type: string): DeploymentCondition | undefined {
  const c = status.conditions.find((x) => x.type === type);
  return c ? { ...c } : undefined;
}

/**
 * SetDeploymentCondition: no change when status and reason are the same; otherwise the condition
 * replaces the old one at the end of the list, keeping lastTransitionTime when the status is the same.
 */
export function setDeploymentCondition(status: DeploymentStatus, condition: DeploymentCondition): void {
  const cur = getDeploymentCondition(status, condition.type);
  if (cur && cur.status === condition.status && cur.reason === condition.reason) return;
  const c = { ...condition };
  if (cur && cur.status === condition.status) {
    if (cur.lastTransitionTime === undefined) delete c.lastTransitionTime;
    else c.lastTransitionTime = cur.lastTransitionTime;
  }
  status.conditions = [...status.conditions.filter((x) => x.type !== condition.type), c];
}

export function removeDeploymentCondition(status: DeploymentStatus, type: string): void {
  status.conditions = status.conditions.filter((x) => x.type !== type);
}

/** ReplicaSetToDeploymentCondition: lastUpdateTime is the ReplicaSet condition's lastTransitionTime. */
export function replicaSetToDeploymentCondition(c: JsonObject): DeploymentCondition {
  const out: DeploymentCondition = { type: String(c.type), status: String(c.status) };
  if (typeof c.lastTransitionTime === 'string') {
    out.lastUpdateTime = c.lastTransitionTime;
    out.lastTransitionTime = c.lastTransitionTime;
  }
  if (typeof c.reason === 'string' && c.reason) out.reason = c.reason;
  if (typeof c.message === 'string' && c.message) out.message = c.message;
  return out;
}

// ---- annotations and revisions ----------------------------------------------------------------

function ensureAnnotations(o: JsonObject): JsonObject {
  const m = (isObject(o.metadata) ? o.metadata : (o.metadata = {})) as JsonObject;
  if (!isObject(m.annotations)) m.annotations = {};
  return m.annotations as JsonObject;
}

/** SetDeploymentRevision: whether the revision annotation changed. */
export function setDeploymentRevision(d: Deployment, revision: string): boolean {
  const a = ensureAnnotations(d.obj);
  if (a[REVISION_ANNOTATION] !== revision) {
    a[REVISION_ANNOTATION] = revision;
    return true;
  }
  return false;
}

/** strconv.ParseInt(s, 10, 64). */
function parseInt64(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = BigInt(s);
  if (n > (1n << 63n) - 1n || n < -(1n << 63n)) return undefined;
  return Number(n);
}

/** Revision: the revision annotation as a number, 0 when absent; an unparsable one is an error (undefined). */
export function revisionOf(o: ApiObject): number | undefined {
  const v = annotationsOf(o)[REVISION_ANNOTATION];
  if (v === undefined) return 0;
  return parseInt64(v);
}

/** MaxRevision: the highest revision among the ReplicaSets (unparsable ones are skipped). */
export function maxRevision(sets: readonly (ApiObject | undefined)[]): number {
  let max = 0;
  for (const rs of sets) {
    if (!rs) continue;
    const v = revisionOf(rs);
    if (v !== undefined && v > max) max = v;
  }
  return max;
}

/** LastRevision: the second highest revision. */
export function lastRevision(sets: readonly (ApiObject | undefined)[]): number {
  let max = 0;
  let secMax = 0;
  for (const rs of sets) {
    if (!rs) continue;
    const v = revisionOf(rs);
    if (v === undefined) continue;
    if (v >= max) {
      secMax = max;
      max = v;
    } else if (v > secMax) secMax = v;
  }
  return secMax;
}

// annotationsToSkip: never copied between a Deployment and its ReplicaSets.
const ANNOTATIONS_TO_SKIP = new Set([LAST_APPLIED_CONFIG_ANNOTATION, REVISION_ANNOTATION, REVISION_HISTORY_ANNOTATION, DESIRED_REPLICAS_ANNOTATION, MAX_REPLICAS_ANNOTATION, DEPRECATED_ROLLBACK_TO]);
const skipCopyAnnotation = (k: string): boolean => ANNOTATIONS_TO_SKIP.has(k);

/** copyDeploymentAnnotationsToReplicaSet: whether any annotation was added or changed. */
function copyDeploymentAnnotationsToReplicaSet(d: Deployment, rs: JsonObject): boolean {
  let changed = false;
  const ra = ensureAnnotations(rs);
  const da = annotationsOf(d.obj);
  for (const k of Object.keys(da).sort()) {
    if (skipCopyAnnotation(k) || (k in ra && ra[k] === da[k])) continue;
    ra[k] = da[k] as string;
    changed = true;
  }
  return changed;
}

/**
 * SetNewReplicaSetAnnotations: copies the Deployment's annotations, raises the revision (keeping
 * the old one in revision-history, within revHistoryLimitInChars), and on a new ReplicaSet sets
 * desired-replicas and max-replicas. Whether anything changed.
 */
export function setNewReplicaSetAnnotations(d: Deployment, rs: JsonObject, newRevision: string, exists: boolean, revHistoryLimitInChars: number): boolean {
  let changed = copyDeploymentAnnotationsToReplicaSet(d, rs);
  const ra = ensureAnnotations(rs);
  const ok = REVISION_ANNOTATION in ra;
  const oldRevision = typeof ra[REVISION_ANNOTATION] === 'string' ? (ra[REVISION_ANNOTATION] as string) : '';
  let oldRevisionInt = parseInt64(oldRevision);
  if (oldRevisionInt === undefined) {
    if (oldRevision !== '') return false;
    oldRevisionInt = 0;
  }
  const newRevisionInt = parseInt64(newRevision);
  if (newRevisionInt === undefined) return false;
  if (oldRevisionInt < newRevisionInt) {
    ra[REVISION_ANNOTATION] = newRevision;
    changed = true;
  }
  if (ok && oldRevisionInt < newRevisionInt) {
    const history = typeof ra[REVISION_HISTORY_ANNOTATION] === 'string' ? (ra[REVISION_HISTORY_ANNOTATION] as string) : '';
    let oldRevisions = history.split(',');
    if ((oldRevisions[0] as string).length === 0) {
      ra[REVISION_HISTORY_ANNOTATION] = oldRevision;
    } else {
      let totalLen = history.length + oldRevision.length + 1;
      let start = 0;
      while (totalLen > revHistoryLimitInChars && start < oldRevisions.length) {
        totalLen = totalLen - (oldRevisions[start] as string).length - 1;
        start++;
      }
      if (totalLen <= revHistoryLimitInChars) {
        oldRevisions = [...oldRevisions.slice(start), oldRevision];
        ra[REVISION_HISTORY_ANNOTATION] = oldRevisions.join(',');
      }
      // else upstream logs "Not appending revision due to revision history length limit reached".
    }
  }
  if (!exists && setReplicasAnnotations(rs, replicasOf(d.obj), replicasOf(d.obj) + maxSurge(d.obj))) changed = true;
  return changed;
}

/** SetDeploymentAnnotationsTo: the Deployment keeps its skipped annotations and takes the others from the ReplicaSet. */
export function setDeploymentAnnotationsTo(d: Deployment, rollbackToRS: ApiObject): void {
  const kept: JsonObject = {};
  const da = annotationsOf(d.obj);
  for (const k of Object.keys(da)) if (skipCopyAnnotation(k)) kept[k] = da[k] as string;
  const ra = annotationsOf(rollbackToRS);
  for (const k of Object.keys(ra)) if (!skipCopyAnnotation(k)) kept[k] = ra[k] as string;
  ((isObject(d.obj.metadata) ? d.obj.metadata : (d.obj.metadata = {})) as JsonObject).annotations = kept;
}

/** strconv.ParseUint(s, 10, 32) bounded by MaxInt32: getNonNegativeInt32FromAnnotation. */
function nonNegativeInt32Annotation(rs: ApiObject, key: string): number | undefined {
  const v = annotationsOf(rs)[key];
  if (v === undefined || !/^[0-9]+$/.test(v)) return undefined;
  const n = Number(v);
  if (n > 4294967295 || n > MAX_INT32) return undefined;
  return n;
}

export const getDesiredReplicasAnnotation = (rs: ApiObject): number | undefined => nonNegativeInt32Annotation(rs, DESIRED_REPLICAS_ANNOTATION);
const getMaxReplicasAnnotation = (rs: ApiObject): number | undefined => nonNegativeInt32Annotation(rs, MAX_REPLICAS_ANNOTATION);

/** SetReplicasAnnotations: whether either annotation changed. */
export function setReplicasAnnotations(rs: JsonObject, desiredReplicas: number, maxReplicas: number): boolean {
  let updated = false;
  const ra = ensureAnnotations(rs);
  if (ra[DESIRED_REPLICAS_ANNOTATION] !== String(desiredReplicas)) {
    ra[DESIRED_REPLICAS_ANNOTATION] = String(desiredReplicas);
    updated = true;
  }
  if (ra[MAX_REPLICAS_ANNOTATION] !== String(maxReplicas)) {
    ra[MAX_REPLICAS_ANNOTATION] = String(maxReplicas);
    updated = true;
  }
  return updated;
}

export function replicasAnnotationsNeedUpdate(rs: ApiObject, desiredReplicas: number, maxReplicas: number): boolean {
  const ra = annotationsOf(rs);
  return ra[DESIRED_REPLICAS_ANNOTATION] !== String(desiredReplicas) || ra[MAX_REPLICAS_ANNOTATION] !== String(maxReplicas);
}

// ---- replica arithmetic -----------------------------------------------------------------------

export const isRollingUpdate = (d: ApiObject): boolean => strategyType(d) === 'RollingUpdate';

/**
 * ResolveFenceposts: maxSurge rounded up, maxUnavailable rounded down, both of `desired`; if both
 * are zero, maxUnavailable is 1. A missing value counts as 0.
 */
export function resolveFenceposts(maxSurgeV: Json | undefined, maxUnavailableV: Json | undefined, desired: number): { surge: number; unavailable: number } | { error: string } {
  const surge = getScaledValueFromIntOrPercent((maxSurgeV ?? 0) as IntOrString, desired, true);
  if ('error' in surge) return surge;
  const unavailable = getScaledValueFromIntOrPercent((maxUnavailableV ?? 0) as IntOrString, desired, false);
  if ('error' in unavailable) return unavailable;
  if (surge.value === 0 && unavailable.value === 0) return { surge: 0, unavailable: 1 };
  return { surge: surge.value, unavailable: unavailable.value };
}

/** MaxUnavailable: 0 unless RollingUpdate with replicas; never more than the replicas. */
export function maxUnavailable(d: ApiObject): number {
  if (!isRollingUpdate(d) || replicasOf(d) === 0) return 0;
  const ru = rollingUpdate(d);
  const r = resolveFenceposts(ru.maxSurge, ru.maxUnavailable, replicasOf(d));
  const u = 'error' in r ? 0 : r.unavailable;
  return u > replicasOf(d) ? replicasOf(d) : u;
}

/** MaxSurge: 0 unless RollingUpdate. */
export function maxSurge(d: ApiObject): number {
  if (!isRollingUpdate(d)) return 0;
  const ru = rollingUpdate(d);
  const r = resolveFenceposts(ru.maxSurge, ru.maxUnavailable, replicasOf(d));
  return 'error' in r ? 0 : r.surge;
}

/** upstream: vendor/k8s.io/utils/integer/integer.go RoundToInt32 = int32(math.Round(a)), half away from zero. */
function roundToInt32(a: number): number {
  return a < 0 ? Math.trunc(a - 0.5) : Math.trunc(a + 0.5);
}

/**
 * getReplicaSetFraction: how much a ReplicaSet should grow or shrink when the Deployment scales,
 * proportional to its share of the max-replicas recorded before the scale.
 */
function getReplicaSetFraction(rs: ApiObject, d: Deployment): number {
  if (replicasOf(d.obj) === 0) return -replicasOf(rs);
  const deploymentMaxReplicas = replicasOf(d.obj) + maxSurge(d.obj);
  let before = getMaxReplicasAnnotation(rs);
  if (before === undefined || before === 0) {
    before = d.status.replicas;
    if (before === 0) return 0;
  }
  const scaleBase = replicasOf(rs);
  // float64(scaleBase * deploymentMaxReplicas): the product is int32 arithmetic upstream.
  const product = Math.imul(scaleBase, deploymentMaxReplicas);
  return roundToInt32(product / before) - replicasOf(rs);
}

/** GetReplicaSetProportion: the share of `toAdd` for this ReplicaSet, within what is left to add. */
export function getReplicaSetProportion(rs: ApiObject | undefined, d: Deployment, toAdd: number, added: number): number {
  if (!rs || replicasOf(rs) === 0 || toAdd === 0 || toAdd === added) return 0;
  const fraction = getReplicaSetFraction(rs, d);
  const allowed = toAdd - added;
  return toAdd > 0 ? Math.min(fraction, allowed) : Math.max(fraction, allowed);
}

const sum = (sets: readonly (ApiObject | undefined)[], f: (rs: ApiObject) => number): number => sets.reduce((n, rs) => (rs ? n + f(rs) : n), 0);
export const getReplicaCountForReplicaSets = (sets: readonly (ApiObject | undefined)[]): number => sum(sets, replicasOf);
export const getActualReplicaCountForReplicaSets = (sets: readonly (ApiObject | undefined)[]): number => sum(sets, (rs) => num(statusOf(rs).replicas));
export const getReadyReplicaCountForReplicaSets = (sets: readonly (ApiObject | undefined)[]): number => sum(sets, (rs) => num(statusOf(rs).readyReplicas));
export const getAvailableReplicaCountForReplicaSets = (sets: readonly (ApiObject | undefined)[]): number => sum(sets, (rs) => num(statusOf(rs).availableReplicas));

/**
 * GetTerminatingReplicaCountForReplicaSets: the sum, or nil when a ReplicaSet the ReplicaSet
 * controller has synced does not report it. One it never synced is skipped.
 */
export function getTerminatingReplicaCountForReplicaSets(sets: readonly (ApiObject | undefined)[]): number | undefined {
  let n = 0;
  for (const rs of sets) {
    if (!rs) continue;
    const s = statusOf(rs);
    const t = s.terminatingReplicas;
    if (num(s.observedGeneration) === 0 && typeof t !== 'number') continue;
    if (typeof t !== 'number') return undefined;
    n += t;
  }
  return n;
}

/** DeploymentComplete: every replica updated and available, and the latest generation observed. */
export function deploymentComplete(d: Deployment, s: DeploymentStatus): boolean {
  const r = replicasOf(d.obj);
  return s.updatedReplicas === r && s.replicas === r && s.availableReplicas === r && s.observedGeneration >= generationOf(d.obj);
}

/** DeploymentProgressing: more updated, fewer old, more ready or more available replicas than before. */
export function deploymentProgressing(d: Deployment, s: DeploymentStatus): boolean {
  const old = d.status;
  const oldStatusOldReplicas = old.replicas - old.updatedReplicas;
  const newStatusOldReplicas = s.replicas - s.updatedReplicas;
  return s.updatedReplicas > old.updatedReplicas || newStatusOldReplicas < oldStatusOldReplicas || s.readyReplicas > old.readyReplicas || s.availableReplicas > old.availableReplicas;
}

/** DeploymentTimedOut: the Progressing condition was last updated more than progressDeadlineSeconds ago. */
export function deploymentTimedOut(d: Deployment, s: DeploymentStatus, now: Millis): boolean {
  if (!hasProgressDeadline(d.obj)) return false;
  const c = getDeploymentCondition(s, DEPLOYMENT_PROGRESSING);
  if (!c) return false;
  if (c.reason === NEW_RS_AVAILABLE_REASON) return false;
  if (c.reason === TIMED_OUT_REASON) return true;
  const from = timeMillis(c.lastUpdateTime);
  return from + progressDeadlineSecondsOf(d.obj) * 1000 < now;
}

/** NewRSNewReplicas: the size the new ReplicaSet may have now. */
export function newRSNewReplicas(d: ApiObject, allRSs: readonly (ApiObject | undefined)[], newRS: ApiObject): { value: number } | { error: string } {
  switch (strategyType(d)) {
    case 'RollingUpdate': {
      const surge = getScaledValueFromIntOrPercent((rollingUpdate(d).maxSurge ?? null) as IntOrString | null, replicasOf(d), true);
      if ('error' in surge) return surge;
      const currentPodCount = getReplicaCountForReplicaSets(allRSs);
      const maxTotalPods = replicasOf(d) + surge.value;
      if (currentPodCount >= maxTotalPods) return { value: replicasOf(newRS) };
      const scaleUpCount = Math.min(maxTotalPods - currentPodCount, replicasOf(d) - replicasOf(newRS));
      return { value: replicasOf(newRS) + scaleUpCount };
    }
    case 'Recreate':
      return { value: replicasOf(d) };
    default:
      return { error: `deployment type ${strategyType(d)} isn't supported` };
  }
}

/** IsSaturated: the new ReplicaSet has, wants and makes available all the Deployment's replicas. */
export function isSaturated(d: ApiObject, rs: ApiObject | undefined): boolean {
  if (!rs) return false;
  const s = annotationsOf(rs)[DESIRED_REPLICAS_ANNOTATION] ?? '';
  if (!/^[+-]?[0-9]+$/.test(s)) return false;
  const desired = Number(s);
  return replicasOf(rs) === replicasOf(d) && desired === replicasOf(d) && num(statusOf(rs).availableReplicas) === replicasOf(d);
}

export function progressDeadlineSecondsOf(d: ApiObject): number {
  return num(specOf(d).progressDeadlineSeconds);
}

/** HasProgressDeadline: set and not MaxInt32. */
export function hasProgressDeadline(d: ApiObject): boolean {
  const v = specOf(d).progressDeadlineSeconds;
  return typeof v === 'number' && v !== MAX_INT32;
}

/** HasRevisionHistoryLimit: set and not MaxInt32. */
export function hasRevisionHistoryLimit(d: ApiObject): boolean {
  const v = specOf(d).revisionHistoryLimit;
  return typeof v === 'number' && v !== MAX_INT32;
}

// ---- templates and ReplicaSet lookups ---------------------------------------------------------

/**
 * Semantic.DeepEqual on decoded JSON: empty and absent maps and slices are equal. Values are as
 * the API server stored them, so quantities are already canonical.
 */
function semanticEqual(a: Json | undefined, b: Json | undefined): boolean {
  const emptyOrNil = (v: Json | undefined): boolean => v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);
  if (emptyOrNil(a) && emptyOrNil(b) && (Array.isArray(a) || Array.isArray(b) || isObject(a) || isObject(b) || (a ?? null) === (b ?? null))) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => semanticEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!semanticEqual(a[k], b[k])) return false;
    return true;
  }
  return a === b;
}

/** EqualIgnoreHash: the templates are equal once the pod-template-hash label is removed from both. */
export function equalIgnoreHash(t1: Json | undefined, t2: Json | undefined): boolean {
  const strip = (t: Json | undefined): Json => {
    const c = isObject(t) ? cloneJson(t) : {};
    const labels = (c.metadata as JsonObject | undefined)?.labels;
    if (isObject(labels)) delete labels[DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY];
    return c;
  };
  return semanticEqual(strip(t1), strip(t2));
}

/** FindNewReplicaSet: the oldest ReplicaSet whose template equals the Deployment's. Sorts rsList in place, as upstream. */
export function findNewReplicaSet(d: ApiObject, rsList: ApiObject[]): ApiObject | undefined {
  sortBy(rsList, replicaSetsByCreationTimestampLess);
  return rsList.find((rs) => equalIgnoreHash(templateOf(rs), templateOf(d)));
}

/** FindOldReplicaSets: the old ReplicaSets with replicas, and all old ReplicaSets. */
export function findOldReplicaSets(d: ApiObject, rsList: ApiObject[]): { required: ApiObject[]; all: ApiObject[] } {
  const newRS = findNewReplicaSet(d, rsList);
  const required: ApiObject[] = [];
  const all: ApiObject[] = [];
  for (const rs of rsList) {
    if (newRS && uidOf(rs) === uidOf(newRS)) continue;
    all.push(rs);
    if (replicasOf(rs) !== 0) required.push(rs);
  }
  return { required, all };
}

/** SetFromReplicaSetTemplate: the Deployment takes the ReplicaSet's template, without the pod-template-hash label. */
export function setFromReplicaSetTemplate(d: Deployment, template: Json | undefined): void {
  const t = isObject(template) ? cloneJson(template) : {};
  const labels = (t.metadata as JsonObject | undefined)?.labels;
  if (isObject(labels)) {
    delete labels[DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY];
  }
  if (!isObject(d.obj.spec)) d.obj.spec = {};
  (d.obj.spec as JsonObject).template = t;
}

/** FindActiveOrLatest: the only active ReplicaSet, or the newest when none is active. Sorts oldRSs in place. */
export function findActiveOrLatest(newRS: ApiObject | undefined, oldRSs: ApiObject[]): ApiObject | undefined {
  if (!newRS && oldRSs.length === 0) return undefined;
  sortBy(oldRSs, (a, b) => replicaSetsByCreationTimestampLess(b, a));
  const all = [...oldRSs, newRS].filter((rs): rs is ApiObject => rs !== undefined && replicasOf(rs) > 0);
  switch (all.length) {
    case 0:
      return newRS ?? oldRSs[0];
    case 1:
      return all[0];
    default:
      return undefined;
  }
}

/** ReplicaSetsByRevision.Less: lower revision first; creation time when equal or unparsable. */
export function replicaSetsByRevisionLess(a: ApiObject, b: ApiObject): boolean {
  const r1 = revisionOf(a);
  const r2 = revisionOf(b);
  if (r1 === undefined || r2 === undefined || r1 === r2) return replicaSetsByCreationTimestampLess(a, b);
  return r1 < r2;
}


/** A metav1.Time of a condition in virtual milliseconds (0 when absent). */
export const timeMillisOf = (t: string | undefined): Millis => timeMillis(t);
