// What the EndpointSlice controller made of a Service in one sync, as a trace record
// (`endpoints.sync`): every Pod its selector matched, whether it became a ready endpoint, and if
// not, why. The reasons are the conditions the code that builds the slices applies
// (util.ts shouldPodBeInEndpoints, reconciler.ts podToEndpoint and the Node lookup), named by
// code; the views put them into words. Trace only: it reads what the sync read and writes nothing.

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { getPodReadyCondition, isPodReady, isPodTerminal, podPhase } from '../podutil.ts';
import type { SyncCtx } from '../types.ts';
import { metaOf, objs, specOf, statusOf, str } from './util.ts';

/** Why a matched Pod is not a ready endpoint. */
export type NotReadyWhy = 'terminal' | 'noIP' | 'nodeNotFound' | 'terminating' | 'notReady';

export interface Member {
  name: string;
  uid: string;
  /** Listed in a slice (ready or not). */
  endpoint: boolean;
  /** conditions.ready of its endpoint. */
  ready: boolean;
  why?: NotReadyWhy;
  phase: string;
  /** The reason of the Pod's Ready condition when it is not True (the kubelet's `ContainersNotReady`). */
  readyReason?: string;
  node?: string;
}

/** The membership of one Pod, by the rules reconcileByAddressType and podToEndpoint apply. */
function member(c: SyncCtx, svc: ApiObject, pod: ApiObject): Member {
  const m = metaOf(pod);
  const phase = podPhase(pod);
  const node = str(specOf(pod).nodeName);
  const base = { name: str(m.name), uid: str(m.uid), phase, ...(node !== '' ? { node } : {}) };
  const publishNotReady = specOf(svc).publishNotReadyAddresses === true;
  if (isPodTerminal(pod)) return { ...base, endpoint: false, ready: false, why: 'terminal' };
  const status = statusOf(pod);
  if (str(status.podIP) === '' && objs(status.podIPs).length === 0) return { ...base, endpoint: false, ready: false, why: 'noIP' };
  if (!c.get('v1/nodes', undefined, node) && !publishNotReady) return { ...base, endpoint: false, ready: false, why: 'nodeNotFound' };
  const serving = isPodReady(pod);
  const terminating = Boolean(m.deletionTimestamp);
  if (publishNotReady || (serving && !terminating)) return { ...base, endpoint: true, ready: true };
  if (terminating) return { ...base, endpoint: true, ready: false, why: 'terminating' };
  const reason = str(getPodReadyCondition(pod)?.reason);
  return { ...base, endpoint: true, ready: false, why: 'notReady', ...(reason !== '' ? { readyReason: reason } : {}) };
}

/** The endpoints of the slices, as a string to compare before and after a sync. */
export function sliceSignature(slices: readonly ApiObject[]): string {
  const eps: string[] = [];
  for (const s of slices) {
    for (const ep of objs(s.endpoints)) {
      const ref = (ep.targetRef ?? {}) as JsonObject;
      const cond = (ep.conditions ?? {}) as JsonObject;
      eps.push(`${str(ref.namespace)}/${str(ref.name)}/${str(ref.uid)}:${JSON.stringify(ep.addresses ?? [])}:${String(cond.ready)}:${String(cond.terminating)}`);
    }
  }
  return `${slices.length}|${eps.sort().join(',')}`;
}

/**
 * Records the Service's membership after a sync. `selector` null: the Service has none, so the
 * controller leaves its endpoints to whoever writes them. `changed`: the sync wrote the slices.
 */
export function traceMembership(c: SyncCtx, svc: ApiObject, selector: Record<string, string> | null, pods: readonly ApiObject[], changed: boolean): void {
  const namespace = str(metaOf(svc).namespace);
  const name = str(metaOf(svc).name);
  const members = pods.map((p) => member(c, svc, p));
  const ready = members.filter((x) => x.ready).length;
  const message =
    selector === null
      ? `Service ${namespace}/${name} has no selector: its endpoints are not managed by the controller`
      : `Service ${namespace}/${name} selects ${members.length} Pod(s): ${ready} ready, ${members.length - ready} not${changed ? '; EndpointSlices updated' : ''}`;
  c.trace('endpoints.sync', message, { namespace, name, uid: str(metaOf(svc).uid), selector: selector as Json, changed, pods: members as unknown as Json }, `${namespace}/${name}`);
}
