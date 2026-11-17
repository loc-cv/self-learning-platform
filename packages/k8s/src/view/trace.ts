// The Kubernetes provider's reading of the trace (PLAN.md §6.1 "Trace bus", §6.5;
// docs/ARCHITECTURE.md §2.9, §2.13): the records of the API server's clients, the controllers, the
// scheduler, the kubelets and the container runtimes as view events tied to the view's entities.
// Pure, and a function of the records alone, so a replay's trace reads the same. It reads the
// records' structured data and never parses a message.
//
// Levels. `key`: what a learner could see change, or a decision (a Pod created, bound or rejected, a
// container started or exited, a back-off, a failed pull, endpoints that changed, a learner's
// write). `detail`: the bookkeeping around them (status writes, sandbox set-up, Events API
// records). Records of syncs that changed nothing are no event at all (NOT_SHOWN).
//
// Links: a cause that travelled between two entities, one direction per kind of cause.
//   owner → object       a controller (or the collector, the namespace controller) created or
//                        deleted the object, or a Deployment scaled its ReplicaSet;
//   Pod → Node           the scheduler bound the Pod to the node;
//   Service → Pod        the Service's endpoints gained or lost exactly this Pod.
//
// Words. The texts are simulator vocabulary. Where they quote Kubernetes (a scheduler plugin's
// reason, an Event's reason and message, a container's exit reason, a condition's reason) the
// string comes from the record, which took it from the code that produces it.

import { civilFromMillis, type Json, type TraceRecord, type ViewEvent, type ViewEventItem, type ViewTone } from '@simlab/kernel';
import { goDuration } from '../kubelet/backoff.ts';
import { stateWords as containerStateWords } from '../kubelet/trace.ts';
import { namespaceId, nodeId, objectId } from './ids.ts';

type Data = Record<string, Json>;

const isData = (v: Json | undefined): v is Data => v !== null && typeof v === 'object' && !Array.isArray(v);
export const dataOf = (r: TraceRecord): Data => (isData(r.data) ? r.data : {});
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const num = (v: Json | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const dataList = (v: Json | undefined): Data[] => list(v).filter(isData);

/** Virtual time as a clock reading: `09:01:37`, with milliseconds when there are any. */
export function clock(t: number): string {
  const c = civilFromMillis(t);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(c.hour)}:${two(c.minute)}:${two(c.second)}${c.ms !== 0 ? `.${String(c.ms).padStart(3, '0')}` : ''}`;
}

/** A duration as Go's time.Duration prints it (`20s`, `5m0s`), the form the kubelet's messages use. */
export const duration = (ms: number): string => goDuration(ms);

// ---- ids and names ----

/** The API kinds the view draws, by resource. */
const KIND_OF: Record<string, string> = { pods: 'Pod', deployments: 'Deployment', replicasets: 'ReplicaSet', services: 'Service', namespaces: 'Namespace', nodes: 'Node' };

/** The view id of an object of a drawn kind; undefined for a kind the view does not draw. */
export function viewIdOf(kind: string, namespace: string, name: string): string | undefined {
  if (kind === 'Namespace') return namespaceId(name);
  if (kind === 'Node') return nodeId(name);
  if (kind === 'Pod' || kind === 'Deployment' || kind === 'ReplicaSet' || kind === 'Service') return objectId(kind, namespace, name);
  return undefined;
}

/** Ids of what a write touched: the object if the view draws it, else its namespace. */
function aboutObject(kind: string | undefined, namespace: string, name: string): string[] {
  const id = kind ? viewIdOf(kind, namespace, name) : undefined;
  if (id) return [id];
  return namespace !== '' ? [namespaceId(namespace)] : [];
}

const podOf = (d: Data): string => objectId('Pod', str(d.namespace), str(d.name));

/**
 * The component, as Kubernetes names it: a controller of kube-controller-manager by its service
 * account (kubeadm runs it with --use-service-account-credentials), the scheduler and the kubelet
 * by their own names.
 */
const CONTROLLER_ACTOR: Record<string, string> = {
  deployment: 'deployment-controller',
  replicaset: 'replicaset-controller',
  endpoints: 'endpoint-controller',
  endpointslice: 'endpointslice-controller',
  namespace: 'namespace-controller',
  serviceaccount: 'service-account-controller',
  'garbage-collector': 'generic-garbage-collector',
  'node-lifecycle': 'node-controller',
  scheduler: 'kube-scheduler',
};

/** The kind of the object a controller's work-queue key names. */
const KEY_KIND: Record<string, string> = { deployment: 'Deployment', replicaset: 'ReplicaSet', endpoints: 'Service', endpointslice: 'Service', scheduler: 'Pod' };

function controllerOf(r: TraceRecord): string {
  const d = dataOf(r);
  if (str(d.controller) !== '') return str(d.controller);
  return r.source.startsWith('k8s.controller/') ? r.source.slice('k8s.controller/'.length) : '';
}

function actorOf(r: TraceRecord): string {
  const d = dataOf(r);
  const controller = controllerOf(r);
  if (controller === 'kubelet') return `kubelet on ${str(d.instance) || str(d.node)}`;
  if (controller !== '') return CONTROLLER_ACTOR[controller] ?? controller;
  if (r.source.startsWith('k8s.kubelet/')) return `kubelet on ${r.source.slice('k8s.kubelet/'.length)}`;
  if (r.source.startsWith('k8s.runtime/')) return `containerd on ${r.source.slice('k8s.runtime/'.length)}`;
  if (r.source.startsWith('k8s.kubectl/')) return `kubectl (${str(d.user) || 'no user'})`;
  if (r.source.startsWith('k8s.events/')) return str(d.reportingController) || r.source.slice('k8s.events/'.length);
  return r.source;
}

// ---- the record kinds ----

/**
 * Every trace kind the k8s components emit that no event shows, and why. A kind neither mapped
 * below nor listed here fails the trace coverage test (view/trace.test.ts).
 */
export const NOT_SHOWN: Record<string, string> = {
  'controller.sync': 'a sync is shown by what it decided or wrote; one that changed nothing is no event',
  'controller.start': 'a controller starting with its process is not something the learner acts on',
  'scheduler.filter': 'a node verdict: an item of the scheduling decision event',
  'scheduler.score': 'a node score: an item of the binding event',
  'gc.classify': 'the collector reading owner references before it decides',
  'gc.virtual-delete': 'the collector noticing an owner is gone; its deletes are the events',
  'event.series': 'an Event counted in its series; the series write is the event',
  'event.series-finish': 'the Events API recorder closing a series',
  'event.series-refresh': 'the Events API recorder rewriting a series for its TTL',
  'event.filtered': 'an Event the spam filter dropped: nothing reached the API',
  'event.dropped': 'an Event after its broadcaster stopped: nothing reached the API',
  'event.invalid': 'an Event of an unknown type: nothing reached the API',
  'kubelet.sync.done': 'the end of a SyncPod; what it did has records of its own',
  'runtime.process.wake': 'a process model waking up on its own timer: periodic, changes nothing visible',
  'runtime.process.exec': 'a container process replacing its image (exec): same container, same state',
};

const KEY = 'key' as const;
const DETAIL = 'detail' as const;

interface Ctx {
  byId: Map<number, TraceRecord>;
  /** The latest record of each kind per subject, for records that repeat. */
  last: Map<string, string>;
  /** `runtime.container.exited` records by container id. */
  exits: Map<string, number>;
  /** Container ids whose back-off is already shown at key level. */
  backoffShown: Set<string>;
  /** The latest membership of each Service (by uid): its selector and one line per Pod. */
  members: Map<string, { selector: string | null; lines: Map<string, string> }>;
}

/**
 * What this provider's `why` reads of its own events (view/why.ts): the record's kind (with the
 * verb for a write: `apiserver.write/create`) and the few numbers and names its sentences need. It
 * rides on the event as an extra property, which `buildEvents` keeps; nothing else reads it.
 */
export interface K8sEventDetail {
  kind: string;
  /** For a write or a deletion: the view id of the object written, when the view draws its kind. */
  object?: string;
  container?: string;
  exitCode?: number;
  reason?: string;
  endsAt?: number;
  retryAt?: number;
  backoffMs?: number;
}

/** An event of this provider: its `detail` (opaque in the view contract) is `{ k8s: K8sEventDetail }`. */
export type K8sViewEvent = ViewEvent;

/** This provider's detail of an event, if it is one of its own. */
export const detailOf = (e: ViewEvent): K8sEventDetail | undefined => (e.detail as { k8s?: K8sEventDetail } | undefined)?.k8s;

type Mapper = (r: TraceRecord, x: Ctx) => K8sViewEvent | undefined;

const WRITES = new Set(['apiserver.write', 'controller.write', 'controller.write-failed']);

function event(r: TraceRecord, fields: Omit<ViewEvent, 'id' | 't' | 'actor' | 'causes'> & { actor?: string; causes?: number[] }, detail: Omit<K8sEventDetail, 'kind'> = {}): K8sViewEvent {
  const { actor, causes, ...rest } = fields;
  const d = dataOf(r);
  const kind = WRITES.has(r.kind) ? `${r.kind}/${str(d.verb)}` : r.kind;
  return { id: r.id, t: r.t, actor: actor ?? actorOf(r), causes: causes ?? [...(r.causes ?? [])], ...rest, detail: { k8s: { kind, ...detail } } as unknown as Json };
}

const VERB: Record<string, string> = { create: 'created', update: 'updated', patch: 'patched', delete: 'deleted', deletecollection: 'deleted' };
const VERB_FAILED: Record<string, string> = { create: 'create', update: 'update', patch: 'patch', delete: 'delete', deletecollection: 'delete' };

/** `Deployment shop/web`, `pods/status of Pod shop/web-1`, `ConfigMap shop/conf`. */
function objectWords(d: Data): string {
  const kind = KIND_OF[str(d.resource)] ?? (str(d.kind) || str(d.resource));
  const where = str(d.namespace) !== '' ? `${str(d.namespace)}/` : '';
  const sub = str(d.subresource) !== '' ? ` (${str(d.subresource)})` : '';
  return `${kind} ${where}${str(d.name)}${sub}`;
}

/** A write in words; the actor that sent it is the event's. */
function writeText(d: Data): string {
  if (d.ok !== true) return `could not ${VERB_FAILED[str(d.verb)] ?? str(d.verb)} ${objectWords(d)}: ${str(d.message)}`;
  if (str(d.verb) === 'delete' && d.marked === true) return `marked ${objectWords(d)} for deletion`;
  return `${VERB[str(d.verb)] ?? str(d.verb)} ${objectWords(d)}`;
}

/** The learner's (or a setup's) kubectl writing to the API server: a root of the trace. */
const apiserverWrite: Mapper = (r) => {
  const d = dataOf(r);
  const kind = KIND_OF[str(d.resource)] ?? str(d.kind);
  const dry = d.dryRun === true;
  const object = viewIdOf(kind, str(d.namespace), str(d.name));
  const failedCreate = d.ok !== true && str(d.verb) === 'create' && d.code !== 409;
  return event(r, {
    text: `${writeText(d)}${dry ? ' (dry run: nothing stored)' : ''}`,
    about: failedCreate || dry ? aboutObject(undefined, str(d.namespace), '') : aboutObject(kind, str(d.namespace), str(d.name)),
    level: dry ? DETAIL : KEY,
    tone: d.ok === true && !dry ? 'neutral' : d.ok === true ? 'neutral' : 'bad',
  }, object && !dry ? { object } : {});
};

/** Owner kind of a controller's created or deleted object, by the controller and its sync key. */
function ownerOf(controller: string, key: string): string | undefined {
  const kind = KEY_KIND[controller];
  if (!kind || kind === 'Pod') return undefined;
  const [ns, name] = key.split('/') as [string, string | undefined];
  return name === undefined ? undefined : viewIdOf(kind, ns, name);
}

/** Writes another record already shows (the decision it carried out) or that only keep books. */
function hiddenWrite(controller: string, d: Data): boolean {
  const res = str(d.resource);
  const sub = str(d.subresource);
  if (res === 'events') return true; // event.recorded
  if (res === 'endpointslices') return true; // endpoints.sync
  if (controller === 'scheduler' && sub === 'binding') return true; // scheduler.bound
  if (controller === 'kubelet' && res === 'pods' && (sub === 'status' || str(d.verb) === 'delete')) return d.ok === true; // kubelet.status, kubelet.pod.delete
  if (controller === 'garbage-collector' && str(d.verb) === 'delete') return d.ok === true; // gc.delete
  return false;
}

const controllerWrite: Mapper = (r) => {
  const d = dataOf(r);
  const controller = controllerOf(r);
  if (hiddenWrite(controller, d)) return undefined;
  const kind = KIND_OF[str(d.resource)] ?? str(d.kind);
  const verb = str(d.verb);
  const ok = d.ok === true;
  // A create that failed made nothing to be about (a generated name was never given out).
  let target = !ok && verb === 'create' && d.code !== 409 ? [] : aboutObject(kind, str(d.namespace), str(d.name));
  const sub = str(d.subresource);
  // The cause travelled from the owner to what it created or deleted.
  let owner = ownerOf(controller, str(d.key));
  // An object the view does not draw (Endpoints) is shown on what the controller works for (the Service).
  if (owner && viewIdOf(kind, str(d.namespace), str(d.name)) === undefined) target = [owner];
  if (controller === 'namespace' && (verb === 'delete' || verb === 'deletecollection')) owner = namespaceId(str(d.key));
  const creates = (verb === 'create' || verb === 'delete') && sub === '' && (kind === 'Pod' || kind === 'ReplicaSet');
  const nsDelete = controller === 'namespace' && verb === 'delete';
  const key = ok && (creates || nsDelete);
  const e = event(r, {
    text: writeText(d),
    about: owner && (creates || nsDelete) ? [...target, owner] : target,
    // A create or delete that failed is a decision that did not happen: still key.
    level: creates || nsDelete ? KEY : DETAIL,
    tone: ok ? 'neutral' : 'bad',
  }, viewIdOf(kind, str(d.namespace), str(d.name)) !== undefined ? { object: viewIdOf(kind, str(d.namespace), str(d.name)) as string } : {});
  if (key && owner && target[0] && target[0] !== owner) e.link = { from: owner, to: target[0] };
  return e;
};

const controllerTrouble: Mapper = (r) => {
  const controller = controllerOf(r);
  const key = str(r.subject);
  const kind = controller === 'kubelet' ? 'Pod' : KEY_KIND[controller];
  const [ns, name] = key.split('/') as [string, string | undefined];
  const about = kind && name !== undefined ? (viewIdOf(kind, ns, name) ?? '') : '';
  return event(r, { text: r.message, about: about !== '' ? [about] : [], level: DETAIL, tone: 'bad' });
};

const controllerStop: Mapper = (r) => {
  const d = dataOf(r);
  const controller = controllerOf(r);
  // The kubelet's own record (kubelet.stop) says it.
  if (controller === 'kubelet') return undefined;
  const node = controller === 'kubelet' ? str(d.instance) : '';
  return event(r, { text: 'stopped', about: node !== '' ? [nodeId(node)] : [], level: KEY, tone: 'bad' });
};

// ---- scheduling ----

/** The node verdicts of one scheduling decision: one item per node, from the records it names. */
function verdictItems(r: TraceRecord, x: Ctx, bound?: string): ViewEventItem[] {
  const scores = new Map<string, number>();
  const items: ViewEventItem[] = [];
  for (const id of r.causes ?? []) {
    const c = x.byId.get(id);
    if (c?.kind === 'scheduler.score') scores.set(str(dataOf(c).node), num(dataOf(c).total) ?? 0);
  }
  for (const id of r.causes ?? []) {
    const c = x.byId.get(id);
    if (c?.kind !== 'scheduler.filter') continue;
    const d = dataOf(c);
    const node = str(d.node);
    const passed = str(d.code) === 'Success';
    let value: string;
    if (!passed) value = list(d.reasons).map((v) => str(v)).join(', ');
    else if (node === bound) value = scores.has(node) && scores.size > 1 ? `bound here, score ${scores.get(node)}` : 'bound here';
    else value = scores.has(node) && scores.size > 1 ? `feasible, score ${scores.get(node)}` : 'feasible';
    items.push({ entity: nodeId(node), label: node, value, tone: passed ? 'good' : 'bad' });
  }
  return items;
}

const unschedulable: Mapper = (r, x) => {
  const d = dataOf(r);
  const nodes = num(d.nodes) ?? 0;
  return event(r, { text: `no node can take Pod ${str(d.namespace)}/${str(d.name)}: ${nodes === 1 ? 'the node rejected it' : `all ${nodes} nodes rejected it`}`, about: [podOf(d)], level: KEY, tone: 'bad', items: verdictItems(r, x) });
};

const bound: Mapper = (r, x) => {
  const d = dataOf(r);
  const node = str(d.node);
  const pod = podOf(d);
  return event(r, { text: `bound Pod ${str(d.namespace)}/${str(d.name)} to ${node} (${String(d.feasible)} of ${String(d.nodes)} nodes feasible)`, about: [pod, nodeId(node)], level: KEY, tone: 'good', link: { from: pod, to: nodeId(node) }, items: verdictItems(r, x, node) });
};

const bindFailed: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `could not bind Pod ${str(d.namespace)}/${str(d.name)} to ${str(d.node)}: ${str(d.message) || String(d.code)}`, about: [podOf(d), nodeId(str(d.node))], level: KEY, tone: 'bad' });
};

// ---- endpoints ----

/** A matched Pod's line under an endpoints event. */
function memberItem(namespace: string, m: Data): ViewEventItem {
  const why = str(m.why);
  let value = 'ready';
  if (why === 'terminal') value = `no endpoint: phase ${str(m.phase)}`;
  else if (why === 'noIP') value = `no endpoint: no Pod IP yet (phase ${str(m.phase) || 'Pending'})`;
  else if (why === 'nodeNotFound') value = `no endpoint: its node ${str(m.node)} is not found`;
  else if (why === 'terminating') value = 'not ready: terminating';
  else if (why === 'notReady') value = `not ready: Ready is not True${str(m.readyReason) !== '' ? ` (${str(m.readyReason)})` : ''}`;
  return { entity: objectId('Pod', namespace, str(m.name)), label: str(m.name), value, tone: m.ready === true ? 'good' : 'bad' };
}

const endpointsSync: Mapper = (r, x) => {
  const d = dataOf(r);
  const ns = str(d.namespace);
  const svc = objectId('Service', ns, str(d.name));
  const members = dataList(d.pods);
  const items = members.map((m) => memberItem(ns, m));
  const selector = d.selector === null ? null : selectorWords(d.selector);
  const lines = new Map(items.map((i) => [i.label, i.value]));
  const previous = x.members.get(str(d.uid));
  x.members.set(str(d.uid), { selector, lines });
  const same = previous !== undefined && previous.selector === selector && previous.lines.size === lines.size && [...lines].every(([k, v]) => previous.lines.get(k) === v);
  const changed = d.changed === true;
  if (same && !changed) return undefined;
  const ready = members.filter((m) => m.ready === true).length;
  let text: string;
  if (d.selector === null) text = `Service ${ns}/${str(d.name)} has no selector: no controller manages its endpoints`;
  else if (members.length === 0) text = `Service ${ns}/${str(d.name)} selects no Pod: none in ${ns} carries ${selectorWords(d.selector)}`;
  else text = `Service ${ns}/${str(d.name)} selects ${members.length} Pod(s): ${ready} ready, ${members.length - ready} not`;
  const e = event(r, { text, about: [svc, ...items.map((i) => i.entity as string)], level: changed || previous === undefined ? KEY : DETAIL, tone: members.length === 0 || ready === 0 ? 'bad' : ready < members.length ? 'neutral' : 'good', items });
  // Exactly one Pod's line changed: the cause travelled between the Service and that Pod.
  if (previous !== undefined) {
    const before = previous.lines;
    const diff = items.filter((i) => before.get(i.label) !== i.value);
    const gone = [...before.keys()].filter((k) => !lines.has(k));
    if (diff.length + gone.length === 1) e.link = { from: svc, to: diff[0]?.entity ?? objectId('Pod', ns, gone[0] as string) };
  }
  return e;
};

/** `app=web,tier=front`, as labels.FormatLabels prints a set. */
export function selectorWords(sel: Json | undefined): string {
  if (!isData(sel)) return '<none>';
  return Object.keys(sel)
    .sort()
    .map((k) => `${k}=${str(sel[k])}`)
    .join(',');
}

// ---- workloads ----

const replicaSetScale: Mapper = (r) => {
  const d = dataOf(r);
  const rs = objectId('ReplicaSet', str(d.namespace), str(d.name));
  const count = num(d.count) ?? 0;
  const pods = list(d.pods).map((p) => str(p));
  const text = `ReplicaSet ${str(d.namespace)}/${str(d.name)} has ${String(d.active)} of ${String(d.replicas)} Pods: ${d.action === 'create' ? 'creating' : 'deleting'} ${count}`;
  return event(r, { text, about: [rs], level: DETAIL, tone: 'neutral', ...(pods.length > 0 ? { items: pods.map((p) => ({ entity: objectId('Pod', str(d.namespace), p), label: p, value: 'to delete', tone: 'neutral' as ViewTone })) } : {}) });
};

/** The rollout arithmetic a scale step used, as items under its event. */
const SCALE_NUMBERS: [string, string][] = [
  ['replicas', 'Replicas'],
  ['maxSurge', 'maxSurge'],
  ['maxUnavailable', 'maxUnavailable'],
  ['maxTotalPods', 'At most (replicas + maxSurge)'],
  ['currentPodCount', 'Pods now'],
  ['minAvailable', 'At least available (replicas − maxUnavailable)'],
  ['availablePodCount', 'Available now'],
];

function numberItems(d: Data): ViewEventItem[] {
  return SCALE_NUMBERS.filter(([k]) => num(d[k]) !== undefined).map(([k, label]) => ({ label, value: String(d[k]), tone: 'neutral' as ViewTone }));
}

const deploymentScale: Mapper = (r) => {
  const d = dataOf(r);
  const dep = objectId('Deployment', str(d.namespace), str(d.name));
  const rs = objectId('ReplicaSet', str(d.namespace), str(d.replicaSet));
  const from = num(d.from) ?? 0;
  const to = num(d.to) ?? 0;
  const text = str(d.step) === 'new ReplicaSet' ? `Deployment ${str(d.namespace)}/${str(d.name)}: new ReplicaSet ${str(d.replicaSet)} with ${to} replica(s)` : `Deployment ${str(d.namespace)}/${str(d.name)}: scaled ReplicaSet ${str(d.replicaSet)} ${to > from ? 'up' : 'down'} from ${from} to ${to} (${str(d.step)})`;
  return event(r, { text, about: [rs, dep], level: KEY, tone: 'neutral', link: { from: dep, to: rs }, items: numberItems(d) });
};

const rolloutWaiting: Mapper = (r, x) => {
  const d = dataOf(r);
  const slot = `deployment.rollout.waiting ${str(d.namespace)}/${str(d.name)}`;
  const signature = JSON.stringify(d);
  if (x.last.get(slot) === signature) return undefined;
  x.last.set(slot, signature);
  const dep = objectId('Deployment', str(d.namespace), str(d.name));
  const text = `Deployment ${str(d.namespace)}/${str(d.name)} waits: ${String(d.newAvailable)} of ${String(d.newReplicas)} Pods of the new ReplicaSet ${str(d.newReplicaSet)} available`;
  return event(r, { text, about: [dep, objectId('ReplicaSet', str(d.namespace), str(d.newReplicaSet))], level: DETAIL, tone: 'neutral', items: numberItems(d) });
};

const gcDelete: Mapper = (r) => {
  const d = dataOf(r);
  const target = aboutObject(str(d.kind), str(d.namespace), str(d.name));
  const owners = dataList(d.owners);
  const ownerIds = owners.map((o) => viewIdOf(str(o.kind), str(d.namespace), str(o.name))).filter((x): x is string => x !== undefined);
  const why = owners.map((o) => `${str(o.kind)} ${str(o.name)} ${o.gone === true ? 'is gone' : 'is being deleted with its dependents'}`).join(', ');
  const object = viewIdOf(str(d.kind), str(d.namespace), str(d.name));
  const e = event(r, { text: `deletes ${str(d.kind)} ${str(d.namespace) ? `${str(d.namespace)}/` : ''}${str(d.name)}: ${why}`, about: [...target, ...ownerIds], level: KEY, tone: 'neutral' }, object ? { object } : {});
  if (ownerIds.length === 1 && target[0]) e.link = { from: ownerIds[0] as string, to: target[0] };
  return e;
};

const namespaceRemaining: Mapper = (r) => {
  const d = dataOf(r);
  const remaining = isData(d.remaining) ? d.remaining : {};
  return event(r, {
    text: `namespace ${str(d.namespace)} is not empty yet: about ${String(d.estimate)} s until its content is gone`,
    about: [namespaceId(str(d.namespace))],
    level: DETAIL,
    tone: 'neutral',
    items: Object.keys(remaining).map((k) => ({ label: k.replace(/\.$/, ''), value: `${String(remaining[k])} left`, tone: 'neutral' as ViewTone })),
  });
};

const namespaceFinalized: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `namespace ${str(d.namespace)} is empty: its finalizer is removed and it goes`, about: [namespaceId(str(d.namespace))], level: KEY, tone: 'neutral' });
};

// ---- nodes ----

const nodeUnknown: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `node ${str(d.node)} stopped reporting: no Lease renewal or status since ${clock(num(d.lastSeen) ?? r.t)} (grace ${duration(num(d.grace) ?? 0)}); its conditions are Unknown`, about: [nodeId(str(d.node))], level: KEY, tone: 'bad' });
};

const podNotReady: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `Pod ${str(d.namespace)}/${str(d.name)} marked not ready: its node ${str(d.node)} is not ready`, about: [podOf(d), nodeId(str(d.node))], level: KEY, tone: 'bad' });
};

const nodeReady: Mapper = (r) => {
  const d = dataOf(r);
  const node = str(d.node);
  return event(r, { text: `reports node ${node} Ready${str(d.from) !== '' ? ` (was ${str(d.from)})` : ''}`, about: [nodeId(node)], level: KEY, tone: 'good' });
};

const kubeletStart: Mapper = (r) => {
  const node = r.source.slice('k8s.kubelet/'.length);
  return event(r, { text: 'started', about: [nodeId(node)], level: DETAIL, tone: 'neutral' });
};

const kubeletStop: Mapper = (r) => {
  const node = r.source.slice('k8s.kubelet/'.length);
  return event(r, { text: 'stopped', about: [nodeId(node)], level: KEY, tone: 'bad' });
};

// ---- the kubelet and the runtime ----

const aboutPod = (d: Data): string[] => [podOf(d), ...(str(d.node) !== '' ? [nodeId(str(d.node))] : [])];

const stateWords = (s: Json | undefined): string => containerStateWords(isData(s) ? s : undefined);

const kubeletStatus: Mapper = (r) => {
  const d = dataOf(r);
  const items: ViewEventItem[] = [];
  const pair = (v: Json | undefined): Data => (isData(v) ? v : {});
  if (isData(d.phase)) items.push({ label: 'Phase', value: `${str(pair(d.phase).from) || '(none)'} → ${str(pair(d.phase).to)}`, tone: ['Failed'].includes(str(pair(d.phase).to)) ? 'bad' : 'neutral' });
  if (isData(d.ready)) items.push({ label: 'Ready', value: `${str(pair(d.ready).from) || '(none)'} → ${str(pair(d.ready).to)}${str(pair(d.ready).reason) !== '' ? ` (${str(pair(d.ready).reason)})` : ''}`, tone: str(pair(d.ready).to) === 'True' ? 'good' : 'bad' });
  if (isData(d.podIP)) items.push({ label: 'IP', value: str(pair(d.podIP).to) || '(none)', tone: 'neutral' });
  for (const c of dataList(d.containers)) {
    const to = pair(c.to);
    const bad = (to.state === 'waiting' && str(to.reason) !== '' && str(to.reason) !== 'ContainerCreating') || (to.state === 'terminated' && num(to.exitCode) !== 0);
    items.push({ label: str(c.name), value: `${stateWords(c.from)} → ${stateWords(c.to)}`, tone: bad ? 'bad' : to.state === 'running' ? 'good' : 'neutral' });
  }
  const visible = isData(d.phase) || isData(d.ready);
  const ready = str(pair(d.ready).to);
  const tone: ViewTone = isData(d.ready) ? (ready === 'True' ? 'good' : 'bad') : str(pair(d.phase).to) === 'Failed' ? 'bad' : 'neutral';
  return event(r, { text: `reports Pod ${str(d.namespace)}/${str(d.name)}: ${items.map((i) => `${i.label} ${i.value}`).join(', ')}`, about: aboutPod(d), level: visible ? KEY : DETAIL, tone, items });
};

const kubeletBackoff: Mapper = (r, x) => {
  const d = dataOf(r);
  const containerId = str(d.containerId);
  const first = !x.backoffShown.has(containerId);
  x.backoffShown.add(containerId);
  const endsAt = num(d.endsAt) ?? r.t;
  const retryAt = num(d.retryAt) ?? r.t;
  const exit = x.exits.get(containerId);
  const items: ViewEventItem[] = [
    { label: 'Exit code', value: String(d.exitCode), tone: 'bad' },
    { label: 'Back-off', value: duration(num(d.backoffMs) ?? 0), tone: 'neutral' },
    { label: 'Back-off ends', value: clock(endsAt), tone: 'neutral' },
    { label: 'Next sync', value: clock(retryAt), tone: 'neutral' },
  ];
  return event(r, {
    text: `container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)} is in CrashLoopBackOff: back-off ${duration(num(d.backoffMs) ?? 0)} after it exited with ${String(d.exitCode)}`,
    about: aboutPod(d),
    level: first ? KEY : DETAIL,
    tone: 'bad',
    items,
    causes: [...(r.causes ?? []), ...(exit !== undefined && exit < r.id ? [exit] : [])],
  }, { container: str(d.container), exitCode: num(d.exitCode) ?? 0, endsAt, retryAt, backoffMs: num(d.backoffMs) ?? 0 });
};

const kubeletRestart: Mapper = (r, x) => {
  const d = dataOf(r);
  const exit = x.exits.get(str(d.containerId));
  return event(r, {
    text: `restarts container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)} (restart ${String(d.restartCount)}), which exited with ${String(d.exitCode)}`,
    about: aboutPod(d),
    level: KEY,
    tone: 'neutral',
    causes: [...(r.causes ?? []), ...(exit !== undefined && exit < r.id ? [exit] : [])],
  }, { container: str(d.container), exitCode: num(d.exitCode) ?? 0 });
};

const kubeletKill: Mapper = (r) => {
  const d = dataOf(r);
  const why: Record<string, string> = { deleted: 'the Pod is being deleted', removed: 'the Pod is gone from the API', 'definition changed': 'its definition changed', 'sandbox changed': 'its sandbox changed', 'terminal phase': 'the Pod reached a terminal phase' };
  return event(r, { text: `stops ${list(d.containers).map((c) => str(c)).join(', ')} of Pod ${str(d.namespace)}/${str(d.name)}: ${why[str(d.why)] ?? str(d.why)} (grace ${duration(num(d.grace) ?? 0)})`, about: aboutPod(d), level: KEY, tone: 'neutral' });
};

const kubeletPodDelete: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `removes Pod ${str(d.namespace)}/${str(d.name)} from the API: its containers have stopped`, about: aboutPod(d), level: KEY, tone: 'neutral' });
};

const podDetail =
  (words: (d: Data) => string, tone: ViewTone = 'neutral'): Mapper =>
  (r) => {
    const d = dataOf(r);
    return event(r, { text: words(d), about: aboutPod(d), level: DETAIL, tone });
  };

const pullDone: Mapper = (r) => {
  const d = dataOf(r);
  const ok = d.ok === true;
  const why = str(d.error) || (str(d.notSimulated) !== '' ? `[sim] ${str(d.notSimulated)}` : '');
  return event(r, { text: ok ? `pulled ${str(d.ref)}` : `could not pull ${str(d.ref)}: ${why}`, about: aboutPod(d), level: ok ? DETAIL : KEY, tone: ok ? 'good' : 'bad' });
};

const containerStarted: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)} started (attempt ${String(d.attempt)})`, about: aboutPod(d), level: KEY, tone: 'good' }, { container: str(d.container) });
};

const containerExited: Mapper = (r) => {
  const d = dataOf(r);
  const code = num(d.exitCode) ?? 0;
  const stopping = d.stopping === true;
  return event(r, {
    text: `container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)} exited with code ${code} (${str(d.reason)})${stopping ? ' after the kubelet stopped it' : ''}`,
    about: aboutPod(d),
    level: KEY,
    tone: code === 0 || stopping ? 'neutral' : 'bad',
    items: [
      { label: 'Exit code', value: String(code), tone: code === 0 || stopping ? 'neutral' : 'bad' },
      { label: 'Reason', value: str(d.reason), tone: code === 0 || stopping ? 'neutral' : 'bad' },
    ],
  }, { container: str(d.container), exitCode: code, reason: str(d.reason) });
};

const containerStartFailed: Mapper = (r) => {
  const d = dataOf(r);
  return event(r, { text: `container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)} could not start: ${str(d.message)}`, about: aboutPod(d), level: KEY, tone: 'bad', items: [{ label: 'Exit code', value: String(d.exitCode), tone: 'bad' }, { label: 'Reason', value: str(d.reason), tone: 'bad' }] }, { container: str(d.container), exitCode: num(d.exitCode) ?? 0, reason: str(d.reason) });
};

const eventRecorded: Mapper = (r) => {
  const d = dataOf(r);
  const reg = isData(d.regarding) ? d.regarding : {};
  const about = aboutObject(str(reg.kind), str(reg.namespace), str(reg.name));
  return event(r, { text: `Event ${str(d.reason)}: ${str(d.message)}`, about, level: DETAIL, tone: str(d.type) === 'Warning' ? 'bad' : 'neutral' });
};

const eventRejected: Mapper = (r) => event(r, { text: r.message, about: [], level: DETAIL, tone: 'bad' });

const gap: Mapper = (r) => {
  const d = dataOf(r);
  const about = str(d.name) !== '' && str(d.namespace) !== '' ? aboutPod(d) : str(d.service) !== '' ? [objectId('Service', ...(str(d.service).split('/') as [string, string]))] : [];
  return event(r, { text: `[sim] ${r.message}`, about, level: DETAIL, tone: 'bad' });
};

const MAPPERS: Record<string, Mapper> = {
  'apiserver.write': apiserverWrite,
  'controller.write': controllerWrite,
  'controller.write-failed': controllerWrite,
  'controller.error': controllerTrouble,
  'controller.dropped': controllerTrouble,
  'controller.stop': controllerStop,
  'scheduler.unschedulable': unschedulable,
  'scheduler.bound': bound,
  'scheduler.bind-failed': bindFailed,
  'endpoints.sync': endpointsSync,
  'replicaset.scale': replicaSetScale,
  'deployment.scale': deploymentScale,
  'deployment.rollout.waiting': rolloutWaiting,
  'gc.delete': gcDelete,
  'namespace.content-remaining': namespaceRemaining,
  'namespace.finalized': namespaceFinalized,
  'nodelifecycle.unknown': nodeUnknown,
  'nodelifecycle.pod-not-ready': podNotReady,
  'kubelet.node.ready': nodeReady,
  'kubelet.start': kubeletStart,
  'kubelet.stop': kubeletStop,
  'kubelet.status': kubeletStatus,
  'kubelet.backoff': kubeletBackoff,
  'kubelet.container.restart': kubeletRestart,
  'kubelet.kill': kubeletKill,
  'kubelet.pod.delete': kubeletPodDelete,
  'kubelet.pod.terminal': podDetail((d) => `Pod ${str(d.namespace)}/${str(d.name)} reached phase ${str(d.phase)}: the kubelet stops what still runs`),
  'kubelet.pod.terminated': podDetail((d) => `finished terminating Pod ${str(d.namespace)}/${str(d.name)} (phase ${str(d.phase)})`),
  'kubelet.sandbox': podDetail((d) => `creates the sandbox of Pod ${str(d.namespace)}/${str(d.name)} (${str(d.reason)})`),
  'kubelet.gc': podDetail((d) => `removed the containers and logs of deleted Pod ${str(d.namespace)}/${str(d.name)}`),
  'kubelet.pull.start': podDetail((d) => `pulls ${str(d.ref)}${(num(d.queued) ?? 0) > 0 ? ` (${String(d.queued)} more queued)` : ''}`),
  'kubelet.pull.done': pullDone,
  'kubelet.gap': gap,
  'runtime.sandbox.ready': podDetail((d) => `sandbox of Pod ${str(d.namespace)}/${str(d.name)} ready with IP ${str(d.ip)}`),
  'runtime.sandbox.stopped': podDetail((d) => `sandbox of Pod ${str(d.namespace)}/${str(d.name)} stopped`),
  'runtime.container.created': podDetail((d) => `container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)} created from ${str(d.image)}`),
  'runtime.container.started': containerStarted,
  'runtime.container.exited': containerExited,
  'runtime.container.start-failed': containerStartFailed,
  'runtime.container.signal': podDetail((d) => `${str(d.signal)} to container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)}`),
  'runtime.signal.ignored': podDetail((d) => `${str(d.signal)} ignored by container ${str(d.container)} of Pod ${str(d.namespace)}/${str(d.name)}: PID 1 has no handler for it`),
  'runtime.model.gap': gap,
  'sim.gap': gap,
  'event.recorded': eventRecorded,
  'event.rejected': eventRejected,
};

/** The trace kinds this provider maps (to an event, or to nothing when the record repeats). */
export const SHOWN_KINDS: readonly string[] = Object.keys(MAPPERS).sort();

/** The k8s components' records as view events, in record order. */
export function k8sEvents(records: readonly TraceRecord[]): K8sViewEvent[] {
  const x: Ctx = { byId: new Map(), last: new Map(), exits: new Map(), backoffShown: new Set(), members: new Map() };
  for (const r of records) {
    x.byId.set(r.id, r);
  }
  const out: K8sViewEvent[] = [];
  for (const r of records) {
    if (r.kind === 'runtime.container.exited') x.exits.set(str(dataOf(r).containerId), r.id);
    const m = MAPPERS[r.kind];
    if (!m) continue;
    const e = m(r, x);
    if (e) out.push(e);
  }
  return out;
}
