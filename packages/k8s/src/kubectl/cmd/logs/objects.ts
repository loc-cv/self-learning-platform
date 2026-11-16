// LogsForObject: from the object `kubectl logs` was given to the log requests it sends, one per
// Pod and container, with the messages it prints on the way (the default container annotation,
// "Defaulted container", "Found N pods"). A workload or Service is reduced to its Pods through its
// selector, and the first Pod in kubectl's logging order is used unless --all-pods.
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/logsforobject.go logsForObjectWithClient
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/helpers.go GetPodList (a watch
//             until a Pod appears, bounded by --pod-running-timeout), GetFirstPod, SelectorsForObject
//   upstream: staging/src/k8s.io/kubectl/pkg/util/podutils/podutils.go ByLogging, podReadyTime,
//             maxContainerRestarts, afterOrZero
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/podcmd/podcmd.go FindContainerByName,
//             AllContainerNames, DefaultContainerAnnotationName
// The requests are a Go map (map[corev1.ObjectReference]rest.ResponseWrapper) that kubectl ranges
// over: see `goMapOrder`.

import type { Op } from '@simlab/host';
import type { Random } from '@simlab/kernel';
import { goQuote } from '../../../apimachinery/field.ts';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { labelSelectorAsSelector, selectorFromSet, selectorString } from '../../../apimachinery/labels.ts';
import { parseTime } from '../../../apimachinery/time.ts';
import type { PodLogOptions } from '../../../apiserver/log.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { closeWatch, openProcessWatch, request, takeWatchEvents, type Session } from '../../client/session.ts';

/** One log request: the Pod and container (an ObjectReference with its field path) and the options. */
export interface LogRequest {
  namespace: string;
  pod: string;
  container: string;
  /** spec.containers{name}, spec.initContainers{name} or spec.ephemeralContainers{name}. */
  fieldPath: string;
  options: PodLogOptions;
}

/** What kubectl holds after Complete: a Pod, a PodList (from -l), or another object with its Go type. */
export type LogObject = { kind: 'Pod'; pod: JsonObject } | { kind: 'PodList'; items: JsonObject[] } | { kind: 'other'; object: JsonObject; goType: string };

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const arr = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const nameOf = (o: JsonObject): string => str(obj(o.metadata).name);

export const DEFAULT_CONTAINER_ANNOTATION = 'kubectl.kubernetes.io/default-container';

/** podcmd.AllContainerNames: containers, then ephemeral `(ephem)`, then init `(init)`. */
export function allContainerNames(pod: JsonObject): string {
  const spec = obj(pod.spec);
  return [
    ...arr(spec.containers).map((c) => str(c.name)),
    ...arr(spec.ephemeralContainers).map((c) => `${str(c.name)} (ephem)`),
    ...arr(spec.initContainers).map((c) => `${str(c.name)} (init)`),
  ].join(', ');
}

/** podcmd.FindContainerByName: the field path of the named container, or undefined. */
export function findContainerByName(pod: JsonObject, name: string): string | undefined {
  const spec = obj(pod.spec);
  if (arr(spec.containers).some((c) => str(c.name) === name)) return `spec.containers{${name}}`;
  if (arr(spec.initContainers).some((c) => str(c.name) === name)) return `spec.initContainers{${name}}`;
  if (arr(spec.ephemeralContainers).some((c) => str(c.name) === name)) return `spec.ephemeralContainers{${name}}`;
  return undefined;
}

// ---- ByLogging ----

const micros = (t: Json | undefined): number => {
  const r = typeof t === 'string' ? parseTime(t, false) : undefined;
  return r && 'micros' in r ? r.micros : 0;
};
/** A zero metav1.Time is "0001-01-01T00:00:00Z": absent here. */
const isZero = (t: Json | undefined): boolean => typeof t !== 'string' || t === '';

function readyCondition(pod: JsonObject): JsonObject | undefined {
  return arr(obj(pod.status).conditions).find((c) => str(c.type) === 'Ready');
}
const isReady = (pod: JsonObject): boolean => str(readyCondition(pod)?.status) === 'True';
/** podReadyTime: the Ready condition's transition time when it is True. */
function readyTime(pod: JsonObject): Json | undefined {
  const c = arr(obj(pod.status).conditions).find((x) => str(x.type) === 'Ready' && str(x.status) === 'True');
  return c?.lastTransitionTime;
}
/** afterOrZero(t1, t2): t1 after t2, a zero time counting as after any other. */
function afterOrZero(t1: Json | undefined, t2: Json | undefined): boolean {
  if (isZero(t1) || isZero(t2)) return isZero(t1);
  return micros(t1) > micros(t2);
}
const eqTime = (a: Json | undefined, b: Json | undefined): boolean => (isZero(a) && isZero(b)) || (!isZero(a) && !isZero(b) && micros(a) === micros(b));

function maxRestarts(pod: JsonObject): [number, number] {
  const st = obj(pod.status);
  let regular = 0;
  for (const c of arr(st.containerStatuses)) regular = Math.max(regular, Number(c.restartCount ?? 0));
  const sidecars = new Set(arr(obj(pod.spec).initContainers).filter((c) => c.restartPolicy === 'Always').map((c) => str(c.name)));
  let sidecar = 0;
  for (const c of arr(st.initContainerStatuses)) if (sidecars.has(str(c.name))) sidecar = Math.max(sidecar, Number(c.restartCount ?? 0));
  return [regular, sidecar];
}

/** ByLogging's Less. Phases missing from its map (Succeeded, Failed) rank with Running, as Go's zero value. */
export function byLoggingLess(a: JsonObject, b: JsonObject): boolean {
  const na = str(obj(a.spec).nodeName);
  const nb = str(obj(b.spec).nodeName);
  if (na !== nb && (na === '' || nb === '')) return na !== '';
  const rank: Record<string, number> = { Running: 0, Unknown: 1, Pending: 2 };
  const pa = rank[str(obj(a.status).phase)] ?? 0;
  const pb = rank[str(obj(b.status).phase)] ?? 0;
  if (pa !== pb) return pa < pb;
  if (isReady(a) !== isReady(b)) return isReady(a);
  if (isReady(a) && isReady(b) && !eqTime(readyTime(a), readyTime(b))) return afterOrZero(readyTime(b), readyTime(a));
  const [ra, sa] = maxRestarts(a);
  const [rb, sb] = maxRestarts(b);
  if (ra !== rb) return ra > rb;
  if (sa !== sb) return sa > sb;
  const ca = obj(a.metadata).creationTimestamp;
  const cb = obj(b.metadata).creationTimestamp;
  if (!eqTime(ca, cb)) return afterOrZero(cb, ca);
  return false;
}

/**
 * sort.Sort(ByLogging): Go's pdqsort is an insertion sort below 13 elements, which keeps equal
 * Pods in list order (by name); a stable sort is the same there.
 */
export function sortByLogging(pods: JsonObject[]): JsonObject[] {
  const out = [...pods];
  for (let i = 1; i < out.length; i++) {
    for (let j = i; j > 0 && byLoggingLess(out[j] as JsonObject, out[j - 1] as JsonObject); j--) {
      const t = out[j] as JsonObject;
      out[j] = out[j - 1] as JsonObject;
      out[j - 1] = t;
    }
  }
  return out;
}

// ---- the requests' map ----

/**
 * The order `for k, v := range m` visits a map built by inserting `entries` in order. kubectl
 * v1.37.2 is built with Go 1.26, whose maps are Swiss tables: a map of up to 8 entries is one
 * group, entries take slots 0, 1, … in insertion order, and each range starts at a random slot
 * of the 8 and wraps around (internal/runtime/maps/table.go Iter.Init: entryOffset = rand();
 * Iter.Next: slot (entryIdx + entryOffset) % 8). Larger maps are a full table whose order depends
 * on the hashes: a random permutation stands in for it.
 */
export function goMapOrder<T>(entries: readonly T[], rnd: Random): T[] {
  if (entries.length <= 1) return [...entries];
  if (entries.length > 8) return rnd.shuffle(entries);
  const offset = rnd.int(8);
  const out: T[] = [];
  for (let i = 0; i < 8; i++) {
    const slot = (i + offset) % 8;
    if (slot < entries.length) out.push(entries[slot] as T);
  }
  return out;
}

// ---- LogsForObject ----

export interface ForObject {
  s: Session;
  options: PodLogOptions;
  /** --pod-running-timeout, ms. */
  timeout: number;
  allContainers: boolean;
  allPods: boolean;
}

/** SelectorsForObject: the namespace and selector string of a workload or Service, or the error. */
function selectorsForObject(o: LogObject & { kind: 'other' }): { namespace: string; selector: string } | { error: string } {
  const t = o.object;
  const kind = str(t.kind);
  const apiVersion = str(t.apiVersion);
  const ns = str(obj(t.metadata).namespace);
  const spec = obj(t.spec);
  const workloads: Record<string, string[]> = {
    ReplicaSet: ['apps/v1'],
    StatefulSet: ['apps/v1'],
    DaemonSet: ['apps/v1'],
    Deployment: ['apps/v1'],
    Job: ['batch/v1'],
  };
  if (workloads[kind]?.includes(apiVersion)) {
    const sel = labelSelectorAsSelector(spec.selector);
    if ('error' in sel) return { error: `invalid label selector: ${sel.error}` };
    return { namespace: ns, selector: selectorString(sel) };
  }
  if (apiVersion === 'v1' && kind === 'ReplicationController') {
    return { namespace: ns, selector: selectorString(selectorFromSet(obj(spec.selector) as Record<string, string>)) };
  }
  if (apiVersion === 'v1' && kind === 'Service') {
    const set = obj(spec.selector);
    if (Object.keys(set).length === 0) return { error: `invalid service '${nameOf(t)}': Service is defined without a selector` };
    return { namespace: ns, selector: selectorString(selectorFromSet(set as Record<string, string>)) };
  }
  return { error: `selector for ${o.goType} not implemented` };
}

/**
 * GetPodList: the Pods matching the selector in logging order; with none, a watch from the list's
 * resourceVersion until a Pod is added or modified, for at most the timeout.
 */
function* getPodList(f: ForObject, namespace: string, selector: string): Op<JsonObject[] | KubectlError> {
  const p = f.s.p;
  const options = selector === '' ? {} : { labelSelector: selector };
  const r = yield* request(f.s, { verb: 'list', group: '', version: 'v1', resource: 'pods', namespace, options });
  if (!r.ok) return 'notSimulated' in r ? { type: 'notSimulated', what: r.notSimulated } : { type: 'status', status: r.status };
  const list = r.object as JsonObject;
  const items = arr(list.items);
  if (items.length > 0) return sortByLogging(items);
  const w = openProcessWatch(f.s, { verb: 'watch', group: '', version: 'v1', resource: 'pods', namespace, options: { ...options, resourceVersion: str(obj(list.metadata).resourceVersion) } });
  if ('notSimulated' in w) return { type: 'notSimulated', what: w.notSimulated };
  if ('status' in w) return { type: 'status', status: w.status };
  const deadline = p.now + f.timeout;
  try {
    for (;;) {
      for (const e of takeWatchEvents(f.s, w.id)) {
        if (e.type === 'ADDED' || e.type === 'MODIFIED') return [e.object];
      }
      if (p.now >= deadline) return messageError('timed out waiting for the condition');
      yield* p.wait(w.topic, deadline - p.now);
    }
  } finally {
    closeWatch(f.s, w.id);
  }
}

/** logsForObjectWithClient for one Pod. */
function* forPod(f: ForObject, pod: JsonObject, options: PodLogOptions, allContainers: boolean, allPods: boolean): Op<LogRequest[] | KubectlError> {
  const p = f.s.p;
  const name = nameOf(pod);
  const namespace = str(obj(pod.metadata).namespace);
  const spec = obj(pod.spec);
  if (allContainers) {
    const out: LogRequest[] = [];
    for (const key of ['initContainers', 'containers', 'ephemeralContainers']) {
      for (const c of arr(spec[key])) {
        const r = yield* forPod(f, pod, { ...options, container: str(c.name) }, false, false);
        if (!Array.isArray(r)) return r;
        out.push(...r);
      }
    }
    return out;
  }
  const opts: PodLogOptions = { ...options };
  const annotations = obj(obj(pod.metadata).annotations);
  if ((opts.container ?? '') === '') {
    const def = str(annotations[DEFAULT_CONTAINER_ANNOTATION]);
    if (def !== '') {
      if (findContainerByName(pod, def) === undefined) yield* p.write(2, `Default container name ${goQuote(def)} not found in pod ${name}\n`);
      else opts.container = def;
    }
  }
  if ((opts.container ?? '') === '') {
    // Default to the first container (as kubectl exec does).
    const first = str((arr(spec.containers)[0] ?? {}).name);
    opts.container = first;
    if (arr(spec.containers).length > 1 || arr(spec.initContainers).length > 0 || arr(spec.ephemeralContainers).length > 0) {
      if (!allPods) yield* p.write(2, `Defaulted container ${goQuote(first)} out of: ${allContainerNames(pod)}\n`);
    }
  }
  const container = opts.container as string;
  const fieldPath = findContainerByName(pod, container);
  if (fieldPath === undefined) return messageError(`container ${container} is not valid for pod ${name} out of: ${allContainerNames(pod)}`);
  return [{ namespace, pod: name, container, fieldPath, options: opts }];
}

/** LogsForObjectFn / AllPodLogsForObjectFn: the requests in insertion order (goMapOrder orders them). */
export function* logsForObject(f: ForObject, o: LogObject, options: PodLogOptions = f.options, allContainers = f.allContainers, allPods = f.allPods): Op<LogRequest[] | KubectlError> {
  if (o.kind === 'PodList') {
    const out: LogRequest[] = [];
    for (const pod of o.items) {
      const r = yield* forPod(f, pod, options, allContainers, allPods);
      if (!Array.isArray(r)) return r;
      out.push(...r);
    }
    return out;
  }
  if (o.kind === 'Pod') return yield* forPod(f, o.pod, options, allContainers, allPods);
  const sel = selectorsForObject(o);
  if ('error' in sel) return messageError(`cannot get the logs from ${o.goType}: ${sel.error}`);
  const pods = yield* getPodList(f, sel.namespace, sel.selector);
  if (!Array.isArray(pods)) return pods;
  const first = pods[0] as JsonObject;
  let target: LogObject = { kind: 'Pod', pod: first };
  if (pods.length > 1) {
    if (allPods) {
      // GetPodList again: the same list, sorted.
      const again = yield* getPodList(f, sel.namespace, sel.selector);
      if (!Array.isArray(again)) return again;
      target = { kind: 'PodList', items: again };
    } else yield* f.s.p.write(2, `Found ${pods.length} pods, using pod/${nameOf(first)}\n`);
  }
  return yield* logsForObject(f, target, options, allContainers, allPods);
}
