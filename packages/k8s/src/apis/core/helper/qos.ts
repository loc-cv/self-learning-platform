// The QoS class of a Pod, set once by the API server at create time.
// upstream: pkg/apis/core/helper/qos/qos.go GetPodQOS, ComputePodQOS, requirementsQOS, resourceQOS.
// PodLevelResources and PodLevelResourcesFixKubeletQOSClass are on in v1.37.2: pod-level
// resources decide when they set cpu or memory (helper.IsPodLevelResourcesSet).

import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { equalQuantities, isZero, parseQuantity, type Quantity } from '../../../apimachinery/quantity.ts';

export type QOSClass = 'Guaranteed' | 'Burstable' | 'BestEffort';

const ZERO: Quantity = { rep: 'int64', unscaled: 0n, scale: 0, format: 'DecimalSI', s: '' };

function quantity(list: JsonObject | undefined, name: string): Quantity {
  const v = list?.[name];
  if (typeof v !== 'string') return ZERO;
  const q = parseQuantity(v);
  return 'error' in q ? ZERO : q;
}

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);

/** resourceQOS: a missing quantity counts as zero. */
function resourceQOS(res: JsonObject, name: string): QOSClass {
  const req = quantity(obj(res.requests), name);
  const lim = quantity(obj(res.limits), name);
  if (!equalQuantities(req, lim)) return 'Burstable';
  return isZero(req) ? 'BestEffort' : 'Guaranteed';
}

/** requirementsQOS over cpu and memory (supportedQoSComputeResources). */
function requirementsQOS(res: JsonObject | undefined): QOSClass {
  const requests = obj(res?.requests) ?? {};
  const limits = obj(res?.limits) ?? {};
  if (Object.keys(requests).length === 0 && Object.keys(limits).length === 0) return 'BestEffort';
  let qos: QOSClass | '' = '';
  // Go ranges over a set (random order); the result does not depend on it.
  for (const name of ['cpu', 'memory']) {
    const r = resourceQOS(res as JsonObject, name);
    if (r === 'Burstable') return r;
    if (qos === '') qos = r;
    else if (qos !== r) return 'Burstable';
  }
  return qos === '' ? 'BestEffort' : qos;
}

const isSupportedPodLevelResource = (name: string): boolean => name === 'cpu' || name === 'memory' || name.startsWith('hugepages-');

/** helper.IsPodLevelResourcesSet. */
function isPodLevelResourcesSet(spec: JsonObject): boolean {
  const res = obj(spec.resources);
  if (!res) return false;
  const names = [...Object.keys(obj(res.requests) ?? {}), ...Object.keys(obj(res.limits) ?? {})];
  return names.some(isSupportedPodLevelResource);
}

/** ComputePodQOS over a versioned Pod. */
export function computePodQOS(pod: JsonObject): QOSClass {
  const spec = obj(pod.spec) ?? {};
  if (isPodLevelResourcesSet(spec)) return requirementsQOS(obj(spec.resources));
  let podQOS: QOSClass | '' = '';
  for (const list of ['initContainers', 'containers']) {
    for (const c of Array.isArray(spec[list]) ? (spec[list] as Json[]) : []) {
      const q = requirementsQOS(obj(obj(c)?.resources));
      if (q === 'Burstable') return q;
      if (podQOS === '') podQOS = q;
      else if (podQOS !== q) return 'Burstable';
    }
  }
  return podQOS === '' ? 'BestEffort' : podQOS;
}

/** GetPodQOS: the stored class when there is one. */
export function getPodQOS(pod: JsonObject): QOSClass {
  const stored = obj(pod.status)?.qosClass;
  if (stored === 'Guaranteed' || stored === 'Burstable' || stored === 'BestEffort') return stored;
  return computePodQOS(pod);
}
