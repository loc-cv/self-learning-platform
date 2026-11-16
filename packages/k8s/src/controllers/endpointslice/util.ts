// Helpers of the endpointslice staging module that both the EndpointSlice and the Endpoints
// controller use (upstream: staging/src/k8s.io/endpointslice/util/controller_utils.go,
// staging/src/k8s.io/endpointslice/utils.go FindPort), on objects as stored (v1 JSON).

import { jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { ApiResponse } from '../../apiserver/types.ts';
import { isPodReady, isPodTerminal } from '../podutil.ts';
import type { ControllerEvent, Reader } from '../types.ts';

const isObj = (v: Json | undefined): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
export const metaOf = (o: ApiObject): JsonObject => (isObj(o.metadata) ? o.metadata : {});
export const specOf = (o: ApiObject): JsonObject => (isObj(o.spec) ? o.spec : {});
export const statusOf = (o: ApiObject): JsonObject => (isObj(o.status) ? o.status : {});
export const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
export const objs = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** A string map field (labels, annotations, selector); absent or null gives {}. */
export function strMap(v: Json | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const k of Object.keys(v)) if (typeof v[k] === 'string') out[k] = v[k] as string;
  return out;
}

export const keyOf = (o: ApiObject): string => `${str(metaOf(o).namespace)}/${str(metaOf(o).name)}`;

/**
 * service.Spec.Selector, or null when Go would see a nil map. The controllers decode objects from
 * protobuf (kube-controller-manager's --kube-api-content-type default), where an empty map is
 * never allocated: `selector: {}` is nil, as an absent selector is.
 */
export function serviceSelector(svc: ApiObject): Record<string, string> | null {
  const sel = strMap(specOf(svc).selector);
  return Object.keys(sel).length === 0 ? null : sel;
}

/** labels.ValidatedSetSelector(selector).Matches(labels): every pair present. */
export function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  return Object.keys(selector).every((k) => labels[k] === selector[k]);
}

/** The Pods of the Service's namespace its selector matches (podLister.List), in store order. */
export function podsForService(read: Reader, svc: ApiObject, selector: Record<string, string>): ApiObject[] {
  return read.list('v1/pods', str(metaOf(svc).namespace)).filter((p) => selectorMatches(selector, strMap(metaOf(p).labels)));
}

/** ShouldPodBeInEndpoints: not terminal, has an IP, and not terminating unless included. */
export function shouldPodBeInEndpoints(pod: ApiObject, includeTerminating: boolean): boolean {
  if (isPodTerminal(pod)) return false;
  const status = statusOf(pod);
  if (str(status.podIP) === '' && objs(status.podIPs).length === 0) return false;
  if (!includeTerminating && metaOf(pod).deletionTimestamp) return false;
  return true;
}

/** ShouldSetHostname: the Pod names a hostname and its subdomain is the Service. */
export function shouldSetHostname(pod: ApiObject, svc: ApiObject): boolean {
  const ps = specOf(pod);
  return str(ps.hostname) !== '' && str(ps.subdomain) === str(metaOf(svc).name) && str(metaOf(svc).namespace) === str(metaOf(pod).namespace);
}

/**
 * FindPort (staging/src/k8s.io/endpointslice/utils.go): a named targetPort resolves to the first
 * container port of that name and the Service port's protocol, then to restartable init
 * (sidecar) containers' ports; a number is taken as is. Undefined when nothing matches.
 */
export function findPort(pod: ApiObject, servicePort: JsonObject): number | undefined {
  const target = servicePort.targetPort;
  const protocol = str(servicePort.protocol);
  if (typeof target === 'string') {
    const spec = specOf(pod);
    for (const c of objs(spec.containers)) {
      for (const p of objs(c.ports)) if (str(p.name) === target && str(p.protocol) === protocol) return p.containerPort as number;
    }
    for (const c of objs(spec.initContainers)) {
      if (str(c.restartPolicy) !== 'Always') continue;
      for (const p of objs(c.ports)) if (str(p.name) === target && str(p.protocol) === protocol) return p.containerPort as number;
    }
    return undefined;
  }
  // intstr.Int: IntValue(). The API server defaults targetPort to the port, so it is set.
  return typeof target === 'number' ? target : undefined;
}

/** podEndpointsChanged: [podChanged, labelsChanged]. */
function podEndpointsChanged(oldPod: ApiObject, newPod: ApiObject): [boolean, boolean] {
  const om = metaOf(oldPod);
  const nm = metaOf(newPod);
  const os = specOf(oldPod);
  const ns = specOf(newPod);
  // reflect.DeepEqual of the label maps after protobuf decoding: an empty map is nil, so {} and
  // absent are equal.
  const labelsChanged = !jsonEqual(strMap(om.labels), strMap(nm.labels)) || str(os.hostname) !== str(ns.hostname) || str(os.subdomain) !== str(ns.subdomain);
  // newPod.DeletionTimestamp != oldPod.DeletionTimestamp compares pointers, and two decoded
  // objects never share one: it is true whenever either has a deletion timestamp.
  if (om.deletionTimestamp || nm.deletionTimestamp) return [true, labelsChanged];
  if (isPodReady(oldPod) !== isPodReady(newPod)) return [true, labelsChanged];
  const oi = objs(statusOf(oldPod).podIPs).map((x) => str(x.ip));
  const ni = objs(statusOf(newPod).podIPs).map((x) => str(x.ip));
  if (oi.length !== ni.length || oi.some((ip, i) => ip !== ni[i])) return [true, labelsChanged];
  return [false, labelsChanged];
}

interface PodProjectionKey {
  namespace: string;
  labels: Record<string, string>;
  oldLabels?: Record<string, string>;
  podChanged: boolean;
}

/** GetPodUpdateProjectionKey for an informer event; undefined when the change cannot matter. */
function podUpdateProjectionKey(ev: ControllerEvent): PodProjectionKey | undefined {
  const cur = ev.object;
  if (ev.type === 'ADDED' || ev.type === 'DELETED' || !ev.old) {
    return { namespace: str(metaOf(cur).namespace), labels: strMap(metaOf(cur).labels), podChanged: false };
  }
  const old = ev.old;
  if (str(metaOf(old).resourceVersion) === str(metaOf(cur).resourceVersion)) return undefined;
  const [podChanged, labelsChanged] = podEndpointsChanged(old, cur);
  if (!podChanged && !labelsChanged) return undefined;
  if (!labelsChanged) return { namespace: str(metaOf(cur).namespace), labels: strMap(metaOf(cur).labels), podChanged: false };
  return { namespace: str(metaOf(cur).namespace), labels: strMap(metaOf(cur).labels), oldLabels: strMap(metaOf(old).labels), podChanged };
}

/** getServicesForPod: keys of the namespace's Services with a selector matching the labels. */
function servicesForPod(read: Reader, namespace: string, labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const svc of read.list('v1/services', namespace)) {
    const sel = serviceSelector(svc);
    if (sel !== null && selectorMatches(sel, labels)) out.push(keyOf(svc));
  }
  return out;
}

/**
 * The Service keys a Pod event queues: GetPodUpdateProjectionKey, then GetServicesToUpdate with
 * determineNeededServiceUpdates (a label change alone queues only the Services the Pod entered
 * or left; with another change, both old and new ones). Upstream runs this from a Pod queue's
 * worker and adds the Services after endpointUpdatesBatchPeriod (default 0); here the handler
 * maps directly, in store order of the Services (upstream iterates a set).
 */
export function servicesToUpdateOnPodEvent(ev: ControllerEvent, read: Reader): string[] {
  const key = podUpdateProjectionKey(ev);
  if (!key) return [];
  const services = servicesForPod(read, key.namespace, key.labels);
  if (key.oldLabels === undefined) return services;
  const oldServices = servicesForPod(read, key.namespace, key.oldLabels);
  if (key.podChanged) return [...services, ...oldServices.filter((s) => !services.includes(s))];
  return [...services.filter((s) => !oldServices.includes(s)), ...oldServices.filter((s) => !services.includes(s))];
}

/** helper.IsServiceIPSet: a ClusterIP that is neither None nor empty. */
export function isServiceIPSet(svc: ApiObject): boolean {
  const ip = str(specOf(svc).clusterIP);
  return ip !== 'None' && ip !== '';
}

/** err.Error() of a failed request: the Status message (StatusError.Error). */
export function errorMessage(r: ApiResponse): string {
  if (r.ok) return '';
  if ('status' in r) return r.status.message ?? '';
  return r.notSimulated;
}

/** errors.HasStatusCause(err, v1.NamespaceTerminatingCause). */
export function hasNamespaceTerminatingCause(r: ApiResponse): boolean {
  return !r.ok && 'status' in r && (r.status.details?.causes ?? []).some((c) => c.reason === 'NamespaceTerminating');
}
