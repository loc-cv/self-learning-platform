// The EndpointSlice controller: one set of EndpointSlices per Service with a selector, listing the
// Pods it selects. upstream: pkg/controller/endpointslice/endpointslice_controller.go
// (NewController, syncService, the event handlers, queueServiceForEndpointSlice), with the
// reconciler of reconciler.ts.
//
// Queues: upstream has a Service queue (keys `<namespace>/<name>`), a Pod queue whose worker maps
// a Pod change to Services, and a topology queue. Here Pod events map to Services in the watch
// handler (util.ts servicesToUpdateOnPodEvent), as the Pod worker would at once
// (endpointUpdatesBatchPeriod defaults to 0). EndpointSlice events need the slice tracker, which
// lives in controller data that a watch handler cannot read, so they are queued as keys of their
// own (`slice-…`, below) whose sync does what upstream's handler does: consult the tracker and
// add the Service after endpointSliceChangeMinSyncDelay. The topology queue only serves
// Topology Aware Routing's zone allocation, which is not simulated (hints.ts); Nodes are read
// at sync time.

import type { ApiObject } from '../../apiserver/store.ts';
import type { ControllerEvent, ControllerSpec, SyncCtx, SyncResult } from '../types.ts';
import { aggregateError, LABEL_MANAGED_BY, reconcile } from './reconciler.ts';
import { LABEL_SERVICE_NAME, serviceNN, trackerDeleteService, trackerHandleDeletion, trackerHas, trackerShouldSync } from './tracker.ts';
import { computeEndpointLastChangeTriggerTime, deleteServiceTriggerTimes } from './triggertime.ts';
import { keyOf, metaOf, podsForService, serviceSelector, servicesToUpdateOnPodEvent, specOf, str, strMap } from './util.ts';

/** ControllerName: the managed-by label value of the slices it owns. */
export const CONTROLLER_NAME = 'endpointslice-controller.k8s.io';
/** maxRetries. */
const MAX_RETRIES = 15;
/** endpointSliceChangeMinSyncDelay: 1 s. */
export const ENDPOINT_SLICE_CHANGE_MIN_SYNC_DELAY = 1000;
/** defaultSyncBackOff and maxSyncBackOff of the Service queue's rate limiter. */
const DEFAULT_SYNC_BACKOFF = 1000;
const MAX_SYNC_BACKOFF = 1_000_000;
/** --max-endpoints-per-slice default (config/v1alpha1/defaults.go). */
export const MAX_ENDPOINTS_PER_SLICE = 100;

const managedByController = (labels: Record<string, string>): boolean => labels[LABEL_MANAGED_BY] === CONTROLLER_NAME;

/** ServiceControllerKey: undefined when the slice has no service-name label. */
function serviceControllerKey(slice: ApiObject): string | undefined {
  const svc = strMap(metaOf(slice).labels)[LABEL_SERVICE_NAME] ?? '';
  return svc === '' ? undefined : `${str(metaOf(slice).namespace)}/${svc}`;
}

// Keys for EndpointSlice events: `slice-queue:<service key>` adds the Service after the delay;
// `slice-sync:<uid>:<generation>:<service key>` does so when the tracker says ShouldSync;
// `slice-deleted:<uid>:<service key>` when the deletion was not the controller's own.
function sliceEventKeys(ev: ControllerEvent): string[] {
  const slice = ev.object;
  const labels = strMap(metaOf(slice).labels);
  const key = serviceControllerKey(slice);
  const uid = str(metaOf(slice).uid);
  const gen = typeof metaOf(slice).generation === 'number' ? (metaOf(slice).generation as number) : 0;
  if (ev.type === 'ADDED') return managedByController(labels) && key ? [`slice-sync:${uid}:${gen}:${key}`] : [];
  if (ev.type === 'DELETED') return managedByController(labels) && key ? [`slice-deleted:${uid}:${key}`] : [];
  const prev = ev.old ?? slice;
  const prevLabels = strMap(metaOf(prev).labels);
  // The service-name label can change without a new generation.
  if ((labels[LABEL_SERVICE_NAME] ?? '') !== (prevLabels[LABEL_SERVICE_NAME] ?? '')) {
    const prevKey = serviceControllerKey(prev);
    return [...(key ? [`slice-queue:${key}`] : []), ...(prevKey ? [`slice-queue:${prevKey}`] : [])];
  }
  if (!key) return [];
  if (managedByController(labels) !== managedByController(prevLabels)) return [`slice-queue:${key}`];
  return managedByController(labels) ? [`slice-sync:${uid}:${gen}:${key}`] : [];
}

/** What upstream's EndpointSlice event handlers do once the tracker can be read. */
function syncSliceEvent(c: SyncCtx, key: string): SyncResult {
  const [kind, ...rest] = key.split(':');
  const queue = (svcKey: string): void => c.enqueueAfter(svcKey, ENDPOINT_SLICE_CHANGE_MIN_SYNC_DELAY);
  if (kind === 'slice-queue') queue(rest.join(':'));
  else if (kind === 'slice-sync') {
    const [uid, gen, svcKey] = rest as [string, string, string];
    if (trackerShouldSync(c, svcKey, uid, Number(gen))) queue(svcKey);
  } else if (kind === 'slice-deleted') {
    const [uid, svcKey] = rest as [string, string];
    // onEndpointSliceDelete: only slices the tracker knows; requeue unless it expected the deletion.
    if (trackerHas(c, svcKey, uid) && !trackerHandleDeletion(c, svcKey, uid)) queue(svcKey);
  }
  return { done: true };
}

function syncService(c: SyncCtx, key: string): SyncResult {
  const [namespace, name] = key.split('/') as [string, string];
  const svc = c.get('v1/services', namespace, name);
  if (!svc) {
    // The Service is gone: forget it. Its slices go with it through their ownerReference (the
    // garbage collector).
    deleteServiceTriggerTimes(c, namespace, name);
    trackerDeleteService(c, serviceNN(namespace, { [LABEL_SERVICE_NAME]: name }));
    return { done: true };
  }
  // ExternalName Services receive no endpoints (https://issues.k8s.io/105986); Services without a
  // selector get slices made out of band (by users, or the mirroring controller from Endpoints).
  if (str(specOf(svc).type) === 'ExternalName') return { done: true };
  const selector = serviceSelector(svc);
  if (selector === null) return { done: true };
  const pods = podsForService(c, svc, selector);
  const slices = c
    .list('discovery.k8s.io/v1/endpointslices', namespace)
    .filter((s) => {
      const l = strMap(metaOf(s).labels);
      return l[LABEL_SERVICE_NAME] === name && managedByController(l);
    })
    // dropEndpointSlicesPendingDeletion
    .filter((s) => !metaOf(s).deletionTimestamp);
  // Computed before reconciling so the tracker advances even when nothing is written.
  const triggerTime = computeEndpointLastChangeTriggerTime(c, namespace, svc, pods);
  const errs = reconcile(c, { controllerName: CONTROLLER_NAME, maxEndpointsPerSlice: MAX_ENDPOINTS_PER_SLICE }, svc, pods, slices, triggerTime);
  const err = aggregateError(errs);
  if (err !== undefined) {
    c.event(svc, 'Warning', 'FailedToUpdateEndpointSlices', `Error updating Endpoint Slices for Service ${namespace}/${name}: ${err}`);
    return { error: err };
  }
  return { done: true };
}

export const endpointSliceController: ControllerSpec = {
  name: 'endpointslice',
  component: 'kube-controller-manager',
  serviceAccount: 'endpointslice-controller',
  // record.NewRecorder(..., v1.EventSource{Component: "endpoint-slice-controller"})
  eventSource: 'endpoint-slice-controller',
  watches: [
    { resource: 'v1/services', keys: (ev) => [keyOf(ev.object)] },
    { resource: 'v1/pods', keys: (ev, read) => servicesToUpdateOnPodEvent(ev, read) },
    { resource: 'discovery.k8s.io/v1/endpointslices', keys: (ev) => sliceEventKeys(ev) },
  ],
  // Service keys never contain ':' (namespaces and names are DNS labels); slice event keys do.
  sync: (c, key) => (key.includes(':') ? syncSliceEvent(c, key) : syncService(c, key)),
  latency: 5,
  maxRetries: MAX_RETRIES,
  backoff: { baseMs: DEFAULT_SYNC_BACKOFF, maxMs: MAX_SYNC_BACKOFF },
};
