// The Endpoints controller: the legacy v1 Endpoints object of every Service with a selector.
// upstream: pkg/controller/endpoint/endpoints_controller.go (NewEndpointController, syncService,
// addEndpointSubset, podToEndpointAddressForService, truncateEndpoints,
// capacityAnnotationSetCorrectly, labelsCorrectForEndpoints, checkLeftoverEndpoints),
// pkg/api/v1/endpoints/util.go (repack.ts).
//
// Pod events map to Services in the watch handler, as the Pod queue's worker does at once
// (endpointUpdatesBatchPeriod defaults to 0). The staleEndpointsTracker is not ported: the
// controller reads the store, which is never behind its own writes. v1 Endpoints is deprecated
// since 1.33; the API server's warning on its requests is ignored, as client-go's default
// warning handler only logs it.

import { cloneJson, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { isPodReady } from '../podutil.ts';
import type { ControllerEvent, ControllerSpec, SyncCtx, SyncResult } from '../types.ts';
import { ANNOTATION_LAST_CHANGE_TRIGGER_TIME, LABEL_HEADLESS } from '../endpointslice/reconciler.ts';
import { computeEndpointLastChangeTriggerTime, deleteServiceTriggerTimes, formatTriggerTime } from '../endpointslice/triggertime.ts';
import {
  errorMessage,
  findPort,
  hasNamespaceTerminatingCause,
  isServiceIPSet,
  keyOf,
  metaOf,
  objs,
  podsForService,
  serviceSelector,
  servicesToUpdateOnPodEvent,
  shouldPodBeInEndpoints,
  shouldSetHostname,
  specOf,
  statusOf,
  str,
  strMap,
} from '../endpointslice/util.ts';
import { repackSubsets } from './repack.ts';

/** maxRetries, maxCapacity, truncated, LabelManagedBy, ControllerName. */
const MAX_RETRIES = 15;
export const MAX_CAPACITY = 1000;
const TRUNCATED = 'truncated';
export const LABEL_MANAGED_BY = 'endpoints.kubernetes.io/managed-by';
export const CONTROLLER_NAME = 'endpoint-controller';
/** v1.EndpointsOverCapacity. */
export const ANNOTATION_OVER_CAPACITY = 'endpoints.kubernetes.io/over-capacity';
/** resourcelock.LeaderElectionRecordAnnotationKey: Endpoints used as a leader election lock. */
const LEADER_ELECTION_ANNOTATION = 'control-plane.alpha.kubernetes.io/leader';

/** podToEndpointAddressForService; undefined when the Pod has no IP of the Service's family. */
function podToEndpointAddress(svc: ApiObject, pod: ApiObject): JsonObject | undefined {
  const spec = specOf(svc);
  const families = Array.isArray(spec.ipFamilies) ? spec.ipFamilies.map((f) => str(f)) : [];
  let family = 'IPv4';
  if (families.length > 0) family = families[0] as string;
  else if (str(spec.clusterIP) !== '' && str(spec.clusterIP) !== 'None') family = str(spec.clusterIP).includes(':') ? 'IPv6' : 'IPv4';
  else if (str(statusOf(pod).podIP).includes(':')) family = 'IPv6';
  const wantIPv6 = family === 'IPv6';
  const ip = objs(statusOf(pod).podIPs)
    .map((x) => str(x.ip))
    .find((x) => x.includes(':') === wantIPv6);
  if (ip === undefined) return undefined;
  const pm = metaOf(pod);
  return {
    ip,
    // NodeName: &pod.Spec.NodeName, set even when empty.
    nodeName: str(specOf(pod).nodeName),
    targetRef: { kind: 'Pod', namespace: str(pm.namespace), name: str(pm.name), uid: str(pm.uid) },
  };
}

/** addEndpointSubset: one subset per address and port, ready or not. */
function addEndpointSubset(subsets: JsonObject[], pod: ApiObject, epa: JsonObject, epp: JsonObject | undefined, tolerateUnready: boolean): void {
  const ports = epp ? { ports: [epp] } : {};
  if (tolerateUnready || isPodReady(pod)) subsets.push({ addresses: [{ ...epa }], ...ports });
  else subsets.push({ notReadyAddresses: [{ ...epa }], ...ports });
}

/** endpointPortFromServicePort. */
function endpointPort(sp: JsonObject, port: number): JsonObject {
  const p: JsonObject = {};
  if (str(sp.name) !== '') p.name = str(sp.name);
  p.port = port;
  if (str(sp.protocol) !== '') p.protocol = str(sp.protocol);
  if (typeof sp.appProtocol === 'string') p.appProtocol = sp.appProtocol;
  return p;
}

const count = (subsets: readonly JsonObject[], field: 'addresses' | 'notReadyAddresses'): number => subsets.reduce((n, s) => n + objs(s[field]).length, 0);

/** capacityAnnotationSetCorrectly. */
function capacityAnnotationSetCorrectly(annotations: Record<string, string>, subsets: readonly JsonObject[]): boolean {
  if (count(subsets, 'addresses') + count(subsets, 'notReadyAddresses') > MAX_CAPACITY) return false;
  return !(ANNOTATION_OVER_CAPACITY in annotations);
}

/** truncateEndpoints: at most maxCapacity addresses, not-ready ones dropped first, spread over subsets. */
export function truncateEndpoints(subsets: JsonObject[]): boolean {
  const totalReady = count(subsets, 'addresses');
  const totalNotReady = count(subsets, 'notReadyAddresses');
  if (totalReady + totalNotReady <= MAX_CAPACITY) return false;
  let truncateReady = false;
  let max = MAX_CAPACITY - totalReady;
  let numTotal = totalNotReady;
  if (totalReady > MAX_CAPACITY) {
    truncateReady = true;
    max = MAX_CAPACITY;
    numTotal = totalReady;
  }
  let canBeAdded = max;
  for (const s of subsets) {
    const num = objs(truncateReady ? s.addresses : s.notReadyAddresses).length;
    let toBeAdded = Math.ceil((num / numTotal) * max);
    if (toBeAdded > canBeAdded) toBeAdded = canBeAdded;
    if (truncateReady) {
      s.addresses = objs(s.addresses).slice(0, toBeAdded);
      delete s.notReadyAddresses;
      canBeAdded -= objs(s.addresses).length;
    } else {
      s.notReadyAddresses = objs(s.notReadyAddresses).slice(0, toBeAdded);
      canBeAdded -= objs(s.notReadyAddresses).length;
    }
    for (const f of ['addresses', 'notReadyAddresses']) if (Array.isArray(s[f]) && (s[f] as Json[]).length === 0) delete s[f];
  }
  return true;
}

/** Subsets for semantic comparison: empty lists dropped (nil and empty are equal), targetRef resourceVersion ignored. */
function normalizeSubsets(subsets: Json | undefined): Json {
  const norm = (v: Json): Json => {
    if (Array.isArray(v)) return v.length === 0 ? null : v.map(norm);
    if (v !== null && typeof v === 'object') {
      const o: JsonObject = {};
      for (const k of Object.keys(v)) {
        const x = norm(v[k] as Json);
        if (x !== null && x !== '') o[k] = x;
      }
      return o;
    }
    return v;
  };
  const list = objs(subsets).map((s) => {
    const c = cloneJson(s);
    for (const f of ['addresses', 'notReadyAddresses']) for (const a of objs(c[f])) if (a.targetRef && typeof a.targetRef === 'object') delete (a.targetRef as JsonObject).resourceVersion;
    return c;
  });
  return norm(list);
}

/** endpointSubsetsEqualIgnoreResourceVersion. */
const subsetsEqual = (a: Json | undefined, b: Json | undefined): boolean => jsonEqual(normalizeSubsets(a), normalizeSubsets(b));

/** labelsCorrectForEndpoints: managed by this controller and otherwise the Service's labels. */
function labelsCorrectForEndpoints(epLabels: Record<string, string>, svcLabels: Record<string, string>): boolean {
  if (epLabels[LABEL_MANAGED_BY] !== CONTROLLER_NAME) return false;
  let skipped = 0;
  for (const [k, v] of Object.entries(epLabels)) {
    if (k === LABEL_HEADLESS || k === LABEL_MANAGED_BY) skipped++;
    else if (svcLabels[k] !== v) return false;
  }
  return Object.keys(svcLabels).length === Object.keys(epLabels).length - skipped;
}

function syncService(c: SyncCtx, key: string): SyncResult {
  const [namespace, name] = key.split('/') as [string, string];
  const endpoints = c.client.resource('v1/endpoints');
  const svc = c.get('v1/services', namespace, name);
  if (!svc) {
    // The Service is gone: delete its Endpoints (the controller does this itself; no ownerReference).
    const r = endpoints.delete(namespace, name);
    if (!r.ok && r.code !== 404) return { error: errorMessage(r) };
    deleteServiceTriggerTimes(c, namespace, name);
    return { done: true };
  }
  if (str(specOf(svc).type) === 'ExternalName') return { done: true };
  const selector = serviceSelector(svc);
  // Services without a selector: their Endpoints are written out of band.
  if (selector === null) return { done: true };
  const pods = podsForService(c, svc, selector);
  const triggerTime = computeEndpointLastChangeTriggerTime(c, namespace, svc, pods);
  const publishNotReady = specOf(svc).publishNotReadyAddresses === true;
  let subsets: JsonObject[] = [];
  for (const pod of pods) {
    if (!shouldPodBeInEndpoints(pod, publishNotReady)) continue;
    const epa = podToEndpointAddress(svc, pod);
    if (!epa) continue;
    if (shouldSetHostname(pod, svc)) epa.hostname = str(specOf(pod).hostname);
    const ports = objs(specOf(svc).ports);
    if (ports.length === 0) {
      // Headless Services without ports still get their addresses.
      if (str(specOf(svc).clusterIP) === 'None') addEndpointSubset(subsets, pod, epa, undefined, publishNotReady);
    } else {
      for (const sp of ports) {
        const n = findPort(pod, sp);
        if (n === undefined) continue;
        addEndpointSubset(subsets, pod, epa, endpointPort(sp, n), publishNotReady);
      }
    }
  }
  subsets = repackSubsets(subsets);

  const current = c.get('v1/endpoints', namespace, name);
  const svcLabels = strMap(metaOf(svc).labels);
  if (
    current &&
    (subsetsEqual(current.subsets, subsets) || subsetsEqual(repackSubsets(objs(current.subsets)), subsets)) &&
    labelsCorrectForEndpoints(strMap(metaOf(current).labels), svcLabels) &&
    capacityAnnotationSetCorrectly(strMap(metaOf(current).annotations), objs(current.subsets))
  ) {
    return { done: true };
  }
  const create = !current;
  // A new object: ObjectMeta{Name, Labels: service.Labels}.
  const next: JsonObject = current ? cloneJson(current as JsonObject) : { apiVersion: 'v1', kind: 'Endpoints', metadata: { name } };
  const meta = next.metadata as JsonObject;
  if (subsets.length > 0) next.subsets = subsets;
  else delete next.subsets;
  const annotations = strMap(meta.annotations);
  if (triggerTime !== undefined) annotations[ANNOTATION_LAST_CHANGE_TRIGGER_TIME] = formatTriggerTime(triggerTime);
  else delete annotations[ANNOTATION_LAST_CHANGE_TRIGGER_TIME];
  if (truncateEndpoints(subsets)) annotations[ANNOTATION_OVER_CAPACITY] = TRUNCATED;
  else delete annotations[ANNOTATION_OVER_CAPACITY];
  if (Object.keys(annotations).length > 0) meta.annotations = annotations;
  else delete meta.annotations;
  const labels: Record<string, string> = { ...svcLabels };
  if (!isServiceIPSet(svc)) labels[LABEL_HEADLESS] = '';
  else delete labels[LABEL_HEADLESS];
  labels[LABEL_MANAGED_BY] = CONTROLLER_NAME;
  meta.labels = labels;

  const r = create ? endpoints.create(namespace, next) : endpoints.update(namespace, next);
  if (!r.ok) {
    if (create && r.code === 403 && hasNamespaceTerminatingCause(r)) return { done: true };
    const err = errorMessage(r);
    if (create) c.event(next as ApiObject, 'Warning', 'FailedToCreateEndpoint', `Failed to create endpoint for service ${namespace}/${name}: ${err}`);
    else c.event(next as ApiObject, 'Warning', 'FailedToUpdateEndpoint', `Failed to update endpoint ${namespace}/${name}: ${err}`);
    return { error: err };
  }
  return { done: true };
}

/** Endpoints events: deletions (to recreate), and at start every Endpoints object (checkLeftoverEndpoints). */
function endpointsKeys(ev: ControllerEvent): string[] {
  if (ev.type === 'DELETED') return [keyOf(ev.object)];
  if (ev.type === 'ADDED' && ev.initial && !(LEADER_ELECTION_ANNOTATION in strMap(metaOf(ev.object).annotations))) return [keyOf(ev.object)];
  return [];
}

export const endpointsController: ControllerSpec = {
  name: 'endpoints',
  component: 'kube-controller-manager',
  serviceAccount: 'endpoint-controller',
  // record.NewRecorder(..., v1.EventSource{Component: ControllerName})
  eventSource: CONTROLLER_NAME,
  watches: [
    { resource: 'v1/services', keys: (ev) => [keyOf(ev.object)] },
    { resource: 'v1/pods', keys: (ev, read) => servicesToUpdateOnPodEvent(ev, read) },
    { resource: 'v1/endpoints', keys: (ev) => endpointsKeys(ev) },
  ],
  sync: syncService,
  latency: 5,
  maxRetries: MAX_RETRIES,
};
