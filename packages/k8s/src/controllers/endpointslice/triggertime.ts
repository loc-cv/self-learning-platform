// TriggerTimeTracker: the value of the endpoints.kubernetes.io/last-change-trigger-time
// annotation both endpoint controllers write. upstream:
// staging/src/k8s.io/endpointslice/util/trigger_time_tracker.go. The tracker lives in the
// controller process's memory; here in the controller's data under `triggerTimes`, so a restart
// forgets it as a restarted process does.
//
// A Pod's trigger time is its Ready condition's lastTransitionTime, a Service's its creation
// timestamp. The result is the earliest trigger time that is newer than what the last sync saw,
// zero (undefined) when nothing changed, and the Service's creation time on the first sync of a
// Service the tracker does not know.

import type { Json } from '../../apimachinery/json.ts';
import { parseTime, timeOf } from '../../apimachinery/time.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { getPodReadyCondition } from '../podutil.ts';
import type { SyncCtx } from '../types.ts';
import { metaOf, str } from './util.ts';

const DATA_KEY = 'triggerTimes';

interface ServiceState {
  /** lastServiceTriggerTime, ms (0 = zero time). */
  service: number;
  /** lastPodTriggerTimes by Pod name, ms. */
  pods: Record<string, number>;
}

/** A metav1.Time string as ms; 0 for absent or unparsable (Go's zero time). */
export function timeMs(v: Json | undefined): number {
  const r = parseTime(str(v), false);
  return 'micros' in r ? r.micros / 1000 : 0;
}

function states(c: SyncCtx): Record<string, ServiceState> {
  return (c.data()[DATA_KEY] as unknown as Record<string, ServiceState> | undefined) ?? {};
}

function save(c: SyncCtx, key: string, st: ServiceState | undefined): void {
  const all = { ...states(c) };
  if (st === undefined) delete all[key];
  else all[key] = st;
  c.setData(DATA_KEY, all as unknown as Json);
}

/** ComputeEndpointLastChangeTriggerTime; ms, or undefined for the zero time. */
export function computeEndpointLastChangeTriggerTime(c: SyncCtx, namespace: string, svc: ApiObject, pods: readonly ApiObject[]): number | undefined {
  const key = `${namespace}/${str(metaOf(svc).name)}`;
  const known = states(c)[key];
  const state: ServiceState = known ?? { service: 0, pods: {} };
  let minChanged = 0;
  const min = (cur: number, v: number): number => (cur === 0 || v < cur ? v : cur);
  const podTimes: Record<string, number> = {};
  for (const pod of pods) {
    const t = timeMs(getPodReadyCondition(pod)?.lastTransitionTime);
    if (t === 0) continue;
    const name = str(metaOf(pod).name);
    podTimes[name] = t;
    if (t > (state.pods[name] ?? 0)) minChanged = min(minChanged, t);
  }
  const serviceTime = timeMs(metaOf(svc).creationTimestamp);
  if (serviceTime > state.service) minChanged = min(minChanged, serviceTime);
  save(c, key, { service: serviceTime, pods: podTimes });
  if (!known) return serviceTime === 0 ? undefined : serviceTime;
  return minChanged === 0 ? undefined : minChanged;
}

/** DeleteService. */
export function deleteServiceTriggerTimes(c: SyncCtx, namespace: string, name: string): void {
  if (states(c)[`${namespace}/${name}`]) save(c, `${namespace}/${name}`, undefined);
}

/** The annotation value: triggerTime.UTC().Format(time.RFC3339Nano). */
export function formatTriggerTime(ms: number): string {
  // RFC3339Nano drops a zero fraction; every input is a metav1.Time (whole seconds), so this is
  // metav1.Time's own format.
  return timeOf(ms);
}
