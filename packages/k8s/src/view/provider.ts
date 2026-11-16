// The Kubernetes view provider (PLAN.md §6.5): namespaces holding Deployments, ReplicaSets and
// Services; Nodes on their machines holding the Pods bound to them; Pods with no node yet; the
// ownership chain, what each Service selects and where it routes. A pure function of the world: it
// reads the store of the first serving API server, as the checks do, and never sends a request.
//
// Words a real tool also prints come from the code that prints them for kubectl: a Pod's status is
// printPod's STATUS cell, a Node's printNode's, a Deployment's printDeployment's READY, and the
// fact labels are the printers' column names. Taints read as `kubectl describe node` prints them.
// The judgement of each state (healthy, progressing, …) is the simulator's, written below.

import { compareCodeUnits, type ProvenanceSpec, type ViewEntity, type ViewFact, type ViewKind, type ViewPart, type ViewProviderSpec, type ViewRelation, type ViewState, type World } from '@simlab/kernel';
import { machineViewId, type HostSlice } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { formatLabels, labelsString, selectorFromSet, selectorMatches, selectorEmpty } from '../apimachinery/labels.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { K8S, storeList, type EtcdData, type K8sSlice } from '../apiserver/store.ts';
import { strategyFor } from '../apiserver/strategies.ts';
import { sortedTaints, sortedTolerations, taintString, tolerationString } from '../kubectl/describe/common.ts';
import { printHandler } from '../printers/handlers.ts';
import { bool, metadata, num, obj, objs, str, strMap, type GenerateOptions } from '../printers/helpers.ts';

export const KINDS = {
  namespace: 'k8s.Namespace',
  node: 'k8s.Node',
  pod: 'k8s.Pod',
  deployment: 'k8s.Deployment',
  replicaSet: 'k8s.ReplicaSet',
  service: 'k8s.Service',
} as const;

const VIEW_KINDS: ViewKind[] = [
  { kind: KINDS.namespace, shape: 'scope', label: 'Namespace', plural: 'Namespaces' },
  { kind: KINDS.node, shape: 'host', label: 'Node', plural: 'Nodes' },
  { kind: KINDS.pod, shape: 'process', label: 'Pod', plural: 'Pods', placedIn: KINDS.node, unplaced: 'Pods with no node' },
  { kind: KINDS.deployment, shape: 'workload', label: 'Deployment', plural: 'Deployments' },
  { kind: KINDS.replicaSet, shape: 'workload', label: 'ReplicaSet', plural: 'ReplicaSets' },
  { kind: KINDS.service, shape: 'endpoint', label: 'Service', plural: 'Services' },
];

/**
 * The namespaces Kubernetes creates for itself (docs: concepts/overview/working-with-objects/
 * namespaces, "Initial namespaces"); `default` is the learner's.
 */
const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

export const namespaceId = (ns: string): string => `k8s/Namespace/${ns}`;
export const nodeId = (name: string): string => `k8s/Node/${name}`;
const objectId = (kind: string, ns: string, name: string): string => `k8s/${kind}/${ns}/${name}`;

const nameOf = (o: JsonObject): string => str(metadata(o).name);
const nsOf = (o: JsonObject): string => str(metadata(o).namespace);
const uidOf = (o: JsonObject): string => str(metadata(o).uid);
const deleting = (o: JsonObject): boolean => metadata(o).deletionTimestamp !== undefined && metadata(o).deletionTimestamp !== null;

/** The store the view reads: the first serving API server's, in key order (as the checks read). */
function etcdOf(world: World): EtcdData | undefined {
  const s = world.slices[K8S] as K8sSlice | undefined;
  if (!s) return undefined;
  const key = Object.keys(s.apiServers).sort(compareCodeUnits)[0];
  const server = key === undefined ? undefined : (s.apiServers[key] as ApiServerConfig);
  return server ? s.etcd[server.etcd] : undefined;
}

function list(d: EtcdData, group: string, resource: string): JsonObject[] {
  const st = strategyFor(group, resource);
  if (!st) throw new Error(`no strategy for ${resource}`);
  return storeList(d, st.storage);
}

/** The printed row of an object as kubectl's table shows it (wide), by column name. */
function cells(group: string, kind: string, o: JsonObject, now: number): Record<string, string> {
  const h = printHandler(group, kind);
  if (!h) throw new Error(`no printer for ${kind}`);
  const opts: GenerateOptions = { noHeaders: false, wide: true, now };
  const row = h.print(o, opts)[0];
  const out: Record<string, string> = {};
  h.columns.forEach((c, i) => {
    out[c.name] = String(row?.cells[i] ?? '');
  });
  return out;
}

const condition = (o: JsonObject, type: string): JsonObject | undefined => objs(obj(o.status).conditions).find((c) => c.type === type);

/** The controller owner reference, as the garbage collector and controllers read it. */
const controllerRef = (o: JsonObject): JsonObject | undefined => objs(metadata(o).ownerReferences).find((r) => bool(r.controller));

/** A list fact: the entries as `value` joins them, and each entry for a figure that shows some by key. */
function listFact(label: string, items: string[], value: string): ViewFact {
  return items.length > 0 ? { label, value, items } : { label, value };
}

/** Labels as labels.FormatLabels prints them (sorted `k=v`, `<none>`). */
const labelSetFact = (label: string, set: Record<string, string>): ViewFact => {
  const s = labelsString(set);
  return listFact(label, s === '' ? [] : s.split(','), formatLabels(set));
};

const labelsFact = (o: JsonObject): ViewFact => labelSetFact('Labels', strMap(metadata(o).labels));

/**
 * A workload's Selector column (metav1.FormatLabelSelector), with its entries when it is made of
 * matchLabels alone: an expression (`tier in (a,b)`) holds commas of its own, so it is not split.
 */
function selectorFact(o: JsonObject, printed: string): ViewFact {
  const sel = obj(obj(o.spec).selector);
  const expressions = objs(sel.matchExpressions);
  const s = labelsString(strMap(sel.matchLabels));
  return listFact('Selector', expressions.length === 0 && s !== '' ? s.split(',') : [], printed);
}

/** `memory=256Mi` per resource a container requests, prefixed by the container when there are several. */
function requests(pod: JsonObject): ViewFact | undefined {
  const containers = objs(obj(pod.spec).containers);
  const items: string[] = [];
  for (const c of containers) {
    const r = strMap(obj(c.resources).requests);
    for (const n of Object.keys(r).sort(compareCodeUnits)) items.push(`${containers.length > 1 ? `${str(c.name)}: ` : ''}${n}=${r[n] as string}`);
  }
  return items.length > 0 ? listFact('Requests', items, items.join(', ')) : undefined;
}

/** Waiting reasons of a container that is still being started, not one that failed. */
const STARTING = new Set(['ContainerCreating', 'PodInitializing']);

function podState(pod: JsonObject): ViewState {
  if (deleting(pod)) return 'progressing';
  const status = obj(pod.status);
  const phase = str(status.phase);
  if (phase === 'Succeeded') return 'healthy';
  if (phase === 'Failed') return 'failed';
  if (phase === 'Unknown' || str(status.reason) === 'NodeLost') return 'unknown';
  for (const cs of [...objs(status.initContainerStatuses), ...objs(status.containerStatuses)]) {
    const state = obj(cs.state);
    const waiting = state.waiting === undefined || state.waiting === null ? undefined : obj(state.waiting);
    const terminated = state.terminated === undefined || state.terminated === null ? undefined : obj(state.terminated);
    if (waiting && str(waiting.reason) !== '' && !STARTING.has(str(waiting.reason))) return 'failed';
    if (terminated && num(terminated.exitCode) !== 0) return 'failed';
  }
  if (phase === 'Pending') {
    const scheduled = condition(pod, 'PodScheduled');
    // The scheduler found no node, or a gate holds the Pod: it waits for something to change.
    if (str(obj(pod.spec).nodeName) === '' && scheduled && scheduled.status === 'False') return 'degraded';
    return 'progressing';
  }
  return condition(pod, 'Ready')?.status === 'True' ? 'healthy' : 'degraded';
}

function nodeState(node: JsonObject): ViewState {
  const ready = condition(node, 'Ready');
  if (!ready || ready.status === 'Unknown') return 'unknown';
  if (ready.status !== 'True') return 'failed';
  return bool(obj(node.spec).unschedulable) ? 'degraded' : 'healthy';
}

function deploymentState(d: JsonObject): ViewState {
  const spec = obj(d.spec);
  const status = obj(d.status);
  const want = num(spec.replicas);
  const progressing = condition(d, 'Progressing');
  if (progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') return 'failed';
  const updated = num(status.updatedReplicas);
  const available = num(status.availableReplicas);
  if (updated === want && available === want && num(status.replicas) === want) return 'healthy';
  if (updated < want || num(status.replicas) > updated) return 'progressing';
  return 'degraded';
}

export function k8sView(world: World): ViewPart {
  const d = etcdOf(world);
  if (!d) return { kinds: VIEW_KINDS, entities: [], relations: [] };
  const now = world.clock.now;
  const entities: ViewEntity[] = [];
  const relations: ViewRelation[] = [];
  const host = world.slices['host'] as HostSlice | undefined;
  const machineByHostname = new Map<string, string>();
  if (host) for (const id of Object.keys(host.machines).sort(compareCodeUnits)) machineByHostname.set(host.machines[id]?.hostname ?? '', id);

  /** Entity ids by uid, for owner references. */
  const byUid = new Map<string, string>();

  const namespaces = list(d, '', 'namespaces');
  for (const ns of namespaces) {
    const name = nameOf(ns);
    const c = cells('', 'Namespace', ns, now);
    const e: ViewEntity = { id: namespaceId(name), kind: KINDS.namespace, label: name, state: str(obj(ns.status).phase) === 'Terminating' ? 'progressing' : 'healthy', status: c['Status'] ?? '', facts: [labelsFact(ns)] };
    if (SYSTEM_NAMESPACES.has(name)) e.system = true;
    entities.push(e);
  }
  const nsIds = new Set(namespaces.map((n) => nameOf(n)));
  const inNs = (e: ViewEntity, ns: string): ViewEntity => {
    if (nsIds.has(ns)) {
      e.container = namespaceId(ns);
      if (SYSTEM_NAMESPACES.has(ns)) e.system = true;
    }
    return e;
  };

  const nodeNames = new Set<string>();
  for (const node of list(d, '', 'nodes')) {
    const name = nameOf(node);
    nodeNames.add(name);
    byUid.set(uidOf(node), nodeId(name));
    const c = cells('', 'Node', node, now);
    // As kubectl describe node prints them: sorted by effect and key, `<none>` when empty.
    const taints = sortedTaints(obj(node.spec).taints).map(taintString);
    const alloc = strMap(obj(node.status).allocatable);
    const allocItems = Object.keys(alloc).sort(compareCodeUnits).map((k) => `${k}=${alloc[k] as string}`);
    const facts: ViewFact[] = [
      { label: 'Status', value: c['Status'] ?? '' },
      { label: 'Roles', value: c['Roles'] ?? '' },
      { label: 'Internal-IP', value: c['Internal-IP'] ?? '' },
      listFact('Taints', taints, taints.length > 0 ? taints.join(', ') : '<none>'),
      labelsFact(node),
      listFact('Allocatable', allocItems, allocItems.join(', ')),
    ];
    const e: ViewEntity = { id: nodeId(name), kind: KINDS.node, label: name, state: nodeState(node), status: c['Status'] ?? '', facts };
    // The kubelet registers its Node under the machine's hostname (kubelet --hostname-override unset).
    const machine = machineByHostname.get(name);
    if (machine !== undefined) e.container = machineViewId(machine);
    entities.push(e);
  }

  const pods = list(d, '', 'pods');
  const podStates = new Map<string, ViewState>();
  for (const pod of pods) {
    const ns = nsOf(pod);
    const name = nameOf(pod);
    const id = objectId('Pod', ns, name);
    byUid.set(uidOf(pod), id);
    const c = cells('', 'Pod', pod, now);
    const node = str(obj(pod.spec).nodeName);
    const facts: ViewFact[] = [
      { label: 'Namespace', value: ns },
      { label: 'Ready', value: c['Ready'] ?? '' },
      { label: 'Status', value: c['Status'] ?? '' },
      // The count only: the age of the last restart changes every second.
      { label: 'Restarts', value: (c['Restarts'] ?? '').split(' ')[0] ?? '' },
      { label: 'IP', value: c['IP'] ?? '' },
      { label: 'Node', value: c['Node'] ?? '' },
      labelsFact(pod),
    ];
    // Node-Selectors and Tolerations as kubectl describe pod titles and prints them.
    facts.push(labelSetFact('Node-Selectors', strMap(obj(pod.spec).nodeSelector)));
    const tolerations = sortedTolerations(obj(pod.spec).tolerations).map(tolerationString);
    facts.push(listFact('Tolerations', tolerations, tolerations.length > 0 ? tolerations.join(', ') : '<none>'));
    const req = requests(pod);
    if (req !== undefined) facts.push(req);
    const state = podState(pod);
    podStates.set(id, state);
    const e: ViewEntity = { id, kind: KINDS.pod, label: name, state, status: c['Status'] ?? '', facts };
    if (nsIds.has(ns)) {
      e.scope = namespaceId(ns);
      if (SYSTEM_NAMESPACES.has(ns)) e.system = true;
    }
    if (node !== '' && nodeNames.has(node)) e.container = nodeId(node);
    if (str(obj(pod.status).phase) === 'Succeeded') e.muted = true;
    entities.push(e);
  }

  const owned = new Map<string, string[]>();
  const own = (o: JsonObject, id: string): void => {
    const ref = controllerRef(o);
    if (!ref) return;
    const owner = str(ref.uid);
    owned.set(owner, [...(owned.get(owner) ?? []), id]);
  };
  for (const pod of pods) own(pod, objectId('Pod', nsOf(pod), nameOf(pod)));

  for (const dep of list(d, 'apps', 'deployments')) {
    const ns = nsOf(dep);
    const id = objectId('Deployment', ns, nameOf(dep));
    byUid.set(uidOf(dep), id);
    const c = cells('apps', 'Deployment', dep, now);
    const facts: ViewFact[] = [
      { label: 'Ready', value: c['Ready'] ?? '' },
      { label: 'Up-to-date', value: c['Up-to-date'] ?? '' },
      { label: 'Available', value: c['Available'] ?? '' },
      { label: 'Images', value: c['Images'] ?? '' },
      selectorFact(dep, c['Selector'] ?? ''),
    ];
    const e = inNs({ id, kind: KINDS.deployment, label: nameOf(dep), state: deploymentState(dep), status: c['Ready'] ?? '', facts }, ns);
    if (num(obj(dep.spec).replicas) === 0) e.muted = true;
    entities.push(e);
  }

  for (const rs of list(d, 'apps', 'replicasets')) {
    const ns = nsOf(rs);
    const id = objectId('ReplicaSet', ns, nameOf(rs));
    byUid.set(uidOf(rs), id);
    own(rs, id);
    const c = cells('apps', 'ReplicaSet', rs, now);
    const desired = num(obj(rs.spec).replicas);
    const status = obj(rs.status);
    const kids = owned.get(uidOf(rs)) ?? [];
    let state: ViewState = 'healthy';
    if (num(status.readyReplicas) < desired || num(status.replicas) !== desired) state = kids.some((k) => podStates.get(k) === 'failed' || podStates.get(k) === 'degraded') ? 'degraded' : 'progressing';
    const facts: ViewFact[] = [
      { label: 'Desired', value: c['Desired'] ?? '' },
      { label: 'Current', value: c['Current'] ?? '' },
      { label: 'Ready', value: c['Ready'] ?? '' },
      { label: 'Images', value: c['Images'] ?? '' },
      selectorFact(rs, c['Selector'] ?? ''),
    ];
    const e = inNs({ id, kind: KINDS.replicaSet, label: nameOf(rs), state, facts }, ns);
    if (desired === 0 && num(status.replicas) === 0) e.muted = true;
    entities.push(e);
  }

  // Ready endpoints per Service, from its EndpointSlices (label kubernetes.io/service-name).
  const routes = new Map<string, Set<string>>();
  const endpointCount = new Map<string, number>();
  for (const es of list(d, 'discovery.k8s.io', 'endpointslices')) {
    const svc = strMap(metadata(es).labels)['kubernetes.io/service-name'];
    if (svc === undefined) continue;
    const key = `${nsOf(es)}/${svc}`;
    for (const ep of objs(es.endpoints)) {
      endpointCount.set(key, (endpointCount.get(key) ?? 0) + 1);
      const ready = obj(ep.conditions).ready;
      // EndpointConditions.ready: nil means ready (discovery/v1 types.go).
      if (ready === false) continue;
      const ref = obj(ep.targetRef);
      const set = routes.get(key) ?? new Set<string>();
      set.add(ref.kind === 'Pod' ? objectId('Pod', str(ref.namespace) || nsOf(es), str(ref.name)) : `${key}#${set.size}`);
      routes.set(key, set);
    }
  }

  for (const svc of list(d, '', 'services')) {
    const ns = nsOf(svc);
    const name = nameOf(svc);
    const id = objectId('Service', ns, name);
    const c = cells('', 'Service', svc, now);
    const spec = obj(svc.spec);
    const key = `${ns}/${name}`;
    const ready = routes.get(key) ?? new Set<string>();
    const total = endpointCount.get(key) ?? 0;
    const facts: ViewFact[] = [
      { label: 'Type', value: c['Type'] ?? '' },
      { label: 'Cluster-IP', value: c['Cluster-IP'] ?? '' },
      { label: 'Port(s)', value: c['Port(s)'] ?? '' },
      listFact('Selector', spec.selector === undefined ? [] : labelsString(strMap(spec.selector)).split(',').filter((x) => x !== ''), c['Selector'] ?? ''),
    ];
    let state: ViewState = 'healthy';
    if (str(spec.type) !== 'ExternalName') state = ready.size === 0 ? 'failed' : ready.size < total ? 'degraded' : 'healthy';
    entities.push(inNs({ id, kind: KINDS.service, label: name, state, status: c['Type'] ?? '', facts }, ns));
    const selector = spec.selector === undefined ? undefined : selectorFromSet(strMap(spec.selector));
    if (selector && !selectorEmpty(selector)) {
      for (const pod of pods) if (nsOf(pod) === ns && selectorMatches(selector, strMap(metadata(pod).labels))) relations.push({ type: 'selects', from: id, to: objectId('Pod', ns, nameOf(pod)) });
    }
    for (const to of ready) relations.push({ type: 'routesTo', from: id, to });
  }

  for (const [owner, kids] of owned) {
    const from = byUid.get(owner);
    if (from !== undefined) for (const to of kids) relations.push({ type: 'owns', from, to });
  }
  return { kinds: VIEW_KINDS, entities, relations };
}

export const k8sViewProvider: ViewProviderSpec = { name: 'k8s', view: k8sView };

/** The words the view shows that kubectl also prints (docs/FIDELITY.md §3). */
export const VIEW_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'view.k8s.words',
    tag: 'source-derived',
    sources: [
      'pkg/printers/internalversion/printers.go printPod, printNode, printDeployment, printReplicaSet, printService, printNamespace (through packages/k8s/src/printers)',
      'staging/src/k8s.io/api/core/v1/taint.go Taint.ToString (through kubectl/describe/common.ts)',
      'staging/src/k8s.io/apimachinery/pkg/labels FormatLabels',
    ],
    note: 'status words, fact labels (the printers\' column names) and fact values of the X-ray; the judgement of each state is the simulator\'s (D-120)',
  },
];
