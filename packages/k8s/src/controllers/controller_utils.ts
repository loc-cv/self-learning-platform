// The shared helpers of pkg/controller/controller_utils.go that ReplicaSet-like controllers use:
// active and terminating Pod filters, the deletion ranking of Pods, owner lookups, ReplicaSet
// orderings, the next availability check.
//
// upstream: pkg/controller/controller_utils.go

import type { Millis } from '@simlab/kernel';
import { compareGoStrings, selectorMatches, type Selector } from '../apimachinery/labels.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { annotationsOf, creationMicros, getControllerOf, isControlledBy, isDeleting, labelsOf, metaOf, nameOf, namespaceOf, num, specOf, statusOf, timeMicros, uidOf } from './objects.ts';
import { getPodReadyCondition, isPodReady, isPodTerminal, podPhase } from './podutil.ts';

/** SlowStartInitialBatchSize: the first batch of a slow start creates one object. */
export const SLOW_START_INITIAL_BATCH_SIZE = 1;

/** IsPodActive: not Succeeded, not Failed, not being deleted. */
export function isPodActive(p: ApiObject): boolean {
  const phase = podPhase(p);
  return phase !== 'Succeeded' && phase !== 'Failed' && !isDeleting(p);
}

/** IsPodTerminating: being deleted and not yet terminal. */
export function isPodTerminating(p: ApiObject): boolean {
  return !isPodTerminal(p) && isDeleting(p);
}

export const filterActivePods = (pods: readonly ApiObject[]): ApiObject[] => pods.filter(isPodActive);
export const filterTerminatingPods = (pods: readonly ApiObject[]): ApiObject[] => pods.filter(isPodTerminating);

/** FilterClaimedPods: controlled by `controller` and matching its selector. */
export function filterClaimedPods(controller: ApiObject, selector: Selector, pods: readonly ApiObject[]): ApiObject[] {
  return pods.filter((p) => isControlledBy(p, controller) && selectorMatches(selector, labelsOf(p)));
}

/** PodKey: `namespace/name`. */
export const podKey = (p: ApiObject): string => `${namespaceOf(p)}/${nameOf(p)}`;

/**
 * FilterPodsByOwner over the PodControllerIndex: the Pods of `owner`'s namespace whose controller
 * reference is (kind, name, uid) of the owner, then, with includeOrphanedPods, those without a
 * controller reference. The index returns a set (no defined order); here each group keeps the
 * store's key order.
 */
export function filterPodsByOwner(pods: readonly ApiObject[], owner: ApiObject, ownerKind: string, includeOrphanedPods: boolean): ApiObject[] {
  const ns = namespaceOf(owner);
  const inNs = pods.filter((p) => namespaceOf(p) === ns);
  const owned = inNs.filter((p) => {
    const ref = getControllerOf(p);
    return ref !== undefined && ref.kind === ownerKind && ref.name === nameOf(owner) && ref.uid === uidOf(owner);
  });
  if (!includeOrphanedPods) return owned;
  return [...owned, ...inNs.filter((p) => getControllerOf(p) === undefined)];
}

// podPhaseToOrdinal: Pending < Unknown < Running; other phases count as 0 (Go map zero value).
const PHASE_ORDINAL: Readonly<Record<string, number>> = { Pending: 0, Unknown: 1, Running: 2 };
const phaseOrdinal = (p: ApiObject): number => PHASE_ORDINAL[podPhase(p)] ?? 0;

/** podReadyTime: the Ready condition's lastTransitionTime when Ready, else the zero time (undefined). */
function podReadyTime(p: ApiObject): number | undefined {
  if (!isPodReady(p)) return undefined;
  return timeMicros(getPodReadyCondition(p)?.lastTransitionTime);
}

/** afterOrZero: a zero time sorts first, else the later time first. */
function afterOrZero(t1: number | undefined, t2: number | undefined): boolean {
  if (t1 === undefined || t2 === undefined) return t1 === undefined;
  return t1 > t2;
}

/** maxContainerRestarts: the most restarts of a regular container and of a restartable init container. */
function maxContainerRestarts(p: ApiObject): [number, number] {
  const status = statusOf(p);
  let regular = 0;
  for (const c of (status.containerStatuses ?? []) as { restartCount?: number }[]) regular = Math.max(regular, num(c.restartCount));
  const sidecars = new Set<string>();
  for (const c of (specOf(p).initContainers ?? []) as { name?: string; restartPolicy?: string }[]) if (c.restartPolicy === 'Always') sidecars.add(c.name ?? '');
  let sidecar = 0;
  for (const c of (status.initContainerStatuses ?? []) as { name?: string; restartCount?: number }[]) if (sidecars.has(c.name ?? '')) sidecar = Math.max(sidecar, num(c.restartCount));
  return [regular, sidecar];
}

function compareMaxContainerRestarts(pi: ApiObject, pj: ApiObject): boolean | undefined {
  const [ri, si] = maxContainerRestarts(pi);
  const [rj, sj] = maxContainerRestarts(pj);
  if (ri !== rj) return ri > rj;
  if (si !== sj) return si > sj;
  return undefined;
}

const nodeNameOf = (p: ApiObject): string => (typeof specOf(p).nodeName === 'string' ? (specOf(p).nodeName as string) : '');

/**
 * logarithmicRankDiff: compares floor(log2(now - t)) of two times, durations in nanoseconds as
 * Go's time.Duration; a time not before now ranks -1.
 */
function logarithmicRankDiff(t1: number, t2: number, nowMicros: number): number {
  const rank = (t: number): number => {
    const d = (nowMicros - t) * 1000;
    return d > 0 ? Math.floor(Math.log2(d)) : -1;
  };
  return rank(t1) - rank(t2);
}

/**
 * controller.PodDeletionCost from the `controller.kubernetes.io/pod-deletion-cost` annotation
 * (PodDeletionCost is beta and on at the pin), 0 when absent or invalid.
 * upstream: pkg/apis/core/helper/helpers.go GetDeletionCostFromPodAnnotations, validFirstDigit
 */
export const POD_DELETION_COST = 'controller.kubernetes.io/pod-deletion-cost';
function deletionCost(p: ApiObject): number {
  const value = annotationsOf(p)[POD_DELETION_COST];
  if (value === undefined) return 0;
  const first = value[0];
  if (first === undefined || !(first === '-' || value === '0' || (first >= '1' && first <= '9'))) return 0;
  if (!/^[+-]?[0-9]+$/.test(value)) return 0;
  const n = Number(value);
  return n > 2147483647 || n < -2147483648 ? 0 : n;
}

/**
 * ActivePodsWithRanks.Less: which of two Pods to delete first when scaling down. `nowMicros` is
 * the ranking's Now (metav1.Now() when getPodsRankedByRelatedPodsOnSameNode builds it).
 */
export function activePodsWithRanksLess(pi: ApiObject, ri: number, pj: ApiObject, rj: number, nowMicros: number): boolean {
  // 1. Unassigned < assigned
  const ni = nodeNameOf(pi);
  const nj = nodeNameOf(pj);
  if (ni !== nj && (ni === '' || nj === '')) return ni === '';
  // 2. PodPending < PodUnknown < PodRunning
  if (phaseOrdinal(pi) !== phaseOrdinal(pj)) return phaseOrdinal(pi) < phaseOrdinal(pj);
  // 3. Not ready < ready
  if (isPodReady(pi) !== isPodReady(pj)) return !isPodReady(pi);
  // 4. lower pod-deletion-cost < higher pod-deletion-cost
  const ci = deletionCost(pi);
  const cj = deletionCost(pj);
  if (ci !== cj) return ci < cj;
  // 5. Doubled up < not doubled up
  if (ri !== rj) return ri > rj;
  // 6. Been ready for empty time < less time < more time, compared on a logarithmic scale
  if (isPodReady(pi) && isPodReady(pj)) {
    const t1 = podReadyTime(pi);
    const t2 = podReadyTime(pj);
    if (t1 !== t2) {
      if (t1 === undefined || t2 === undefined) return afterOrZero(t1, t2);
      const d = logarithmicRankDiff(t1, t2, nowMicros);
      if (d === 0) return compareGoStrings(uidOf(pi), uidOf(pj)) < 0;
      return d < 0;
    }
  }
  // 7. Pods with containers with higher restart counts < lower restart counts
  const restarts = compareMaxContainerRestarts(pi, pj);
  if (restarts !== undefined) return restarts;
  // 8. Empty creation time pods < newer pods < older pods, on a logarithmic scale
  const c1 = timeMicros(metaOf(pi).creationTimestamp);
  const c2 = timeMicros(metaOf(pj).creationTimestamp);
  if (c1 !== c2) {
    if (c1 === undefined || c2 === undefined) return afterOrZero(c1, c2);
    const d = logarithmicRankDiff(c1, c2, nowMicros);
    if (d === 0) return compareGoStrings(uidOf(pi), uidOf(pj)) < 0;
    return d < 0;
  }
  return false;
}

/** ActivePods.Less: the ranking without ranks, deletion cost or the logarithmic scale. */
export function activePodsLess(pi: ApiObject, pj: ApiObject): boolean {
  const ni = nodeNameOf(pi);
  const nj = nodeNameOf(pj);
  if (ni !== nj && (ni === '' || nj === '')) return ni === '';
  if (phaseOrdinal(pi) !== phaseOrdinal(pj)) return phaseOrdinal(pi) < phaseOrdinal(pj);
  if (isPodReady(pi) !== isPodReady(pj)) return !isPodReady(pi);
  if (isPodReady(pi) && isPodReady(pj)) {
    const t1 = podReadyTime(pi);
    const t2 = podReadyTime(pj);
    if (t1 !== t2) return afterOrZero(t1, t2);
  }
  const restarts = compareMaxContainerRestarts(pi, pj);
  if (restarts !== undefined) return restarts;
  const c1 = timeMicros(metaOf(pi).creationTimestamp);
  const c2 = timeMicros(metaOf(pj).creationTimestamp);
  if (c1 !== c2) return afterOrZero(c1, c2);
  return false;
}

/**
 * sort.Sort with a Less function. Go's pdqsort is an insertion sort for up to 12 elements, which
 * keeps equal elements in order; a stable sort gives the same result there and a defined one
 * beyond (where Go's order of equal elements is an implementation detail).
 */
export function sortBy<T>(items: T[], less: (a: T, b: T) => boolean): T[] {
  return items.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
}

const replicasOf = (rs: ApiObject): number => num(specOf(rs).replicas);

/** ReplicaSetsByCreationTimestamp.Less: older first, then by name. */
export function replicaSetsByCreationTimestampLess(a: ApiObject, b: ApiObject): boolean {
  const ta = creationMicros(a);
  const tb = creationMicros(b);
  if (ta === tb) return compareGoStrings(nameOf(a), nameOf(b)) < 0;
  return ta < tb;
}

/** ReplicaSetsBySizeOlder.Less: larger first, then older. */
export function replicaSetsBySizeOlderLess(a: ApiObject, b: ApiObject): boolean {
  if (replicasOf(a) === replicasOf(b)) return replicaSetsByCreationTimestampLess(a, b);
  return replicasOf(a) > replicasOf(b);
}

/** ReplicaSetsBySizeNewer.Less: larger first, then newer. */
export function replicaSetsBySizeNewerLess(a: ApiObject, b: ApiObject): boolean {
  if (replicasOf(a) === replicasOf(b)) return replicaSetsByCreationTimestampLess(b, a);
  return replicasOf(a) > replicasOf(b);
}

/** FilterActiveReplicaSets: the non-nil ReplicaSets with spec.replicas > 0. */
export function filterActiveReplicaSets(sets: readonly (ApiObject | undefined)[]): ApiObject[] {
  return sets.filter((rs): rs is ApiObject => rs !== undefined && replicasOf(rs) > 0);
}

/** nextPodAvailabilityCheck: time until a Ready Pod has been Ready for minReadySeconds, if still ahead. */
function nextPodAvailabilityCheck(p: ApiObject, minReadySeconds: number, now: Millis): Millis | undefined {
  if (!isPodReady(p) || minReadySeconds <= 0) return undefined;
  const t = timeMicros(getPodReadyCondition(p)?.lastTransitionTime);
  if (t === undefined) return undefined;
  const next = t / 1000 + minReadySeconds * 1000 - now;
  return next > 0 ? next : undefined;
}

/**
 * FindMinNextPodAvailabilityCheck. Upstream evaluates once at the owner's status time and again
 * at clock.Now(); a sync takes no virtual time, so both are `now`.
 */
export function findMinNextPodAvailabilityCheck(pods: readonly ApiObject[], minReadySeconds: number, now: Millis): Millis | undefined {
  let min: Millis | undefined;
  for (const p of pods) {
    const next = nextPodAvailabilityCheck(p, minReadySeconds, now);
    if (next !== undefined && (min === undefined || next < min)) min = next;
  }
  return min;
}
