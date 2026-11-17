// The kubelet's pod workers: one SyncPod at a time per Pod, suspended while a CRI call takes
// time (RunPodSandbox, PullImage, CreateContainer, StartContainer, StopContainer).
//
// upstream (v1.37.2):
// - pkg/kubelet/kubelet.go SyncPod (status first, then the runtime's SyncPod, then the reason
//   cache), SyncTerminatingPod, SyncTerminatedPod; pod_workers.go completeWork (requeue after
//   success, after an error 10 s · Jitter 0.5, until a back-off expires, at once with a pending
//   update) and the pending update of an event that arrives while the worker is busy.
// - pkg/kubelet/kuberuntime/kuberuntime_manager.go computePodActions, SyncPod (sandbox before any
//   pull, containers in spec order, a failed container does not stop the next), doBackOff;
//   kuberuntime_container.go startContainer (EnsureImageExists, CreateContainer → Created,
//   StartContainer → Started, `Error: <reason>` on failure), killContainer (Killing, the grace
//   period floored at 2 s).
// - pkg/kubelet/images/image_manager.go EnsureImageExists (pull policies, the per-image back-off,
//   the event texts) and puller.go (the serial puller).
// - pkg/kubelet/status/status_manager.go (writes, TerminatePod, canBeDeleted → DELETE with grace
//   0 and a UID precondition).
// Modeled, not ported: the success resync every minute is not scheduled (it changes nothing);
// status writes are a read and an update of /status rather than a strategic merge patch, with the
// same result; containers of a Pod are killed in spec order (upstream in parallel goroutines).

import type { Millis } from '@simlab/kernel';
import { hashString } from '@simlab/kernel';
import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { timeOf } from '../apimachinery/time.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { recordEvent, type RecorderRef } from '../controllers/record.ts';
import type { SyncCtx, SyncResult } from '../controllers/types.ts';
import { capturedById, pullOutcome, storedImage } from '../runtime/images/catalog.ts';
import { imageView } from '../runtime/images/files.ts';
import { goQuote, parseImageName, type ImageName } from '../runtime/images/reference.ts';
import { containerLogPath, removePodLogs } from '../runtime/logs.ts';
import {
  addImage,
  containersOf,
  createContainer,
  failStart,
  findLocalImage,
  getContainer,
  removeContainer,
  removePodSandbox,
  runPodSandbox,
  runtimeOf,
  sandboxesOf,
  startProcess,
  stopContainer,
  stopPodSandbox,
} from '../runtime/runtime.ts';
import type { RuntimeContainer, RuntimeImage } from '../runtime/types.ts';
import { CRASHLOOP_BACKOFF, IMAGE_BACKOFF, current, gc, goDuration, inBackoffSince, inBackoffSinceUpdate, next } from './backoff.ts';
import { containerProcess } from './env.ts';
import { draw, jitter, transferTime } from './latency.ts';
import { generatePodStatus, instances, isHostNetwork, sandboxChange, shouldContainerBeRestarted, specContainers, statusEqual, terminatedStatus, type PodRuntimeView } from './status.ts';
import type { KubeletData, PodOp, PodWorker, PullRequest, PullResult, SyncPodRun } from './types.ts';
import { describeTransitions, podData, statusTransitions } from './trace.ts';

export const PULL_KEY = '@puller';

/** pod_workers.go: backOffPeriod 10 s and its jitter factor 0.5; resyncInterval (syncFrequency) 1 m. */
const ERROR_REQUEUE_MS = 10_000;
const RESYNC_MS = 60_000;
const JITTER = 0.5;
/** kuberuntime_manager.go minimumGracePeriodInSeconds. */
const MIN_STOP_GRACE_MS = 2000;
/** Container garbage collection runs every minute (kubelet.go ContainerGCPeriod). */
const CONTAINER_GC_MS = 60_000;

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const meta = (o: ApiObject): JsonObject => obj(o.metadata as Json);

export function kdata(c: SyncCtx): KubeletData {
  return c.data() as unknown as KubeletData;
}

function setWorker(c: SyncCtx, w: PodWorker | undefined, uid: string): void {
  const pods = { ...kdata(c).pods };
  if (w) pods[uid] = w;
  else delete pods[uid];
  c.setData('pods', pods as unknown as Json);
}

function set<K extends keyof KubeletData>(c: SyncCtx, k: K, v: KubeletData[K]): void {
  c.setData(k, v as unknown as Json);
}

/** format.Pod: `name_namespace(uid)`. */
const podDesc = (pod: ApiObject): string => `${str(meta(pod).name)}_${str(meta(pod).namespace)}(${str(meta(pod).uid)})`;

function recorder(c: SyncCtx): RecorderRef {
  const d = kdata(c);
  return { recorder: `${d.node}/kubelet`, component: 'kubelet', host: d.node, client: c.client, cause: c.syncId };
}

/** kubecontainer.GenerateContainerRef: the Pod with the container's field path. */
function containerRef(pod: ApiObject, container: string): JsonObject {
  const m = meta(pod);
  return { kind: 'Pod', namespace: str(m.namespace), name: str(m.name), uid: str(m.uid), apiVersion: 'v1', resourceVersion: str(m.resourceVersion), fieldPath: `spec.containers{${container}}` };
}

function containerEvent(c: SyncCtx, pod: ApiObject, container: string, type: 'Normal' | 'Warning', reason: string, message: string): void {
  recordEvent(c.ctx, recorder(c), pod, type, reason, message, containerRef(pod, container));
}

function podEvent(c: SyncCtx, pod: ApiObject, type: 'Normal' | 'Warning', reason: string, message: string): void {
  recordEvent(c.ctx, recorder(c), pod, type, reason, message);
}

function view(c: SyncCtx, uid: string): PodRuntimeView {
  const node = kdata(c).node;
  return { sandboxes: sandboxesOf(c.ctx, node, uid).reverse(), containers: containersOf(c.ctx, node, uid) };
}

/** Writes the status when it changed; returns the Pod as stored afterwards. */
function writeStatus(c: SyncCtx, pod: ApiObject, status: JsonObject): ApiObject {
  if (statusEqual(obj(pod.status as Json), status)) return pod;
  const r = c.client.resource('v1/pods').updateStatus(str(meta(pod).namespace), { ...pod, status } as JsonObject);
  if (!r.ok) return pod;
  const stored = r.object as ApiObject;
  // `kubelet.status`: what the write made visible (phase, Ready, IP, container states).
  const t = statusTransitions(obj(pod.status as Json), obj(stored.status as Json));
  if (t) c.trace('kubelet.status', `${podDesc(pod)}: ${describeTransitions(t)}`, { ...podData(pod, kdata(c).node), ...t }, podDesc(pod));
  return stored;
}

function status(c: SyncCtx, pod: ApiObject, podIsTerminal = false): JsonObject {
  const d = kdata(c);
  const uid = str(meta(pod).uid);
  return generatePodStatus({ pod, view: view(c, uid), reasons: d.reasons[uid] ?? {}, hostIP: d.nodeIP, now: c.now, podIsTerminal });
}

/** The container's spec hash: a changed spec restarts the container (kuberuntime_manager.go containerChanged). */
function specHash(spec: JsonObject): string {
  return hashString(JSON.stringify(spec));
}

/** The Pod as the API has it, if it is the one with this UID. */
function livePod(c: SyncCtx, namespace: string, name: string, uid: string): ApiObject | undefined {
  const p = c.get('v1/pods', namespace, name);
  return p && str(meta(p).uid) === uid ? p : undefined;
}

// ---- the entry point ----

export function syncPodKey(c: SyncCtx, key: string): SyncResult {
  const [namespace, name, uid] = key.split('/') as [string, string, string];
  const pod = livePod(c, namespace, name, uid);
  const w: PodWorker = { ...(kdata(c).pods[uid] ?? { uid, namespace, name }) };
  if (w.op) {
    const blocked = opBlocked(c, w.op);
    if (blocked) {
      setWorker(c, { ...w, pending: true }, uid);
      return blocked;
    }
    // World data is frozen: the suspended SyncPod continues on a copy.
    const op = JSON.parse(JSON.stringify(w.op)) as PodOp;
    const rest: PodWorker = { ...w };
    delete rest.op;
    setWorker(c, rest, uid);
    return resume(c, rest, pod, op);
  }
  delete w.pending;
  if (!pod) return removed(c, w);
  if (specContainers(pod).length === 0) return { done: true };
  if (Array.isArray(obj(pod.spec as Json).initContainers) && (obj(pod.spec as Json).initContainers as Json[]).length > 0) {
    c.ctx.gap({ kind: 'behavior', program: 'kubelet', what: 'init containers', commandLine: '', machine: kdata(c).node });
    c.trace('kubelet.gap', `${podDesc(pod)} has init containers, which the simulated kubelet does not run yet; it stays Pending`, { ...podData(pod, kdata(c).node), what: 'init containers' }, key);
    return { done: true };
  }
  if (meta(pod).deletionTimestamp) return terminate(c, w, pod);
  if (w.done) return { done: true };
  return beginSync(c, w, pod);
}

/** Whether the suspended call has returned; if not, when to look again. */
function opBlocked(c: SyncCtx, op: PodOp): SyncResult | undefined {
  switch (op.kind) {
    case 'sandbox':
    case 'create':
    case 'start':
    case 'stopSandbox':
      return c.now < op.until ? { requeueAfter: op.until - c.now } : undefined;
    case 'pull':
      return kdata(c).pulls.done[op.pull] ? undefined : { done: true };
    case 'kill': {
      const node = kdata(c).node;
      const waiting = op.containers.filter((id) => getContainer(c.ctx, node, id)?.state === 'running');
      return waiting.length > 0 ? { done: true } : undefined;
    }
  }
}

function resume(c: SyncCtx, w: PodWorker, pod: ApiObject | undefined, op: PodOp): SyncResult {
  const d = kdata(c);
  switch (op.kind) {
    case 'sandbox': {
      if (!pod) return removed(c, w);
      const spec = obj(pod.spec as Json);
      const hostname = isHostNetwork(pod) ? d.node : str(spec.hostname) || str(meta(pod).name);
      runPodSandbox(c.ctx, d.node, { podUID: w.uid, namespace: w.namespace, name: w.name, hostNetwork: isHostNetwork(pod), nodeIP: d.nodeIP, podCIDR: d.podCIDR, hostname }, c.syncId);
      return continueSync(c, w, pod, op.run);
    }
    case 'pull':
      return pullReturned(c, w, pod, op);
    case 'create': {
      if (!pod) return removed(c, w);
      const spec = specContainers(pod).find((x) => x.name === op.container) as JsonObject;
      const sb = view(c, w.uid).sandboxes[0];
      if (!sb) return continueSync(c, w, pod, op.run);
      const prev = instances(view(c, w.uid), op.container)[0];
      const attempt = prev ? prev.attempt + 1 : 0;
      const stored = Object.values(runtimeImages(c)).find((i) => i.id === op.imageId);
      if (!stored) return continueSync(c, w, pod, op.run);
      // The kubelet keeps one dead container per name; older ones go with their logs.
      for (const old of instances(view(c, w.uid), op.container).slice(1)) if (old.state === 'exited') removeContainer(c.ctx, d.node, old.id);
      const created = createContainer(c.ctx, d.node, {
        sandbox: sb,
        name: op.container,
        attempt,
        imageRef: op.imageRef,
        image: stored,
        imageName: op.imageName,
        imageDigest: op.imageDigest,
        hash: specHash(spec),
        logPath: containerLogPath(w.namespace, w.name, w.uid, op.container, attempt),
      }, c.syncId);
      containerEvent(c, pod, op.container, 'Normal', 'Created', 'Container created');
      setWorker(c, { ...w, op: { kind: 'start', container: op.container, until: c.now + draw(c.ctx, 'containerStart'), run: op.run, containerId: created.id } }, w.uid);
      return { requeueAfter: (kdata(c).pods[w.uid]?.op as { until: Millis }).until - c.now };
    }
    case 'start': {
      if (!pod) return removed(c, w);
      startProcessFor(c, w, pod, op.container, op.containerId, op.run);
      return continueSync(c, w, pod, op.run);
    }
    case 'kill':
      if (op.then === 'restart' && pod) return continueSync(c, w, pod, op.run ?? newRun());
      return stopSandboxes(c, w, op.then === 'remove' || !pod ? 'remove' : 'terminate');
    case 'stopSandbox': {
      for (const sb of sandboxesOf(c.ctx, d.node, w.uid)) stopPodSandbox(c.ctx, d.node, sb.id, c.syncId);
      if (op.then === 'remove' || !pod) return removed(c, w);
      return finishTermination(c, w, pod);
    }
  }
}

function runtimeImages(c: SyncCtx): Record<string, RuntimeImage> {
  return runtimeOf(c.ctx, kdata(c).node).images;
}

const newRun = (): SyncPodRun => ({ attempted: [], results: [], error: false });

// ---- SyncPod ----

function beginSync(c: SyncCtx, w: PodWorker, pod0: ApiObject): SyncResult {
  const s = status(c, pod0);
  const pod = writeStatus(c, pod0, s);
  if (s.phase === 'Succeeded' || s.phase === 'Failed') {
    // A terminal phase: the pod worker terminates the Pod (nothing restarts any more).
    c.trace('kubelet.pod.terminal', `${podDesc(pod)} reached phase ${String(s.phase)}`, { ...podData(pod, kdata(c).node), phase: String(s.phase) }, podDesc(pod));
    return killAll(c, w, pod, 'terminate', MIN_STOP_GRACE_MS);
  }
  return continueSync(c, w, pod, newRun());
}

/** computePodActions and the rest of SyncPod, from where the last suspension left it. */
function continueSync(c: SyncCtx, w: PodWorker, pod: ApiObject, run: SyncPodRun): SyncResult {
  const d = kdata(c);
  const v = view(c, w.uid);
  const sb = sandboxChange(pod, v.sandboxes);
  if (sb.needed && run.attempted.length === 0) {
    const hadContainers = v.containers.length > 0;
    const policy = str(obj(pod.spec as Json).restartPolicy) || 'Always';
    if (sb.previous && policy !== 'Always' && hadContainers) {
      // Never/OnFailure with containers that ran: no new sandbox (computePodActions).
      return finishSync(c, w, pod, run);
    }
    if (sb.previous) {
      podEvent(c, pod, 'Normal', 'SandboxChanged', 'Pod sandbox changed, it will be killed and re-created.');
      const running = v.containers.filter((x) => x.state === 'running');
      if (running.length > 0) return killAll(c, w, pod, 'restart', MIN_STOP_GRACE_MS, run);
    }
    const until = c.now + draw(c.ctx, isHostNetwork(pod) ? 'sandboxHostNetwork' : 'sandbox');
    c.trace('kubelet.sandbox', `${podDesc(pod)}: creating the pod sandbox (${sb.message})`, { ...podData(pod, d.node), reason: sb.message, ...(sb.previous ? { previous: sb.previous.id } : {}), ready: until }, podDesc(pod));
    setWorker(c, { ...w, op: { kind: 'sandbox', until, run, ...(sb.previous ? { previous: sb.previous.id } : {}) } }, w.uid);
    return { requeueAfter: until - c.now };
  }
  for (const spec of specContainers(pod)) {
    const name = str(spec.name);
    if (run.attempted.includes(name)) continue;
    const [newest] = instances(view(c, w.uid), name);
    if (newest && newest.state === 'running') {
      if (newest.hash !== specHash(spec)) {
        run.attempted.push(name);
        containerEvent(c, pod, name, 'Normal', 'Killing', `Container ${name} definition changed, will be restarted`);
        const grace = Math.max(MIN_STOP_GRACE_MS, gracePeriodMs(pod));
        const kill = c.trace('kubelet.kill', `${podDesc(pod)}: killing ${name}, its definition changed`, { ...podData(pod, d.node), containers: [name], grace, then: 'restart', why: 'definition changed' }, podDesc(pod));
        stopContainer(c.ctx, d.node, newest.id, grace, capturedById(newest.imageId)?.config.stopSignal, kill);
        setWorker(c, { ...w, op: { kind: 'kill', containers: [newest.id], then: 'restart', run: { ...run, attempted: run.attempted.filter((x) => x !== name) } } }, w.uid);
        return { done: true };
      }
      continue;
    }
    if (!shouldContainerBeRestarted(pod, newest)) continue;
    run.attempted.push(name);
    const r = startContainerFlow(c, w, pod, spec, newest, run);
    if (r) return r;
  }
  return finishSync(c, w, pod, run);
}

/** doBackOff, then EnsureImageExists; returns a suspension, or undefined to go on with the next container. */
function startContainerFlow(c: SyncCtx, w: PodWorker, pod: ApiObject, spec: JsonObject, newest: RuntimeContainer | undefined, run: SyncPodRun): SyncResult | undefined {
  const d = kdata(c);
  const name = str(spec.name);
  const image = str(spec.image);
  // doBackOff: the newest container exited; is it still in its back-off?
  if (newest && newest.state === 'exited') {
    const key = backoffKey(pod, spec);
    const ts = newest.finishedAt ?? c.now;
    if (inBackoffSince(d.crashBackoff, key, ts, c.now, CRASHLOOP_BACKOFF)) {
      const cur = current(d.crashBackoff, key);
      containerEvent(c, pod, name, 'Warning', 'BackOff', `Back-off restarting failed container ${name} in pod ${podDesc(pod)}`);
      run.results.push({ container: name, err: 'CrashLoopBackOff', message: `back-off ${goDuration(cur)} restarting failed container=${name} pod=${podDesc(pod)}` });
      run.error = true;
      const at = ts + cur;
      run.backoffAt = run.backoffAt === undefined ? at : Math.min(run.backoffAt, at);
      return undefined;
    }
    set(c, 'crashBackoff', next(kdata(c).crashBackoff, key, ts, c.now, CRASHLOOP_BACKOFF));
    // The exited container is restarted now: its back-off, if it had one, is over.
    c.trace('kubelet.container.restart', `${podDesc(pod)}: restarting ${name}, which exited with ${String(newest.exitCode ?? 0)}`, { ...podData(pod, d.node), container: name, containerId: newest.id, exitCode: newest.exitCode ?? 0, restartCount: newest.attempt + 1 }, podDesc(pod));
  }
  // EnsureImageExists
  const parsed = parseImageName(image);
  if ('error' in parsed) {
    const msg = `Failed to apply default image tag ${goQuote(image)}: ${parsed.error}`;
    containerEvent(c, pod, name, 'Warning', 'InspectFailed', msg);
    containerEvent(c, pod, name, 'Warning', 'Failed', 'Error: InvalidImageName');
    run.results.push({ container: name, err: 'InvalidImageName', message: msg });
    run.error = true;
    return undefined;
  }
  const ref = applyDefaultTag(image, parsed);
  const policy = str(spec.imagePullPolicy) || 'IfNotPresent';
  const local = findLocalImage(c.ctx, d.node, parsed);
  if (policy !== 'Always' && local) {
    containerEvent(c, pod, name, 'Normal', 'Pulled', `Container image ${goQuote(image)} already present on machine and can be accessed by the pod`);
    return toCreate(c, w, name, run, local.id, ref, local.repoTags[0] ?? local.repoDigests[0] ?? local.id, local.repoDigests[0] ?? local.id);
  }
  if (policy === 'Never') {
    const msg = `Container image ${goQuote(image)} is not present with pull policy of Never`;
    containerEvent(c, pod, name, 'Warning', 'ErrImageNeverPull', msg);
    containerEvent(c, pod, name, 'Warning', 'Failed', 'Error: ErrImageNeverPull');
    run.results.push({ container: name, err: 'ErrImageNeverPull', message: msg });
    run.error = true;
    return undefined;
  }
  const bkey = `${w.uid}_${image}`;
  if (inBackoffSinceUpdate(d.imageBackoff, bkey, c.now, IMAGE_BACKOFF)) {
    containerEvent(c, pod, name, 'Normal', 'BackOff', `Back-off pulling image ${goQuote(image)}`);
    containerEvent(c, pod, name, 'Warning', 'Failed', 'Error: ImagePullBackOff');
    const prev = d.pullErrors[bkey];
    run.results.push({ container: name, err: 'ImagePullBackOff', message: `Back-off pulling image ${goQuote(image)}${prev ? `: ${prev}` : ''}` });
    run.error = true;
    return undefined;
  }
  containerEvent(c, pod, name, 'Normal', 'Pulling', `Pulling image ${goQuote(image)}`);
  const id = `pull-${d.nextId}`;
  set(c, 'nextId', d.nextId + 1);
  requestPull(c, { id, key: `${w.namespace}/${w.name}/${w.uid}`, image, ref, requestedAt: c.now });
  setWorker(c, { ...w, op: { kind: 'pull', container: name, pull: id, startedAt: c.now, run } }, w.uid);
  return { done: true };
}

/** applyDefaultImageTag: `:latest` appended to the string as written, without qualifying it. */
function applyDefaultTag(image: string, n: ImageName): string {
  if (n.digest === undefined && n.tag !== undefined && !image.endsWith(`:${n.tag}`)) return `${image}:${n.tag}`;
  return image;
}

/** GetBackoffKey: FNV-64a of name, namespace, uid, container, image and resources (here a hash of the same). */
function backoffKey(pod: ApiObject, spec: JsonObject): string {
  const m = meta(pod);
  return hashString([str(m.name), str(m.namespace), str(m.uid), str(spec.name), str(spec.image), JSON.stringify(spec.resources ?? {})].join('/'));
}

function toCreate(c: SyncCtx, w: PodWorker, container: string, run: SyncPodRun, imageId: string, imageRef: string, imageName: string, imageDigest: string): SyncResult {
  const until = c.now + draw(c.ctx, 'containerCreate');
  setWorker(c, { ...w, op: { kind: 'create', container, until, run, imageId, imageRef, imageName, imageDigest } }, w.uid);
  return { requeueAfter: until - c.now };
}

function pullReturned(c: SyncCtx, w: PodWorker, pod: ApiObject | undefined, op: Extract<PodOp, { kind: 'pull' }>): SyncResult {
  const d = kdata(c);
  const result = d.pulls.done[op.pull] as PullResult;
  const done = { ...d.pulls.done };
  delete done[op.pull];
  set(c, 'pulls', { ...kdata(c).pulls, done });
  if (!pod) return removed(c, w);
  const spec = specContainers(pod).find((x) => x.name === op.container) as JsonObject;
  const image = str(spec.image);
  const bkey = `${w.uid}_${image}`;
  if (result.ok) {
    const total = c.now - op.startedAt;
    containerEvent(c, pod, op.container, 'Normal', 'Pulled', `Successfully pulled image ${goQuote(image)} in ${goDuration(result.pullMs)} (${goDuration(total)} including waiting). Image size: ${String(result.size)} bytes.`);
    set(c, 'imageBackoff', gc(kdata(c).imageBackoff, c.now, IMAGE_BACKOFF));
    const parsed = parseImageName(image) as ImageName;
    const local = findLocalImage(c.ctx, d.node, parsed);
    if (!local) return continueSync(c, w, pod, op.run);
    return toCreate(c, w, op.container, op.run, local.id, applyDefaultTag(image, parsed), local.repoTags[0] ?? local.repoDigests[0] ?? local.id, local.repoDigests[0] ?? local.id);
  }
  const err = result.error ?? `[sim] ${result.notSimulated ?? 'image not available'}`;
  containerEvent(c, pod, op.container, 'Warning', 'Failed', `Failed to pull image ${goQuote(image)}: ${err}`);
  containerEvent(c, pod, op.container, 'Warning', 'Failed', 'Error: ErrImagePull');
  set(c, 'imageBackoff', next(kdata(c).imageBackoff, bkey, c.now, c.now, IMAGE_BACKOFF));
  set(c, 'pullErrors', { ...kdata(c).pullErrors, [bkey]: `ErrImagePull: ${err}` });
  op.run.results.push({ container: op.container, err: 'ErrImagePull', message: err });
  op.run.error = true;
  return continueSync(c, w, pod, op.run);
}

/** StartContainer: the process starts, or runc's create-time lookup of the executable fails. */
function startProcessFor(c: SyncCtx, w: PodWorker, pod: ApiObject, name: string, id: string, run: SyncPodRun): void {
  const d = kdata(c);
  const ctr = getContainer(c.ctx, d.node, id);
  const spec = specContainers(pod).find((x) => x.name === name) as JsonObject;
  const img = ctr ? capturedById(ctr.imageId) : undefined;
  if (!ctr || !img) return;
  const sb = runtimeOf(c.ctx, d.node).sandboxes[ctr.sandboxId];
  const services = c.list('v1/services');
  const proc = containerProcess(pod, spec, img, services, sb?.hostname ?? w.name);
  for (const u of proc.unsupported) {
    c.ctx.gap({ kind: 'behavior', program: 'kubelet', what: u, commandLine: '', machine: d.node });
    c.trace('kubelet.gap', `${podDesc(pod)} container ${name}: ${u} is not simulated yet; the variable is left out`, { ...podData(pod, d.node), container: name, what: u }, podDesc(pod));
  }
  const v = imageView(ctr.imageId);
  const arg0 = proc.argv[0] ?? '';
  const exe = v.which(proc.env, arg0);
  if (!exe) {
    // runc libcontainer/standard_init_linux.go: exec.LookPath before waiting; Go's exec.Error and
    // fs.PathError texts; the chain of wrappers containerd and runc add (containerd-notes c.3).
    const inner = arg0.includes('/') ? `exec: ${goQuote(arg0)}: stat ${arg0}: no such file or directory` : `exec: ${goQuote(arg0)}: executable file not found in $PATH`;
    const msg = `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: ${inner}: unknown`;
    failStart(c.ctx, d.node, id, 128, 'StartError', msg, c.syncId);
    containerEvent(c, pod, name, 'Warning', 'Failed', `Error: ${msg}`);
    run.results.push({ container: name, err: 'RunContainerError', message: msg });
    run.error = true;
    return;
  }
  startProcess(c.ctx, d.node, id, exe, { argv: proc.argv, env: proc.env, which: (n) => v.which(proc.env, n), file: v.file }, c.syncId);
  containerEvent(c, pod, name, 'Normal', 'Started', 'Container started');
  run.results.push({ container: name });
}

/** End of SyncPod: the reason cache, then completeWork's requeue. */
function finishSync(c: SyncCtx, w: PodWorker, pod: ApiObject, run: SyncPodRun): SyncResult {
  const d = kdata(c);
  const reasons = { ...(d.reasons[w.uid] ?? {}) };
  for (const r of run.results) {
    if (r.err) reasons[r.container] = { err: r.err, message: r.message ?? '' };
    else delete reasons[r.container];
  }
  set(c, 'reasons', { ...d.reasons, [w.uid]: reasons });
  const cur = kdata(c).pods[w.uid] ?? w;
  const pending = cur.pending === true;
  const clean: PodWorker = { ...cur };
  delete clean.pending;
  delete clean.op;
  setWorker(c, clean, w.uid);
  let after: Millis | undefined;
  if (run.error) {
    if (run.backoffAt !== undefined) after = jitter(c.ctx, 'k8s.kubelet.jitter', Math.min(Math.max(run.backoffAt - c.now, 0), RESYNC_MS), JITTER);
    else after = jitter(c.ctx, 'k8s.kubelet.jitter', ERROR_REQUEUE_MS, JITTER);
  } else if (run.results.length > 0) {
    // PLEGOnDemandRelist: the Pod is relisted right after a sync that did something.
    after = 0;
  }
  if (pending) after = 0;
  traceBackoff(c, w, pod, run, after);
  c.trace('kubelet.sync.done', `SyncPod of ${podDesc(pod)} finished: ${run.results.map((r) => `${r.container} ${r.err ?? 'started'}`).join(', ') || 'nothing to do'}`, { ...podData(pod, d.node), results: run.results.map((r) => ({ ...r })) as unknown as Json, ...(after !== undefined ? { requeueAfter: after } : {}) }, podDesc(pod));
  return after === undefined ? { done: true } : { requeueAfter: after };
}

/**
 * `kubelet.backoff`, one per container this sync left in CrashLoopBackOff: the exit that caused it
 * (the container id and its exit code), the back-off and when it ends, and when the pod worker
 * syncs again (`retryAt`, the requeue completeWork chose), which is when the restart can happen.
 */
function traceBackoff(c: SyncCtx, w: PodWorker, pod: ApiObject, run: SyncPodRun, after: Millis | undefined): void {
  const d = kdata(c);
  for (const r of run.results) {
    if (r.err !== 'CrashLoopBackOff') continue;
    const spec = specContainers(pod).find((x) => x.name === r.container);
    const [newest] = instances(view(c, w.uid), r.container);
    if (!spec || !newest || newest.state !== 'exited') continue;
    const cur = current(d.crashBackoff, backoffKey(pod, spec));
    const since = newest.finishedAt ?? c.now;
    const endsAt = since + cur;
    const retryAt = c.now + (after ?? 0);
    c.trace(
      'kubelet.backoff',
      `${r.container} of ${podDesc(pod)} is in back-off ${goDuration(cur)} until ${timeOf(endsAt)}; the pod worker syncs again at ${timeOf(retryAt)}`,
      { ...podData(pod, d.node), container: r.container, containerId: newest.id, exitCode: newest.exitCode ?? 0, backoffMs: cur, since, endsAt, retryAt, restartCount: newest.attempt },
      podDesc(pod),
    );
  }
}

// ---- termination ----

function gracePeriodMs(pod: ApiObject): Millis {
  const m = meta(pod);
  const spec = obj(pod.spec as Json);
  const s = typeof m.deletionGracePeriodSeconds === 'number' ? m.deletionGracePeriodSeconds : typeof spec.terminationGracePeriodSeconds === 'number' ? spec.terminationGracePeriodSeconds : 30;
  return Math.max(1, s) * 1000;
}

/** SyncTerminatingPod: status, then kill every running container (Killing), then the sandbox. */
function terminate(c: SyncCtx, w: PodWorker, pod0: ApiObject): SyncResult {
  if (w.done) return deleteIfFinished(c, w, pod0);
  const pod = writeStatus(c, pod0, status(c, pod0));
  return killAll(c, w, pod, 'terminate', Math.max(MIN_STOP_GRACE_MS, gracePeriodMs(pod)));
}

function killAll(c: SyncCtx, w: PodWorker, pod: ApiObject, then: 'restart' | 'terminate' | 'remove', grace: Millis, run?: SyncPodRun): SyncResult {
  const d = kdata(c);
  const running = view(c, w.uid).containers.filter((x) => x.state === 'running');
  const kill = running.length === 0 ? undefined : c.trace('kubelet.kill', `${podDesc(pod)}: stopping ${running.map((x) => x.name).join(', ')} (${then})`, { ...podData(pod, d.node), containers: running.map((x) => x.name), grace, then, why: meta(pod).deletionTimestamp ? 'deleted' : then === 'restart' ? 'sandbox changed' : 'terminal phase' }, podDesc(pod));
  for (const ctr of running) {
    containerEvent(c, pod, ctr.name, 'Normal', 'Killing', `Stopping container ${ctr.name}`);
    stopContainer(c.ctx, d.node, ctr.id, grace, capturedById(ctr.imageId)?.config.stopSignal, kill);
  }
  const still = running.filter((x) => getContainer(c.ctx, d.node, x.id)?.state === 'running').map((x) => x.id);
  if (still.length === 0) {
    if (then === 'restart') return continueSync(c, w, pod, run ?? newRun());
    return stopSandboxes(c, w, then);
  }
  setWorker(c, { ...w, op: { kind: 'kill', containers: still, then, ...(run ? { run } : {}) } }, w.uid);
  return { done: true };
}

function stopSandboxes(c: SyncCtx, w: PodWorker, then: 'terminate' | 'remove'): SyncResult {
  const d = kdata(c);
  const ready = sandboxesOf(c.ctx, d.node, w.uid).filter((s) => s.state === 'ready');
  if (ready.length === 0) {
    const pod = livePod(c, w.namespace, w.name, w.uid);
    if (then === 'remove' || !pod) return removed(c, w);
    return finishTermination(c, w, pod);
  }
  const until = c.now + draw(c.ctx, 'sandboxStop');
  setWorker(c, { ...w, op: { kind: 'stopSandbox', until, then } }, w.uid);
  return { requeueAfter: until - c.now };
}

/** SyncTerminatedPod and TerminatePod: the terminal status, then the deletion if one was asked for. */
function finishTermination(c: SyncCtx, w: PodWorker, pod0: ApiObject): SyncResult {
  const final = terminatedStatus(status(c, pod0, true));
  const pod = writeStatus(c, pod0, final);
  setWorker(c, { ...w, done: true }, w.uid);
  c.trace('kubelet.pod.terminated', `${podDesc(pod)} terminated with phase ${String(final.phase)}`, { ...podData(pod, kdata(c).node), phase: String(final.phase) }, podDesc(pod));
  return deleteIfFinished(c, { ...w, done: true }, pod);
}

/** canBeDeleted: deletion requested and everything stopped → DELETE with grace 0 and the UID precondition. */
function deleteIfFinished(c: SyncCtx, w: PodWorker, pod: ApiObject): SyncResult {
  if (!meta(pod).deletionTimestamp) return { done: true };
  if (view(c, w.uid).containers.some((x) => x.state === 'running')) return terminate(c, { ...w, done: false }, pod);
  c.trace('kubelet.pod.delete', `${podDesc(pod)}: everything stopped, deleting the Pod from the API`, podData(pod, kdata(c).node), podDesc(pod));
  c.client.resource('v1/pods').delete(w.namespace, w.name, { gracePeriodSeconds: 0, preconditions: { uid: w.uid } });
  return { done: true };
}

/** The Pod is gone from the API: kill what still runs, then garbage-collect it at the next container GC. */
function removed(c: SyncCtx, w: PodWorker): SyncResult {
  const d = kdata(c);
  const v = view(c, w.uid);
  if (v.containers.some((x) => x.state === 'running')) {
    // HandlePodRemoves: killed with a one-second grace, floored at two for StopContainer.
    const running = v.containers.filter((x) => x.state === 'running');
    const kill = c.trace('kubelet.kill', `${w.name}_${w.namespace}(${w.uid}): the Pod is gone from the API, stopping ${running.map((x) => x.name).join(', ')}`, { namespace: w.namespace, name: w.name, uid: w.uid, node: d.node, containers: running.map((x) => x.name), grace: MIN_STOP_GRACE_MS, then: 'remove', why: 'removed' }, `${w.namespace}/${w.name}`);
    for (const ctr of running) stopContainer(c.ctx, d.node, ctr.id, MIN_STOP_GRACE_MS, capturedById(ctr.imageId)?.config.stopSignal, kill);
    const still = v.containers.filter((x) => getContainer(c.ctx, d.node, x.id)?.state === 'running').map((x) => x.id);
    if (still.length > 0) {
      setWorker(c, { ...w, op: { kind: 'kill', containers: still, then: 'remove' } }, w.uid);
      return { done: true };
    }
  }
  if (v.sandboxes.some((s) => s.state === 'ready')) return stopSandboxes(c, w, 'remove');
  if (v.containers.length === 0 && v.sandboxes.length === 0) {
    setWorker(c, undefined, w.uid);
    return { done: true };
  }
  const sinceStart = c.now - d.started;
  const nextGc = d.started + (Math.floor(sinceStart / CONTAINER_GC_MS) + 1) * CONTAINER_GC_MS;
  const gcAt = kdata(c).pods[w.uid]?.gcAt;
  if (gcAt === undefined || c.now < gcAt) {
    setWorker(c, { ...w, done: true, gcAt: gcAt ?? nextGc }, w.uid);
    if (gcAt !== undefined) return { requeueAfter: gcAt - c.now };
    return { requeueAfter: nextGc - c.now };
  }
  for (const ctr of v.containers) removeContainer(c.ctx, d.node, ctr.id);
  for (const sb of v.sandboxes) removePodSandbox(c.ctx, d.node, sb.id);
  removePodLogs(c.ctx, d.node, w.namespace, w.name, w.uid);
  const reasons = { ...kdata(c).reasons };
  delete reasons[w.uid];
  set(c, 'reasons', reasons);
  setWorker(c, undefined, w.uid);
  c.trace('kubelet.gc', `removed the containers, sandboxes and logs of deleted Pod ${w.namespace}/${w.name}`, { namespace: w.namespace, name: w.name, uid: w.uid, node: d.node }, `${w.namespace}/${w.name}`);
  return { done: true };
}

// ---- the serial image puller ----

/** The pull a record is about: the Pod (from the request's key) and the image. */
function pullData(node: string, req: PullRequest): JsonObject {
  const [namespace, name, uid] = req.key.split('/') as [string, string, string];
  return { namespace, name, uid, node, image: req.image, ref: req.ref, pull: req.id };
}

function requestPull(c: SyncCtx, req: PullRequest): void {
  const p = kdata(c).pulls;
  set(c, 'pulls', { ...p, queue: [...p.queue, req] });
  if (!kdata(c).pulls.current) startNextPull(c);
}

function startNextPull(c: SyncCtx): void {
  const p = kdata(c).pulls;
  const [req, ...queue] = p.queue;
  if (!req) {
    const rest = { ...p };
    delete rest.current;
    set(c, 'pulls', rest);
    return;
  }
  const parsed = parseImageName(req.image) as ImageName;
  const outcome = pullOutcome(parsed);
  let ms: Millis;
  let result: PullResult;
  if ('ok' in outcome) {
    const stored = storedImage(outcome.ok, parsed);
    // Content already in the store (an earlier pull of the same image) is not downloaded again.
    const have = runtimeOf(c.ctx, kdata(c).node).images[stored.id] !== undefined;
    ms = draw(c.ctx, 'registryResolve') + (have ? 0 : transferTime(c.ctx, stored.size));
    result = { ok: true, pullMs: ms, size: stored.size, imageId: stored.id };
  } else if ('notSimulated' in outcome) {
    ms = draw(c.ctx, 'registryResolve');
    result = { ok: false, pullMs: ms, notSimulated: outcome.notSimulated };
    c.ctx.gap({ kind: 'behavior', program: 'containerd', what: `pulling ${req.ref}`, commandLine: '', machine: kdata(c).node });
  } else {
    ms = outcome.kind === 'no-such-host' ? draw(c.ctx, 'dnsFailure') : draw(c.ctx, 'registryResolve');
    result = { ok: false, pullMs: ms, error: outcome.error };
  }
  c.trace('kubelet.pull.start', `pulling ${req.ref}${queue.length ? `, ${queue.length} more queued` : ''}`, { ...pullData(kdata(c).node, req), queued: queue.length, until: c.now + ms }, req.key);
  set(c, 'pulls', { ...p, queue, current: { ...req, until: c.now + ms, result } });
  c.enqueueAfter(PULL_KEY, ms);
}

/** The serial puller's current pull finished: the image is stored, the waiting pod worker continues. */
export function syncPuller(c: SyncCtx): SyncResult {
  const p = kdata(c).pulls;
  const cur = p.current;
  if (!cur) return { done: true };
  if (c.now < cur.until) return { requeueAfter: cur.until - c.now };
  if (cur.result.ok) {
    const outcome = pullOutcome(parseImageName(cur.image) as ImageName);
    if ('ok' in outcome) addImage(c.ctx, kdata(c).node, storedImage(outcome.ok, parseImageName(cur.image) as ImageName));
  }
  c.trace('kubelet.pull.done', `${cur.ref}: ${cur.result.ok ? 'pulled' : cur.result.error ?? cur.result.notSimulated ?? 'failed'}`, { ...pullData(kdata(c).node, cur), ok: cur.result.ok, ...(cur.result.error !== undefined ? { error: cur.result.error } : {}), ...(cur.result.notSimulated !== undefined ? { notSimulated: cur.result.notSimulated } : {}), pullMs: cur.result.pullMs }, cur.key);
  const rest = { ...p, done: { ...p.done, [cur.id]: cur.result } };
  delete rest.current;
  set(c, 'pulls', rest);
  c.enqueueAfter(cur.key, 0);
  startNextPull(c);
  return { done: true };
}
