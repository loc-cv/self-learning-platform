// The EndpointSlice reconciler: from a Service and its Pods to the set of EndpointSlices, with
// the fewest writes. upstream: staging/src/k8s.io/endpointslice/reconciler.go (Reconcile,
// reconcileByAddressType, reconcileByPortMapping, finalize), utils.go (podToEndpoint,
// getEndpointPorts, newEndpointSlice, setEndpointSliceLabels, ownedBy, getSliceToFill,
// addTriggerTimeAnnotation, getAddressTypesForService), util/endpointset.go,
// util/controller_utils.go (NewPortMapKey, EndpointsEqualBeyondHash).
//
// Go map iteration has no order; every such loop here runs in insertion order: Pods in store
// order, slices in store order, and EndpointSet.PopAny takes the earliest inserted endpoint. The
// real controller's endpoint order within a slice varies between runs.

import { cloneJson, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { isPodReady } from '../podutil.ts';
import type { SyncCtx } from '../types.ts';
import { deepHash, discoveryEndpointPortValue } from './hash.ts';
import {
  formatWithAddressType,
  hintsEnabled,
  INSUFFICIENT_NODE_INFO,
  LABEL_TOPOLOGY_ZONE,
  reconcileTrafficDistributionHints,
  removeHintsFromSlices,
  topologyNodeInfo,
  TOPOLOGY_AWARE_HINTS_DISABLED_REASON,
  validTrafficDistribution,
  type HintEvent,
} from './hints.ts';
import { LABEL_SERVICE_NAME, trackerExpectDeletion, trackerUpdate } from './tracker.ts';
import { formatTriggerTime } from './triggertime.ts';
import { errorMessage, findPort, hasNamespaceTerminatingCause, isServiceIPSet, metaOf, objs, shouldPodBeInEndpoints, shouldSetHostname, specOf, statusOf, str, strMap } from './util.ts';

/** discovery.LabelManagedBy and v1.IsHeadlessService. */
export const LABEL_MANAGED_BY = 'endpointslice.kubernetes.io/managed-by';
export const LABEL_HEADLESS = 'service.kubernetes.io/headless';
/** v1.EndpointsLastChangeTriggerTime. */
export const ANNOTATION_LAST_CHANGE_TRIGGER_TIME = 'endpoints.kubernetes.io/last-change-trigger-time';

export interface ReconcilerConfig {
  controllerName: string;
  /** --max-endpoints-per-slice, default 100 (pkg/controller/endpointslice/config/v1alpha1/defaults.go). */
  maxEndpointsPerSlice: number;
}

type AddressType = 'IPv4' | 'IPv6';

interface EndpointMeta {
  ports: JsonObject[];
  addressType: AddressType;
}

/** NewPortMapKey: ports sorted in place by their hash (as upstream does to the slice it is given), then hashed. */
function portMapKey(ports: JsonObject[]): string {
  const hashed = ports.map((p) => ({ p, h: deepHash(discoveryEndpointPortValue(p)) }));
  hashed.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  hashed.forEach((x, i) => (ports[i] = x.p));
  // Any injective key does for a map key; the sorted hashes are one.
  return hashed.map((x) => x.h).join(',');
}

/** hashEndpoint: sorted addresses, hostname, targetRef namespace and name. Only a map key here. */
function endpointKey(ep: JsonObject): string {
  const addrs = (Array.isArray(ep.addresses) ? ep.addresses : []).map((a) => str(a)).sort();
  const ref = (ep.targetRef ?? {}) as JsonObject;
  return JSON.stringify([addrs, str(ep.hostname), str(ref.namespace), str(ref.name)]);
}

/** EndpointsEqualBeyondHash. */
function endpointsEqualBeyondHash(a: JsonObject, b: JsonObject): boolean {
  const ptr = (v: Json | undefined): Json => (v === undefined ? null : v);
  if (ptr(a.nodeName) !== ptr(b.nodeName) || ptr(a.zone) !== ptr(b.zone)) return false;
  const ca = (a.conditions ?? {}) as JsonObject;
  const cb = (b.conditions ?? {}) as JsonObject;
  for (const k of ['ready', 'serving', 'terminating']) if (ptr(ca[k]) !== ptr(cb[k])) return false;
  // semanticIgnoreResourceVersion.DeepEqual of the targetRefs.
  const ref = (v: Json | undefined): Json => {
    if (v === undefined || v === null) return null;
    const r = { ...(v as JsonObject) };
    delete r.resourceVersion;
    for (const k of Object.keys(r)) if (r[k] === '') delete r[k];
    return r;
  };
  return jsonEqual(ref(a.targetRef), ref(b.targetRef));
}

/** getAddressTypesForService, in a fixed order (IPv4, IPv6). */
export function addressTypesForService(svc: ApiObject): AddressType[] {
  const spec = specOf(svc);
  const families = (Array.isArray(spec.ipFamilies) ? spec.ipFamilies : []).map((f) => str(f));
  const out: AddressType[] = [];
  if (families.includes('IPv4')) out.push('IPv4');
  if (families.includes('IPv6')) out.push('IPv6');
  if (out.length > 0) return out;
  const ip = str(spec.clusterIP);
  if (ip !== '' && ip !== 'None') return [ip.includes(':') ? 'IPv6' : 'IPv4'];
  return ['IPv4', 'IPv6'];
}

/** getEndpointPorts. */
function endpointPorts(svc: ApiObject, pod: ApiObject): JsonObject[] {
  const spec = specOf(svc);
  const ports = objs(spec.ports);
  if (ports.length === 0 && str(spec.clusterIP) === 'None') return [];
  const out: JsonObject[] = [];
  for (const sp of ports) {
    const n = findPort(pod, sp);
    if (n === undefined) continue;
    out.push({ name: str(sp.name), port: n, protocol: str(sp.protocol), ...(typeof sp.appProtocol === 'string' ? { appProtocol: sp.appProtocol } : {}) });
  }
  return out;
}

/** getEndpointAddresses: the Pod IPs of the address family (utilnet.IsIPv6 on the parsed IP). */
function endpointAddresses(pod: ApiObject, addressType: AddressType): string[] {
  return objs(statusOf(pod).podIPs)
    .map((x) => str(x.ip))
    .filter((ip) => ip.includes(':') === (addressType === 'IPv6'));
}

/** podToEndpoint. */
function podToEndpoint(pod: ApiObject, node: ApiObject | undefined, svc: ApiObject, addressType: AddressType): JsonObject {
  const serving = isPodReady(pod);
  const terminating = Boolean(metaOf(pod).deletionTimestamp);
  const ready = specOf(svc).publishNotReadyAddresses === true || (serving && !terminating);
  const pm = metaOf(pod);
  const ep: JsonObject = {
    addresses: endpointAddresses(pod, addressType),
    conditions: { ready, serving, terminating },
    targetRef: { kind: 'Pod', namespace: str(pm.namespace), name: str(pm.name), uid: str(pm.uid) },
  };
  const nodeName = str(specOf(pod).nodeName);
  if (nodeName !== '') ep.nodeName = nodeName;
  const zone = node ? (strMap(metaOf(node).labels)[LABEL_TOPOLOGY_ZONE] ?? '') : '';
  if (zone !== '') ep.zone = zone;
  if (shouldSetHostname(pod, svc)) ep.hostname = str(specOf(pod).hostname);
  return ep;
}

const isReservedLabelKey = (k: string): boolean => k === LABEL_SERVICE_NAME || k === LABEL_MANAGED_BY || k === LABEL_HEADLESS;

/** setEndpointSliceLabels: [labels, updated]. */
function endpointSliceLabels(slice: JsonObject, svc: ApiObject, controllerName: string): [Record<string, string>, boolean] {
  const epLabels: Record<string, string> = {};
  const svcLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(strMap(metaOf(slice).labels))) if (!isReservedLabelKey(k)) epLabels[k] = v;
  for (const [k, v] of Object.entries(strMap(metaOf(svc).labels))) if (!isReservedLabelKey(k)) svcLabels[k] = v;
  const updated = !jsonEqual(epLabels, svcLabels);
  if (!isServiceIPSet(svc)) svcLabels[LABEL_HEADLESS] = '';
  svcLabels[LABEL_SERVICE_NAME] = str(metaOf(svc).name);
  svcLabels[LABEL_MANAGED_BY] = controllerName;
  return [svcLabels, updated];
}

/** newEndpointSlice. getEndpointSlicePrefix falls back to the bare name only for names a Service cannot have. */
function newEndpointSlice(svc: ApiObject, meta: EndpointMeta, controllerName: string): JsonObject {
  const sm = metaOf(svc);
  const slice: JsonObject = {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      generateName: `${str(sm.name)}-`,
      namespace: str(sm.namespace),
      // metav1.NewControllerRef(service, {Version: v1, Kind: Service}).
      ownerReferences: [{ apiVersion: 'v1', kind: 'Service', name: str(sm.name), uid: str(sm.uid), controller: true, blockOwnerDeletion: true }],
    },
    addressType: meta.addressType,
    endpoints: [],
    ports: meta.ports,
  };
  (slice.metadata as JsonObject).labels = endpointSliceLabels(slice, svc, controllerName)[0];
  return slice;
}

/** ownedBy: an ownerReference with the Service's UID, kind Service, apiVersion v1. */
function ownedBy(slice: JsonObject, svc: ApiObject): boolean {
  return objs(metaOf(slice).ownerReferences).some((o) => str(o.uid) === str(metaOf(svc).uid) && o.kind === 'Service' && o.apiVersion === 'v1');
}

/** getSliceToFill: the slice that the remaining endpoints fill most closely without overflowing. */
function sliceToFill(slices: JsonObject[], numEndpoints: number, maxEndpoints: number): JsonObject | undefined {
  let closestDiff = maxEndpoints;
  let closest: JsonObject | undefined;
  for (const s of slices) {
    const diff = maxEndpoints - (numEndpoints + objs(s.endpoints).length);
    if (diff >= 0 && diff < closestDiff) {
      closestDiff = diff;
      closest = s;
      if (closestDiff === 0) return closest;
    }
  }
  return closest;
}

/** addTriggerTimeAnnotation. */
function addTriggerTimeAnnotation(slice: JsonObject, triggerTime: number | undefined): void {
  const m = slice.metadata as JsonObject;
  const a = { ...strMap(m.annotations) };
  if (triggerTime !== undefined) a[ANNOTATION_LAST_CHANGE_TRIGGER_TIME] = formatTriggerTime(triggerTime);
  else delete a[ANNOTATION_LAST_CHANGE_TRIGGER_TIME];
  m.annotations = a;
}

/**
 * placeholderSliceCompare.DeepEqual(existing, placeholder): ObjectMeta compares namespace and
 * labels only, ownerReferences by String(); the rest semantically (nil and empty are equal).
 */
function equalsPlaceholder(existing: ApiObject, placeholder: JsonObject): boolean {
  const em = metaOf(existing);
  const pm = placeholder.metadata as JsonObject;
  if (str(em.namespace) !== str(pm.namespace) || !jsonEqual(strMap(em.labels), strMap(pm.labels))) return false;
  const empty = (v: Json | undefined): Json => (Array.isArray(v) && v.length === 0 ? null : (v ?? null));
  return existing.addressType === placeholder.addressType && jsonEqual(empty(existing.endpoints), empty(placeholder.endpoints)) && jsonEqual(empty(existing.ports), empty(placeholder.ports));
}

/** Go's utilerrors aggregate messages, flattened: one message, or `[a, b]` (deduplicated). */
export function aggregateError(errs: readonly string[]): string | undefined {
  const seen: string[] = [];
  for (const e of errs) if (!seen.includes(e)) seen.push(e);
  if (seen.length === 0) return undefined;
  return seen.length === 1 ? seen[0] : `[${seen.join(', ')}]`;
}


/** Reconcile: errors as messages (empty when everything succeeded). */
export function reconcile(c: SyncCtx, cfg: ReconcilerConfig, svc: ApiObject, pods: readonly ApiObject[], existingSlices: readonly ApiObject[], triggerTime: number | undefined): string[] {
  const errs: string[] = [];
  const namespace = str(metaOf(svc).namespace);
  const name = str(metaOf(svc).name);
  const types = addressTypesForService(svc);
  const slicesToDelete: ApiObject[] = [];
  const byType: Record<string, ApiObject[]> = {};
  for (const s of existingSlices) {
    // topologyCache.RemoveHints for the dropped address type: the cache holds nothing here.
    if (!types.includes(s.addressType as AddressType)) {
      slicesToDelete.push(s);
      continue;
    }
    (byType[str(s.addressType)] ??= []).push(s);
  }
  for (const t of types) errs.push(...reconcileByAddressType(c, cfg, svc, pods, byType[t] ?? [], triggerTime, t));
  for (const s of slicesToDelete) {
    const r = c.client.resource('discovery.k8s.io/v1/endpointslices').delete(namespace, str(metaOf(s).name));
    if (!r.ok) errs.push(`error deleting ${str(metaOf(s).name)} EndpointSlice for Service ${namespace}/${name}: ${errorMessage(r)}`);
    else trackerExpectDeletion(c, s);
  }
  return errs;
}

function reconcileByAddressType(c: SyncCtx, cfg: ReconcilerConfig, svc: ApiObject, pods: readonly ApiObject[], existingSlices: readonly ApiObject[], triggerTime: number | undefined, addressType: AddressType): string[] {
  const errs: string[] = [];
  const namespace = str(metaOf(svc).namespace);
  const name = str(metaOf(svc).name);
  const slicesToCreate: JsonObject[] = [];
  const slicesToUpdate: JsonObject[] = [];
  let slicesToDelete: ApiObject[] = [];
  const events: HintEvent[] = [];

  const existingByPortMap = new Map<string, ApiObject[]>();
  for (const s of existingSlices) {
    if (ownedBy(s, svc)) {
      const key = portMapKey(objs(s.ports).map((p) => ({ ...p })));
      existingByPortMap.set(key, [...(existingByPortMap.get(key) ?? []), s]);
    } else slicesToDelete.push(s);
  }

  const desiredMeta = new Map<string, EndpointMeta>();
  const desiredEndpoints = new Map<string, Map<string, JsonObject>>();
  for (const pod of pods) {
    if (!shouldPodBeInEndpoints(pod, true)) continue;
    const ports = endpointPorts(svc, pod);
    const key = portMapKey(ports);
    if (!desiredEndpoints.has(key)) desiredEndpoints.set(key, new Map());
    if (!desiredMeta.has(key)) desiredMeta.set(key, { addressType, ports });
    const nodeName = str(specOf(pod).nodeName);
    const node = c.get('v1/nodes', undefined, nodeName);
    if (!node && specOf(svc).publishNotReadyAddresses !== true) {
      errs.push(`skipping Pod ${str(metaOf(pod).name)} for Service ${namespace}/${name}: Node ${nodeName} Not Found`);
      continue;
    }
    const ep = podToEndpoint(pod, node, svc, addressType);
    if ((ep.addresses as Json[]).length > 0) (desiredEndpoints.get(key) as Map<string, JsonObject>).set(endpointKey(ep), ep);
  }

  for (const [portMap, desired] of desiredEndpoints) {
    const r = reconcileByPortMapping(cfg, svc, existingByPortMap.get(portMap) ?? [], desired, desiredMeta.get(portMap) as EndpointMeta);
    slicesToCreate.push(...r.create);
    slicesToUpdate.push(...r.update);
    slicesToDelete.push(...r.delete);
  }
  for (const [portMap, slices] of existingByPortMap) if (!desiredEndpoints.has(portMap)) slicesToDelete.push(...slices);

  // When there are no endpoints, a placeholder slice (no ports, no endpoints) is kept or created.
  if (existingSlices.length === slicesToDelete.length && slicesToCreate.length < 1) {
    const placeholder = newEndpointSlice(svc, { ports: [], addressType }, cfg.controllerName);
    if (slicesToDelete.length === 1 && equalsPlaceholder(slicesToDelete[0] as ApiObject, placeholder)) slicesToDelete = [];
    else slicesToCreate.push(placeholder);
  }

  const changed = new Set([...slicesToUpdate, ...slicesToDelete].map((s) => str(metaOf(s).name)));
  const unchanged = existingSlices.filter((s) => !changed.has(str(metaOf(s).name))).map((s) => cloneJson(s as JsonObject));
  const canUseTrafficDistribution = validTrafficDistribution(svc) && !hintsEnabled(svc);
  if (hintsEnabled(svc)) {
    // topologyCache.AddHints.
    if (topologyNodeInfo(c) === 'insufficient') {
      events.push({ type: 'Warning', reason: TOPOLOGY_AWARE_HINTS_DISABLED_REASON, message: formatWithAddressType(INSUFFICIENT_NODE_INFO, addressType) });
    } else {
      c.trace('sim.gap', `topology aware hints for Service ${namespace}/${name}: zone allocation is not simulated; no hints set`, { service: `${namespace}/${name}` });
      c.ctx.gap({ kind: 'behavior', program: 'kube-controller-manager', what: 'topology aware hints (service.kubernetes.io/topology-mode: Auto) zone allocation', commandLine: '', machine: 'controlplane' });
    }
    removeHintsFromSlices(slicesToCreate, slicesToUpdate, unchanged);
  } else if (!canUseTrafficDistribution) {
    // The topology cache never holds populated hints here (allocation is not simulated), so the
    // TopologyAwareHintsDisabled event for a Service that had them cannot occur.
    removeHintsFromSlices(slicesToCreate, slicesToUpdate, unchanged);
  }
  if (canUseTrafficDistribution) reconcileTrafficDistributionHints(svc, slicesToCreate, slicesToUpdate, unchanged);

  const err = finalize(c, svc, slicesToCreate, slicesToUpdate, slicesToDelete, triggerTime);
  if (err) errs.push(err);
  for (const e of events) c.event(svc, e.type, e.reason, e.message);
  return errs;
}

function finalize(c: SyncCtx, svc: ApiObject, toCreateIn: JsonObject[], toUpdateIn: JsonObject[], toDeleteIn: ApiObject[], triggerTime: number | undefined): string | undefined {
  const namespace = str(metaOf(svc).namespace);
  const name = str(metaOf(svc).name);
  const toCreate = [...toCreateIn];
  const toUpdate = [...toUpdateIn];
  const toDelete = [...toDeleteIn];
  // Reuse the name of a slice about to be deleted for a slice about to be created: one update
  // instead of a create and a delete.
  for (let i = 0; i < toDelete.length; ) {
    if (toCreate.length === 0) break;
    const del = toDelete[i] as ApiObject;
    const slice = toCreate[toCreate.length - 1] as JsonObject;
    if (del.addressType === slice.addressType && ownedBy(del as JsonObject, svc)) {
      // slice.Name = sliceToDelete.Name; the update then carries the deleted slice's name only
      // (no resourceVersion: an unconditional update, which the strategy allows).
      (slice.metadata as JsonObject).name = str(metaOf(del).name);
      toCreate.pop();
      toUpdate.push(slice);
      toDelete.splice(i, 1);
    } else i++;
  }
  const slices = c.client.resource('discovery.k8s.io/v1/endpointslices');
  if (!metaOf(svc).deletionTimestamp) {
    for (const s of toCreate) {
      addTriggerTimeAnnotation(s, triggerTime);
      const r = slices.create(namespace, s);
      if (!r.ok) {
        if (hasNamespaceTerminatingCause(r)) return undefined;
        return `failed to create EndpointSlice for Service ${namespace}/${name}: ${errorMessage(r)}`;
      }
      trackerUpdate(c, r.object as ApiObject);
    }
  }
  for (const s of toUpdate) {
    addTriggerTimeAnnotation(s, triggerTime);
    const r = slices.update(namespace, s);
    if (!r.ok) return `failed to update ${str((s.metadata as JsonObject).name)} EndpointSlice for Service ${namespace}/${name}: ${errorMessage(r)}`;
    trackerUpdate(c, r.object as ApiObject);
  }
  for (const s of toDelete) {
    const r = slices.delete(namespace, str(metaOf(s).name));
    if (!r.ok) return `failed to delete ${str(metaOf(s).name)} EndpointSlice for Service ${namespace}/${name}: ${errorMessage(r)}`;
    trackerExpectDeletion(c, s);
  }
  return undefined;
}

function reconcileByPortMapping(cfg: ReconcilerConfig, svc: ApiObject, existingSlices: readonly ApiObject[], desired: Map<string, JsonObject>, meta: EndpointMeta): { create: JsonObject[]; update: JsonObject[]; delete: ApiObject[] } {
  const max = cfg.maxEndpointsPerSlice;
  const byName = new Map<string, JsonObject>();
  const unchangedNames: string[] = [];
  const updateNames: string[] = [];
  const deleteNames: string[] = [];
  const addName = (list: string[], n: string): void => {
    if (!list.includes(n)) list.push(n);
  };
  const popAny = (): JsonObject => {
    const [k, v] = desired.entries().next().value as [string, JsonObject];
    desired.delete(k);
    return v;
  };

  for (const existing of existingSlices) {
    const sliceName = str(metaOf(existing).name);
    byName.set(sliceName, existing as JsonObject);
    const newEndpoints: JsonObject[] = [];
    let endpointUpdated = false;
    for (const ep of objs(existing.endpoints)) {
      const k = endpointKey(ep);
      const got = desired.get(k);
      if (got) {
        newEndpoints.push(got);
        if (!endpointsEqualBeyondHash(got, ep)) endpointUpdated = true;
        desired.delete(k);
      }
    }
    const [labels, labelsChanged] = endpointSliceLabels(existing as JsonObject, svc, cfg.controllerName);
    const existingCount = objs(existing.endpoints).length;
    if (endpointUpdated || existingCount !== newEndpoints.length) {
      if (newEndpoints.length === 0) addName(deleteNames, sliceName);
      else {
        const s = cloneJson(existing as JsonObject);
        s.endpoints = newEndpoints;
        (s.metadata as JsonObject).labels = labels;
        byName.set(sliceName, s);
        addName(updateNames, sliceName);
      }
    } else if (labelsChanged) {
      const s = cloneJson(existing as JsonObject);
      (s.metadata as JsonObject).labels = labels;
      byName.set(sliceName, s);
      addName(updateNames, sliceName);
    } else addName(unchangedNames, sliceName);
  }

  // Fill slices being updated anyway first, fullest first (sort.Sort is not stable; ties keep
  // their order here).
  if (desired.size > 0 && updateNames.length > 0) {
    const toFill = updateNames.map((n) => byName.get(n) as JsonObject).sort((a, b) => objs(b.endpoints).length - objs(a.endpoints).length);
    for (const s of toFill) {
      const eps = objs(s.endpoints);
      while (desired.size > 0 && eps.length < max) eps.push(popAny());
      s.endpoints = eps;
    }
  }

  const create: JsonObject[] = [];
  while (desired.size > 0) {
    let fill: JsonObject | undefined;
    if (desired.size < max && unchangedNames.length > 0) fill = sliceToFill(unchangedNames.map((n) => byName.get(n) as JsonObject), desired.size, max);
    if (fill === undefined) fill = newEndpointSlice(svc, { ports: meta.ports.map((p) => ({ ...p })), addressType: meta.addressType }, cfg.controllerName);
    else {
      fill = cloneJson(fill);
      byName.set(str(metaOf(fill).name), fill);
    }
    const eps = objs(fill.endpoints);
    while (desired.size > 0 && eps.length < max) eps.push(popAny());
    fill.endpoints = eps;
    const fillName = str(metaOf(fill).name);
    if (fillName !== '') {
      addName(updateNames, fillName);
      const i = unchangedNames.indexOf(fillName);
      if (i >= 0) unchangedNames.splice(i, 1);
    } else create.push(fill);
  }
  return {
    create,
    update: updateNames.map((n) => byName.get(n) as JsonObject),
    delete: deleteNames.map((n) => byName.get(n) as ApiObject),
  };
}
