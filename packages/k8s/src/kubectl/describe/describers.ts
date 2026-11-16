// The describers kubectl describe dispatches to, with the requests each sends: the object itself,
// then what the describer reads around it, in upstream's order and with its selectors.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go describerMap, PodDescriber,
//             DeploymentDescriber, ServiceDescriber, NodeDescriber, searchEvents
//   upstream: staging/src/k8s.io/client-go/kubernetes/typed/core/v1/event_expansion.go
//             GetFieldSelector (involvedObject.name, .namespace, and .kind and .uid when not empty)
//   upstream: staging/src/k8s.io/client-go/tools/reference/ref.go GetReference (kind, namespace,
//             name, uid of the object); PodDescriber clears the kind and, for a mirror Pod, uses the
//             static Pod's UID from kubernetes.io/config.mirror
//   upstream: staging/src/k8s.io/kubectl/pkg/util/deployment/deployment.go
//             GetAllReplicaSetsInChunks, listReplicaSets (by the Deployment's selector, owned by it),
//             findNewReplicaSet, findOldReplicaSets (describe shows all old ReplicaSets)
//   Errors the describers ignore upstream (`events, _ :=`, `endpointSliceList, _ :=`, the
//   ReplicaSets' error, ResourceSlices) leave their section empty here too. The --chunk-size limit
//   is not sent: lists are answered whole, and the result is the same.

import type { Op } from '@simlab/host';
import type { Millis } from '@simlab/kernel';
import type { JsonObject } from '../../apimachinery/json.ts';
import { isSelectorError, labelSelectorAsSelector, selectorString } from '../../apimachinery/labels.ts';
import type { ApiRequest } from '../../apiserver/types.ts';
import { findNewReplicaSet } from '../../controllers/deployment/util.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import { request, type Session } from '../client/session.ts';
import { meta, obj, objs } from './common.ts';
import { describeDeployment } from './deployment.ts';
import { describeNode, type LeaseResult } from './node.ts';
import { describePod } from './pod.ts';
import { describeService } from './service.ts';

export interface DescriberSettings {
  showEvents: boolean;
}

export type Described = { text: string } | { error: KubectlError };

export type Describer = (s: Session, namespace: string, name: string, settings: DescriberSettings) => Op<Described>;

const MIRROR_POD_ANNOTATION = 'kubernetes.io/config.mirror';

function* get(s: Session, group: string, version: string, resource: string, namespace: string, name: string): Op<JsonObject | { error: KubectlError }> {
  const r = yield* request(s, { verb: 'get', group, version, resource, ...(namespace ? { namespace } : {}), name });
  if (r.ok) return r.object as JsonObject;
  if ('notSimulated' in r) return { error: { type: 'notSimulated', what: r.notSimulated } };
  return { error: { type: 'status', status: r.status } };
}

/** A list's items, or undefined when the request failed. */
function* list(s: Session, req: Omit<ApiRequest, 'verb'>): Op<JsonObject[] | undefined> {
  const r = yield* request(s, { verb: 'list', ...req });
  if (!r.ok) return undefined;
  return objs((r.object as JsonObject).items);
}

interface Ref {
  kind: string;
  namespace: string;
  name: string;
  uid: string;
}

/** searchEvents: the events of the object, from its namespace (all namespaces for a cluster-scoped one). */
function* searchEvents(s: Session, ref: Ref): Op<JsonObject[]> {
  const terms: string[] = [`involvedObject.name=${ref.name}`, `involvedObject.namespace=${ref.namespace}`];
  if (ref.kind !== '') terms.push(`involvedObject.kind=${ref.kind}`);
  if (ref.uid !== '') terms.push(`involvedObject.uid=${ref.uid}`);
  const items = yield* list(s, { group: '', version: 'v1', resource: 'events', ...(ref.namespace ? { namespace: ref.namespace } : {}), options: { fieldSelector: terms.sort().join(',') } });
  return items ?? [];
}

const refOf = (o: JsonObject, kind: string): Ref => {
  const m = meta(o);
  return { kind, namespace: typeof m.namespace === 'string' ? m.namespace : '', name: typeof m.name === 'string' ? m.name : '', uid: typeof m.uid === 'string' ? m.uid : '' };
};

const isError = (v: JsonObject | { error: KubectlError }): v is { error: KubectlError } => 'error' in v && Object.keys(v).length === 1 && typeof v.error === 'object';

const nowOf = (s: Session): Millis => s.p.ctx.now;

export const describePodObject: Describer = function* (s, namespace, name, settings) {
  const pod = yield* get(s, '', 'v1', 'pods', namespace, name);
  if (isError(pod)) return pod;
  let events: JsonObject[] | undefined;
  if (settings.showEvents) {
    const ref = { ...refOf(pod, ''), kind: '' };
    const mirror = obj(meta(pod).annotations)[MIRROR_POD_ANNOTATION];
    if (typeof mirror === 'string') ref.uid = mirror;
    events = yield* searchEvents(s, ref);
  }
  return { text: describePod(pod, events, nowOf(s)) };
};

export const describeDeploymentObject: Describer = function* (s, namespace, name, settings) {
  const d = yield* get(s, 'apps', 'v1', 'deployments', namespace, name);
  if (isError(d)) return d;
  let events: JsonObject[] | undefined;
  if (settings.showEvents) events = yield* searchEvents(s, refOf(d, 'Deployment'));
  let oldRSs: JsonObject[] = [];
  const newRSs: JsonObject[] = [];
  const selector = labelSelectorAsSelector(obj(d.spec).selector);
  if (!isSelectorError(selector)) {
    const all = yield* list(s, { group: 'apps', version: 'v1', resource: 'replicasets', namespace: refOf(d, '').namespace, options: { labelSelector: selectorString(selector) } });
    if (all) {
      const uid = meta(d).uid;
      const owned = all.filter((rs) => objs(meta(rs).ownerReferences).some((r) => r.controller === true && r.uid === uid));
      const newRS = findNewReplicaSet(d, owned);
      oldRSs = owned.filter((rs) => !newRS || meta(rs).uid !== meta(newRS).uid);
      if (newRS) newRSs.push(newRS);
    }
  }
  const text = describeDeployment(d, oldRSs, newRSs, events, nowOf(s));
  return typeof text === 'string' ? { text } : { error: messageError(text.error) };
};

export const describeServiceObject: Describer = function* (s, namespace, name, settings) {
  const svc = yield* get(s, '', 'v1', 'services', namespace, name);
  if (isError(svc)) return svc;
  const ref = refOf(svc, 'Service');
  const slices = (yield* list(s, { group: 'discovery.k8s.io', version: 'v1', resource: 'endpointslices', namespace: ref.namespace, options: { labelSelector: `kubernetes.io/service-name=${ref.name}` } })) ?? [];
  let events: JsonObject[] | undefined;
  if (settings.showEvents) events = yield* searchEvents(s, ref);
  return { text: describeService(svc, slices, events, nowOf(s)) };
};

export const describeNodeObject: Describer = function* (s, _namespace, name, settings) {
  const node = yield* get(s, '', 'v1', 'nodes', '', name);
  if (isError(node)) return node;
  const ref = refOf(node, 'Node');
  const r = yield* request(s, {
    verb: 'list',
    group: '',
    version: 'v1',
    resource: 'pods',
    options: { fieldSelector: `spec.nodeName=${ref.name},status.phase!=Succeeded,status.phase!=Failed` },
  });
  if (!r.ok) {
    if ('notSimulated' in r) return { error: { type: 'notSimulated', what: r.notSimulated } };
    // canViewPods false prints "Pods:\tnot authorized": no user is refused before phase 20a
    if (r.status.reason === 'Forbidden') return { error: { type: 'notSimulated', what: 'describing a node whose Pods the user may not list' } };
    return { error: { type: 'status', status: r.status } };
  }
  const pods = objs((r.object as JsonObject).items);
  let events: JsonObject[] | undefined;
  if (settings.showEvents) {
    // the node controller records with the Node's UID, the kubelet with its name
    events = yield* searchEvents(s, ref);
    events = [...events, ...(yield* searchEvents(s, { ...ref, uid: ref.name }))];
  }
  // ResourceSlices of the node: a type the simulator does not serve holds no objects (D-066); once
  // it serves them, describeNodeResourceSlices has to be written before they are shown.
  const slices = yield* list(s, { group: 'resource.k8s.io', version: 'v1', resource: 'resourceslices', options: { fieldSelector: `spec.nodeName=${ref.name}` } });
  if (slices && slices.length > 0) return { error: { type: 'notSimulated', what: "describing a node's ResourceSlices" } };
  const l = yield* request(s, { verb: 'get', group: 'coordination.k8s.io', version: 'v1', resource: 'leases', namespace: 'kube-node-lease', name: ref.name });
  let lease: LeaseResult;
  if (l.ok) lease = { lease: l.object as JsonObject };
  else if ('notSimulated' in l) return { error: { type: 'notSimulated', what: l.notSimulated } };
  else lease = { error: l.status.message ?? '' };
  return { text: describeNode(node, pods, events, lease, nowOf(s)) };
};

/** describerMap: by API group and kind. */
export const DESCRIBERS: Record<string, Describer> = {
  '/Pod': describePodObject,
  'apps/Deployment': describeDeploymentObject,
  '/Service': describeServiceObject,
  '/Node': describeNodeObject,
};
