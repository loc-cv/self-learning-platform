// A Pod's effective requests and limits as resource.Quantity values (describe node prints their
// String()), with the options kubectl passes: pod-level resources applied, overhead included, and
// for the per-Pod rows the container statuses' resources taken into account.
//   upstream: staging/src/k8s.io/component-helpers/resource/helpers.go PodRequests, PodLimits,
//             AggregateContainerRequests, AggregateContainerLimits, aggregateContainerResourcesByFn,
//             containerSpecRequests, containerAllocatedRequests, containerActuatedRequests,
//             containerSpecLimits, containerActuatedLimits, findContainerStatus,
//             IsPodResizeInfeasible, IsSupportedPodLevelResource, IsPodLevelRequestsSet,
//             IsPodLevelResourcesSet, applyPodLevelResources, addResourceList, maxResourceList, max
//   InPlacePodLevelResourcesVerticalScalingEnabled is not set by kubectl, so the pod-level status
//   maps are never read. DRA node-allocatable claims are not simulated: a Pod has none.

import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { addQuantities, compareQuantities, parseQuantity, type Quantity } from '../../apimachinery/quantity.ts';
import { obj, objs } from './common.ts';

export type ResourceList = Record<string, Quantity>;

/** resource.Quantity{}: zero, printed "0". */
export const ZERO: Quantity = { rep: 'int64', unscaled: 0n, scale: 0, format: 'DecimalSI', s: '' };

/** A ResourceList from JSON (the API server stores valid quantities). */
export function resourceList(v: Json | undefined): ResourceList | undefined {
  if (!isObject(v)) return undefined;
  const out: ResourceList = {};
  for (const [k, x] of Object.entries(v)) {
    const q = parseQuantity(typeof x === 'number' ? String(x) : typeof x === 'string' ? x : '0');
    out[k] = 'error' in q ? ZERO : q;
  }
  return out;
}

function addInto(list: ResourceList, other: ResourceList | undefined): void {
  if (!other) return;
  for (const [name, q] of Object.entries(other)) list[name] = name in list ? addQuantities(list[name] as Quantity, q) : q;
}

function maxInto(list: ResourceList, other: ResourceList | undefined): void {
  if (!other) return;
  for (const [name, q] of Object.entries(other)) if (!(name in list) || compareQuantities(q, list[name] as Quantity) > 0) list[name] = q;
}

function max(a: ResourceList | undefined, ...rest: (ResourceList | undefined)[]): ResourceList {
  const out: ResourceList = { ...(a ?? {}) };
  for (const r of rest) maxInto(out, r);
  return out;
}

type GetList = (c: JsonObject, cs: JsonObject | undefined, infeasible: boolean) => ResourceList | undefined;

const res = (c: JsonObject): JsonObject => obj(c.resources);

const specRequests: GetList = (c) => resourceList(res(c).requests);
const specLimits: GetList = (c) => resourceList(res(c).limits);
const allocatedRequests: GetList = (c, cs, infeasible) => {
  if (cs && isObject(cs.allocatedResources)) return resourceList(cs.allocatedResources);
  return infeasible ? undefined : resourceList(res(c).requests);
};
const actuatedRequests: GetList = (c, cs, infeasible) => {
  if (cs && isObject(cs.resources) && isObject(cs.resources.requests)) return resourceList(cs.resources.requests);
  if (cs && isObject(cs.allocatedResources)) return resourceList(cs.allocatedResources);
  return infeasible ? undefined : resourceList(res(c).requests);
};
const actuatedLimits: GetList = (c, cs, infeasible) => {
  if (cs && isObject(cs.resources) && isObject(cs.resources.limits)) return resourceList(cs.resources.limits);
  return infeasible ? undefined : resourceList(res(c).limits);
};

function isResizeInfeasible(pod: JsonObject): boolean {
  const c = objs(obj(pod.status).conditions).find((x) => x.type === 'PodResizePending');
  return c !== undefined && c.reason === 'Infeasible';
}

function findContainerStatus(pod: JsonObject, name: string): JsonObject | undefined {
  const status = obj(pod.status);
  return objs(status.containerStatuses).find((x) => x.name === name) ?? objs(status.initContainerStatuses).find((x) => x.name === name);
}

function aggregate(pod: JsonObject, useStatus: boolean, get: GetList): ResourceList {
  const spec = obj(pod.spec);
  const infeasible = useStatus && isResizeInfeasible(pod);
  const cs = (c: JsonObject) => (useStatus ? findContainerStatus(pod, typeof c.name === 'string' ? c.name : '') : undefined);
  const result: ResourceList = {};
  for (const c of objs(spec.containers)) addInto(result, get(c, cs(c), infeasible));
  const restartable: ResourceList = {};
  const init: ResourceList = {};
  for (const c of objs(spec.initContainers)) {
    let use = get(c, cs(c), infeasible);
    if (c.restartPolicy === 'Always') {
      addInto(result, use);
      addInto(restartable, use);
      use = restartable;
    } else {
      const combined: ResourceList = {};
      addInto(combined, use);
      addInto(combined, restartable);
      use = combined;
    }
    maxInto(init, use);
  }
  maxInto(result, init);
  return result;
}

const isPodLevel = (name: string): boolean => name === 'cpu' || name === 'memory' || name.startsWith('hugepages-');
const anyPodLevel = (v: Json | undefined): boolean => Object.keys(obj(v)).some(isPodLevel);

function applyPodLevel(result: ResourceList, effective: Json | undefined): void {
  const l = resourceList(effective) ?? {};
  for (const [name, q] of Object.entries(l)) if (isPodLevel(name)) result[name] = q;
}

/** PodRequests with SkipPodLevelResources false (and UseStatusResources as given). */
export function podRequests(pod: JsonObject, useStatus: boolean): ResourceList {
  const reqs: ResourceList = {};
  if (!useStatus) addInto(reqs, aggregate(pod, false, specRequests));
  else {
    const specReqs = aggregate(pod, true, specRequests);
    const allocated = aggregate(pod, true, allocatedRequests);
    const actuated = aggregate(pod, true, actuatedRequests);
    addInto(reqs, isResizeInfeasible(pod) ? max(actuated, allocated) : max(specReqs, actuated, allocated));
  }
  const spec = obj(pod.spec);
  const podRes = obj(spec.resources);
  if (anyPodLevel(podRes.requests)) applyPodLevel(reqs, podRes.requests);
  addInto(reqs, resourceList(spec.overhead));
  return reqs;
}

/** PodLimits with SkipPodLevelResources false (and UseStatusResources as given). */
export function podLimits(pod: JsonObject, useStatus: boolean): ResourceList {
  const limits: ResourceList = {};
  if (!useStatus) addInto(limits, aggregate(pod, false, specLimits));
  else {
    const spec = aggregate(pod, true, specLimits);
    const actuated = aggregate(pod, true, actuatedLimits);
    addInto(limits, isResizeInfeasible(pod) ? actuated : max(spec, actuated));
  }
  const spec = obj(pod.spec);
  const podRes = obj(spec.resources);
  if (anyPodLevel(podRes.requests) || anyPodLevel(podRes.limits)) applyPodLevel(limits, podRes.limits);
  // Overhead is added to non-zero limits only.
  for (const [name, q] of Object.entries(resourceList(spec.overhead) ?? {})) {
    const v = limits[name];
    if (v !== undefined && v.unscaled !== 0n) limits[name] = addQuantities(v, q);
  }
  return limits;
}
