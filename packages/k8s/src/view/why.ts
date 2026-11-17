// "Why?" for the Kubernetes entities (PLAN.md §6.5, phase 13): the events that explain an entity's
// current state, oldest first, and a sentence. The world says what the state is (which events
// matter); the events say how it came about. Pure: it reads the store as the view does and the
// events it is given, and sends no request.
//
// The sentences are simulator vocabulary. They quote only what the events carry (a reason, an exit
// code, a time), and claim no behavior the engine does not have.

import { compareCodeUnits, type ViewEvent, type Why, type World } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { K8S, storeGet, type ApiObject, type EtcdData, type K8sSlice } from '../apiserver/store.ts';
import { strategyFor } from '../apiserver/strategies.ts';
import { namespaceId, nodeId, objectId } from './ids.ts';
import { clock, detailOf, duration, selectorWords } from './trace.ts';

const isObj = (v: Json | undefined): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v: Json | undefined): JsonObject => (isObj(v) ? v : {});
const objs = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);

function etcdOf(world: World): EtcdData | undefined {
  const s = world.slices[K8S] as K8sSlice | undefined;
  if (!s) return undefined;
  const key = Object.keys(s.apiServers).sort(compareCodeUnits)[0];
  const server = key === undefined ? undefined : (s.apiServers[key] as ApiServerConfig);
  return server ? s.etcd[server.etcd] : undefined;
}

function get(world: World, group: string, resource: string, namespace: string, name: string): ApiObject | undefined {
  const d = etcdOf(world);
  const st = strategyFor(group, resource);
  if (!d || !st) return undefined;
  return storeGet(d, st.storage, namespace === '' ? name : `${namespace}/${name}`);
}

const kindOf = (e: ViewEvent): string => detailOf(e)?.kind ?? '';
const isKind = (e: ViewEvent, ...kinds: string[]): boolean => kinds.includes(kindOf(e));
const latest = (evs: readonly ViewEvent[], pred: (e: ViewEvent) => boolean): ViewEvent | undefined => {
  for (let i = evs.length - 1; i >= 0; i--) if (pred(evs[i] as ViewEvent)) return evs[i];
  return undefined;
};

/** Events about the entity, from its latest creation on (an object deleted and made again starts over). */
function lifeOf(events: readonly ViewEvent[], id: string): ViewEvent[] {
  const about = events.filter((e) => e.about.includes(id));
  let start = 0;
  about.forEach((e, i) => {
    if (creates(e, id)) start = i;
  });
  return about.slice(start);
}

/** A write that created this very object. */
const creates = (e: ViewEvent, id: string): boolean => detailOf(e)?.object === id && isKind(e, 'apiserver.write/create', 'controller.write/create') && e.tone !== 'bad';
/** A write or a decision that deleted this very object. */
const deletes = (e: ViewEvent, id: string): boolean => detailOf(e)?.object === id && isKind(e, 'apiserver.write/delete', 'controller.write/delete', 'gc.delete');

const createdBy = (life: readonly ViewEvent[], id: string): ViewEvent | undefined => life.find((e) => creates(e, id));

function why(entity: string, summary: string, steps: (ViewEvent | undefined)[]): Why {
  const seen = new Set<number>();
  const out: ViewEvent[] = [];
  for (const s of steps) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return { entity, summary, steps: out.sort((a, b) => a.id - b.id) };
}

/** The few latest key events about an entity: what an entity with nothing to explain shows. */
const recent = (life: readonly ViewEvent[], n = 3): ViewEvent[] => life.filter((e) => e.level === 'key').slice(-n);

// ---- Pods ----

function podWhy(world: World, events: readonly ViewEvent[], id: string, ns: string, name: string): Why {
  const pod = get(world, '', 'pods', ns, name);
  const life = lifeOf(events, id);
  const created = createdBy(life, id);
  if (!pod) return why(id, `Pod ${ns}/${name} no longer exists.`, [created, ...recent(life)]);
  const spec = obj(pod.spec);
  const status = obj(pod.status);
  const node = str(spec.nodeName);
  const decision = latest(life, (e) => isKind(e, 'scheduler.unschedulable', 'scheduler.bound', 'scheduler.bind-failed'));

  const deletion = obj(pod.metadata).deletionTimestamp;
  if (deletion !== undefined && deletion !== null) {
    const del = latest(life, (e) => deletes(e, id));
    const kill = latest(life, (e) => isKind(e, 'kubelet.kill'));
    return why(id, `Pod ${ns}/${name} is being deleted${kill ? ': the kubelet is stopping its containers' : ''}.`, [created, del, kill]);
  }

  if (node === '') {
    if (decision && isKind(decision, 'scheduler.unschedulable')) {
      const rejected = (decision.items ?? []).filter((i) => i.tone === 'bad');
      return why(id, `Pending: kube-scheduler found no node for it; ${rejected.length === 1 ? 'the node rejected it' : `each of the ${rejected.length} nodes rejected it`} for the reason listed.`, [created, decision]);
    }
    return why(id, decision ? `Pending: ${decision.text}.` : 'Pending: not scheduled yet.', [created, decision]);
  }

  const steps: (ViewEvent | undefined)[] = [created, decision];
  const sentences: string[] = [];
  for (const cs of objs(status.containerStatuses)) {
    const c = str(cs.name);
    const of = (e: ViewEvent): boolean => detailOf(e)?.container === c;
    const state = obj(cs.state);
    const waiting = isObj(state.waiting) ? state.waiting : undefined;
    const reason = str(waiting?.reason);
    const exited = latest(life, (e) => of(e) && isKind(e, 'runtime.container.exited', 'runtime.container.start-failed'));
    const started = latest(life, (e) => of(e) && isKind(e, 'runtime.container.started'));
    const backoff = latest(life, (e) => of(e) && isKind(e, 'kubelet.backoff'));
    const restart = latest(life, (e) => of(e) && isKind(e, 'kubelet.container.restart'));
    const inBackoff = backoff && exited && backoff.id > exited.id && (!restart || restart.id < backoff.id);
    if (inBackoff || reason === 'CrashLoopBackOff') {
      const d = detailOf(backoff as ViewEvent);
      steps.push(exited, backoff);
      if (d && d.endsAt !== undefined && d.retryAt !== undefined) {
        const exit = exited ? detailOf(exited) : undefined;
        const head = `Container ${c} exited with code ${String(exit?.exitCode ?? d.exitCode ?? 0)}${exit?.reason ? ` (${exit.reason})` : ''} and is in back-off for ${duration(d.backoffMs ?? 0)}, until ${clock(d.endsAt)}`;
        sentences.push(d.retryAt >= d.endsAt ? `${head}; the kubelet restarts it at its next sync, ${clock(d.retryAt)}.` : `${head}; the kubelet restarts it at its first sync after that (the next is due at ${clock(d.retryAt)}).`);
      } else sentences.push(`Container ${c} is in CrashLoopBackOff.`);
      continue;
    }
    if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull' || reason === 'InvalidImageName' || reason === 'ErrImageNeverPull') {
      const pull = latest(life, (e) => isKind(e, 'kubelet.pull.done') && e.tone === 'bad');
      steps.push(pull);
      sentences.push(`Container ${c} is waiting: ${reason}${pull ? ` (${pull.text})` : ''}.`);
      continue;
    }
    if (isObj(state.terminated)) {
      steps.push(started, exited);
      sentences.push(`Container ${c} terminated with code ${String(num(state.terminated.exitCode))}${str(state.terminated.reason) !== '' ? ` (${str(state.terminated.reason)})` : ''}.`);
      continue;
    }
    if (isObj(state.running)) {
      steps.push(restart, started);
      sentences.push(`Container ${c} is running${num(cs.restartCount) > 0 ? ` after ${String(num(cs.restartCount))} restart(s)` : ''}.`);
      continue;
    }
    if (waiting) {
      steps.push(latest(life, (e) => isKind(e, 'kubelet.sandbox', 'kubelet.pull.start')));
      sentences.push(`Container ${c} is waiting${reason !== '' ? ` (${reason})` : ''}.`);
    }
  }
  const notReady = latest(life, (e) => isKind(e, 'nodelifecycle.pod-not-ready'));
  if (notReady && (!decision || notReady.id > decision.id)) {
    steps.push(notReady);
    sentences.push(`It is marked not ready: its node ${node} is not ready.`);
  }
  steps.push(latest(life, (e) => isKind(e, 'kubelet.status') && e.level === 'key'));
  const phase = str(status.phase) || 'Pending';
  return why(id, `${phase} on ${node}. ${sentences.join(' ')}`.trim(), steps);
}

// ---- workloads ----

function deploymentWhy(world: World, events: readonly ViewEvent[], id: string, ns: string, name: string): Why {
  const d = get(world, 'apps', 'deployments', ns, name);
  const life = lifeOf(events, id);
  const created = createdBy(life, id);
  if (!d) return why(id, `Deployment ${ns}/${name} no longer exists.`, [created, ...recent(life)]);
  const want = num(obj(d.spec).replicas);
  const st = obj(d.status);
  const scales = life.filter((e) => isKind(e, 'deployment.scale')).slice(-3);
  const changes = life.filter((e) => detailOf(e)?.object === id && isKind(e, 'apiserver.write/patch', 'apiserver.write/update')).slice(-2);
  const complete = num(st.updatedReplicas) === want && num(st.availableReplicas) === want && num(st.replicas) === want;
  const waiting = latest(life, (e) => isKind(e, 'deployment.rollout.waiting'));
  const lastScale = scales[scales.length - 1];
  const holding = !complete && waiting && (!lastScale || waiting.id > lastScale.id) ? waiting : undefined;
  // The controller's own verdict, when it gave up waiting (progress.go: the condition and its message).
  const progressing = objs(st.conditions).find((c) => c.type === 'Progressing');
  const deadline = progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded' ? `${str(progressing.reason)}: ${str(progressing.message)} ` : '';
  const summary = deadline + (complete
    ? `All ${want} replica(s) are up to date and available.`
    : holding
      ? `Rolling out: ${num(st.availableReplicas)} of ${want} available. ${holding.text}.`
      : `Rolling out: ${num(st.updatedReplicas)} of ${want} up to date, ${num(st.availableReplicas)} available.`);
  return why(id, summary, [created, ...changes, ...scales, holding]);
}

function replicaSetWhy(world: World, events: readonly ViewEvent[], id: string, ns: string, name: string): Why {
  const rs = get(world, 'apps', 'replicasets', ns, name);
  const life = lifeOf(events, id);
  const created = createdBy(life, id);
  if (!rs) return why(id, `ReplicaSet ${ns}/${name} no longer exists.`, [created, ...recent(life)]);
  const want = num(obj(rs.spec).replicas);
  const st = obj(rs.status);
  const scale = latest(life, (e) => isKind(e, 'deployment.scale'));
  const pods = life.filter((e) => e.link?.from === id).slice(-3);
  const by = scale ? ` ${scale.text}.` : '';
  return why(id, `${want} desired, ${num(st.replicas)} current, ${num(st.readyReplicas)} ready.${by}`, [created, scale, ...pods]);
}

// ---- Services ----

function serviceWhy(world: World, events: readonly ViewEvent[], id: string, ns: string, name: string): Why {
  const svc = get(world, '', 'services', ns, name);
  const life = lifeOf(events, id);
  const created = createdBy(life, id);
  if (!svc) return why(id, `Service ${ns}/${name} no longer exists.`, [created, ...recent(life)]);
  if (str(obj(svc.spec).type) === 'ExternalName') return why(id, `An ExternalName Service: it has no endpoints, only the name ${str(obj(svc.spec).externalName)}.`, [created]);
  // The controllers read an empty selector as none (endpointslice/util.ts serviceSelector).
  if (Object.keys(obj(obj(svc.spec).selector)).length === 0) return why(id, 'It has no selector: no controller manages its endpoints; whoever made them keeps them.', [created, ...recent(life, 2)]);
  const eps = latest(life, (e) => isKind(e, 'endpoints.sync') && e.about[0] === id);
  if (!eps) return why(id, 'No computation of its endpoints is recorded.', [created]);
  const items = eps.items ?? [];
  const ready = items.filter((i) => i.tone === 'good');
  const notReady = items.filter((i) => i.tone !== 'good');
  let summary: string;
  if (items.length === 0) summary = `Its selector ${selectorWords(obj(svc.spec).selector)} matches no Pod in ${ns}: no Pod carries those labels, so it has no endpoints.`;
  else if (notReady.length === 0) summary = `It selects ${items.length} Pod(s), all ready: ${ready.map((i) => i.label).join(', ')}.`;
  else summary = `It selects ${items.length} Pod(s), ${ready.length} ready. Not ready: ${notReady.map((i) => `${i.label} (${i.value})`).join('; ')}.`;
  return why(id, summary, [created, eps]);
}

// ---- Nodes and Namespaces ----

function nodeWhy(world: World, events: readonly ViewEvent[], id: string, name: string): Why {
  const node = get(world, '', 'nodes', '', name);
  const life = events.filter((e) => e.about.includes(id));
  if (!node) return why(id, `Node ${name} no longer exists.`, recent(life));
  const ready = objs(obj(node.status).conditions).find((c) => c.type === 'Ready');
  const health = life.filter((e) => isKind(e, 'nodelifecycle.unknown', 'kubelet.node.ready', 'kubelet.stop', 'kubelet.start', 'controller.stop')).slice(-3);
  const changes = life.filter((e) => detailOf(e)?.object === id && isKind(e, 'apiserver.write/patch', 'apiserver.write/update')).slice(-2);
  const s = str(ready?.status);
  const summary = s === 'True' ? 'Ready: its kubelet posts status and renews its Lease.' : s === 'Unknown' ? `NotReady: ${str(ready?.message) || 'its kubelet stopped posting status'}` : `NotReady${str(ready?.reason) !== '' ? ` (${str(ready?.reason)})` : ''}.`;
  return why(id, summary, [...health, ...changes]);
}

function namespaceWhy(world: World, events: readonly ViewEvent[], id: string, name: string): Why {
  const ns = get(world, '', 'namespaces', '', name);
  const life = lifeOf(events, id);
  const created = createdBy(life, id);
  if (!ns) return why(id, `Namespace ${name} no longer exists.`, [created, ...life.filter((e) => deletes(e, id) || isKind(e, 'namespace.finalized')).slice(-2)]);
  if (str(obj(ns.status).phase) === 'Terminating') {
    const del = latest(life, (e) => deletes(e, id));
    const remaining = latest(life, (e) => isKind(e, 'namespace.content-remaining'));
    const content = life.filter((e) => isKind(e, 'controller.write/delete') && e.link?.from === id).slice(-3);
    return why(id, `Terminating: the namespace controller deletes its content first${remaining ? `; ${remaining.text}` : ''}.`, [del, ...content, remaining]);
  }
  return why(id, 'Active.', [created, ...recent(life, 2)]);
}

/** The provider's `why`: undefined for an id that is not one of the k8s view's. */
export function k8sWhy(world: World, events: readonly ViewEvent[], entity: string): Why | undefined {
  const parts = entity.split('/');
  if (parts[0] !== 'k8s') return undefined;
  const [, kind, a, b] = parts as [string, string, string, string | undefined];
  if (kind === 'Namespace' && entity === namespaceId(a)) return namespaceWhy(world, events, entity, a);
  if (kind === 'Node' && entity === nodeId(a)) return nodeWhy(world, events, entity, a);
  if (b === undefined || entity !== objectId(kind, a, b)) return undefined;
  if (kind === 'Pod') return podWhy(world, events, entity, a, b);
  if (kind === 'Deployment') return deploymentWhy(world, events, entity, a, b);
  if (kind === 'ReplicaSet') return replicaSetWhy(world, events, entity, a, b);
  if (kind === 'Service') return serviceWhy(world, events, entity, a, b);
  return undefined;
}
