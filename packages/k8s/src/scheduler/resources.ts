// Resource arithmetic of the scheduler: a Pod's effective requests and a node's allocatable, as
// plain numbers (cpu in millicores, everything else in units: bytes, Pods, devices).
//
// upstream: staging/src/k8s.io/component-helpers/resource/helpers.go PodRequests,
// aggregateContainerResourcesByFn (sidecars and init containers), applyPodLevelResources,
// IsSupportedPodLevelResource; pkg/scheduler/framework/types.go Resource (MilliCPU, Memory,
// EphemeralStorage, AllowedPodNumber, ScalarResources).

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';
import { milliValue, parseQuantity, value } from '../apimachinery/quantity.ts';
import type { ApiObject } from '../apiserver/store.ts';

/** A ResourceList as numbers: `cpu` in millicores, other names in their unit. */
export type ResourceList = Record<string, number>;

const CPU = 'cpu';

/** One quantity string in the scheduler's unit for its resource. */
export function quantityOf(name: string, q: Json | undefined): number {
  if (typeof q !== 'string' && typeof q !== 'number') return 0;
  const p = parseQuantity(String(q));
  if ('error' in p) return 0;
  return name === CPU ? milliValue(p) : value(p);
}

export function resourceList(v: Json | undefined): ResourceList {
  const out: ResourceList = {};
  if (!isObject(v)) return out;
  for (const k of Object.keys(v)) out[k] = quantityOf(k, v[k]);
  return out;
}

function add(into: ResourceList, l: ResourceList): void {
  for (const k of Object.keys(l)) into[k] = (into[k] ?? 0) + (l[k] as number);
}

function maxInto(into: ResourceList, l: ResourceList): void {
  for (const k of Object.keys(l)) {
    const v = l[k] as number;
    if (into[k] === undefined || v > (into[k] as number)) into[k] = v;
  }
}

const containerRequests = (c: JsonObject): ResourceList => resourceList(isObject(c.resources) ? c.resources.requests : undefined);

/** upstream: isRestartableInitContainer — restartPolicy Always makes an init container a sidecar. */
const isSidecar = (c: JsonObject): boolean => c.restartPolicy === 'Always';

/** upstream: IsSupportedPodLevelResource (cpu, memory, hugepages-*). */
const isPodLevel = (name: string): boolean => name === 'cpu' || name === 'memory' || name.startsWith('hugepages-');

/** upstream: aggregateContainerResourcesByFn with container spec requests. */
function aggregate(spec: JsonObject, perContainer: (c: JsonObject) => ResourceList): ResourceList {
  const result: ResourceList = {};
  for (const c of arr(spec.containers)) add(result, perContainer(c));
  const sidecars: ResourceList = {};
  const init: ResourceList = {};
  for (const c of arr(spec.initContainers)) {
    let use = perContainer(c);
    if (isSidecar(c)) {
      add(result, use);
      add(sidecars, use);
      use = { ...sidecars };
    } else {
      const combined: ResourceList = {};
      add(combined, use);
      add(combined, sidecars);
      use = combined;
    }
    maxInto(init, use);
  }
  maxInto(result, init);
  return result;
}

function podLevelRequests(spec: JsonObject): ResourceList {
  const l = isObject(spec.resources) ? resourceList(spec.resources.requests) : {};
  const out: ResourceList = {};
  for (const k of Object.keys(l)) if (isPodLevel(k)) out[k] = l[k] as number;
  return out;
}

/**
 * upstream: PodRequests with `nonMissing` as NonMissingContainerRequests (added to a container's
 * requests for each resource it does not name), pod-level requests applied, overhead added.
 */
function requests(pod: ApiObject, nonMissing: ResourceList): ResourceList {
  const spec = isObject(pod.spec) ? pod.spec : {};
  const result = aggregate(spec, (c) => {
    const r = containerRequests(c);
    for (const k of Object.keys(nonMissing)) if (r[k] === undefined) r[k] = nonMissing[k] as number;
    return r;
  });
  const podLevel = podLevelRequests(spec);
  for (const k of Object.keys(podLevel)) result[k] = podLevel[k] as number;
  if (isObject(spec.overhead)) add(result, resourceList(spec.overhead));
  return result;
}

/** upstream: PodRequests with the scheduler's options (overhead included, pod-level resources applied). */
export function podRequests(pod: ApiObject): ResourceList {
  return requests(pod, {});
}

/**
 * Requests with the scheduler's non-zero defaults, for scoring: a container without a cpu or a
 * memory request counts as 100m and 200 MiB.
 * upstream: pkg/scheduler/util/pod_resources.go DefaultMilliCPURequest, DefaultMemoryRequest;
 * framework/types.go getNonMissingContainerRequests (when pod-level requests are set, only a
 * resource missing at both levels gets the default); noderesources/resource_allocation.go
 * calculatePodResourceRequest.
 */
export const DEFAULT_MILLI_CPU_REQUEST = 100;
export const DEFAULT_MEMORY_REQUEST = 200 * 1024 * 1024;

export function podNonZeroRequests(pod: ApiObject): ResourceList {
  const spec = isObject(pod.spec) ? pod.spec : {};
  const podLevel = podLevelRequests(spec);
  const podLevelSet = Object.keys(podLevel).length > 0;
  const nonMissing: ResourceList = {};
  if (!podLevelSet || podLevel.cpu === undefined) nonMissing.cpu = DEFAULT_MILLI_CPU_REQUEST;
  if (!podLevelSet || podLevel.memory === undefined) nonMissing.memory = DEFAULT_MEMORY_REQUEST;
  return requests(pod, nonMissing);
}

export function arr(v: Json | undefined): JsonObject[] {
  return Array.isArray(v) ? (v.filter((x) => isObject(x)) as JsonObject[]) : [];
}
