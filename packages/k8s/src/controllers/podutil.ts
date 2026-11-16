// Pod helpers shared by controllers, on Pods as stored (v1 JSON).
// upstream: pkg/api/v1/pod/util.go IsPodReady, IsPodReadyConditionTrue, GetPodReadyCondition,
// GetPodCondition; staging/src/k8s.io/endpointslice/util/controller_utils.go isPodTerminal (the
// same rules, duplicated upstream for the staging module).

import type { Json, JsonObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { parseTime } from '../apimachinery/time.ts';

const isObj = (v: Json | undefined): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);

/** GetPodCondition(status, conditionType): the first condition of that type. */
export function getPodCondition(pod: ApiObject, type: string): JsonObject | undefined {
  const status = isObj(pod.status) ? pod.status : {};
  const conds = Array.isArray(status.conditions) ? status.conditions : [];
  for (const c of conds) if (isObj(c) && c.type === type) return c;
  return undefined;
}

/** GetPodReadyCondition. */
export function getPodReadyCondition(pod: ApiObject): JsonObject | undefined {
  return getPodCondition(pod, 'Ready');
}

/** IsPodReady: the Ready condition is True. */
export function isPodReady(pod: ApiObject): boolean {
  return getPodReadyCondition(pod)?.status === 'True';
}

/** The Pod's status.phase. */
export function podPhase(pod: ApiObject): string {
  const status = isObj(pod.status) ? pod.status : {};
  return typeof status.phase === 'string' ? status.phase : '';
}

/** IsPodTerminal: phase Failed or Succeeded. */
export function isPodTerminal(pod: ApiObject): boolean {
  const p = podPhase(pod);
  return p === 'Failed' || p === 'Succeeded';
}

/**
 * IsPodAvailable: Ready, and Ready for at least minReadySeconds by `now` (virtual ms).
 * upstream: pkg/api/v1/pod/util.go IsPodAvailable (LastTransitionTime + minReadySeconds <= now).
 */
export function isPodAvailable(pod: ApiObject, minReadySeconds: number, now: number): boolean {
  if (!isPodReady(pod)) return false;
  if (minReadySeconds === 0) return true;
  const t = getPodReadyCondition(pod)?.lastTransitionTime;
  const r = typeof t === 'string' && t !== '' ? parseTime(t, false) : undefined;
  if (r === undefined || !('micros' in r)) return false;
  return r.micros / 1000 + minReadySeconds * 1000 <= now;
}
