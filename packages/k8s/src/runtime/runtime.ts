// The container runtime of a node: CRI operations on world data, and the processes that run in
// containers, driven by behavior models (PLAN.md §6.3, docs/BEHAVIOR_MODELS.md). The kubelet calls
// the operations; process wake-ups, output and exits are `k8s.runtime.container` events. Every
// state change of a Pod's sandbox or containers is reported to the node's kubelet through the PLEG
// (kubelet/pleg.ts), the way the real kubelet learns of them by relisting.
//
// containerd specifics (texts, the Entrypoint/Cmd rules, the stop signal, exit reasons) are cited
// where they are used; containerd's source is .upstream/containerd at v1.7.28.

import { put, type Contribution, type Ctx, type HandlerSpec, type Json, type Millis } from '@simlab/kernel';
import { BEHAVIOR_MODEL, defaultSignalAction, type Executable, type ModelStep, type ProcessInput, type ProgramModel, type Signal } from '@simlab/host';
import { k8sSlice } from '../apiserver/store.ts';
import { criReturned, plegEvent, podKey } from '../kubelet/pleg.ts';
import { imageView } from './images/files.ts';
import { appendLogLines, createLegacySymlink, createLogFile, legacyLogSymlink, LOG_TOPIC, removeLogFile } from './logs.ts';
import type { NodeRuntime, ProcessState, RuntimeContainer, RuntimeImage, Sandbox } from './types.ts';

export const RUNTIME_EVENT = 'k8s.runtime.container';
const SOURCE = 'k8s.runtime';
const HEX = '0123456789abcdef';

export function runtimeOf(ctx: Ctx, node: string): NodeRuntime {
  const t = k8sSlice(ctx).runtimes;
  return t[node] ?? put(t, node, { node, images: {}, sandboxes: {}, containers: {}, lastIp: 1, nextPid: 1 });
}

function update(ctx: Ctx, node: string, f: (rt: NodeRuntime) => NodeRuntime): NodeRuntime {
  const rt = f(runtimeOf(ctx, node));
  put(k8sSlice(ctx).runtimes, node, rt);
  return rt;
}

function setContainer(ctx: Ctx, node: string, c: RuntimeContainer): void {
  update(ctx, node, (rt) => ({ ...rt, containers: { ...rt.containers, [c.id]: c } }));
}

export function getContainer(ctx: Ctx, node: string, id: string): RuntimeContainer | undefined {
  return runtimeOf(ctx, node).containers[id];
}

/** containerd's ids: 32 random bytes in hex. */
function newId(ctx: Ctx): string {
  return ctx.random('k8s.runtime.id').chars(64, HEX);
}

/**
 * A runtime record. `cause` is the record of the kubelet call that asked for the operation (its
 * sync); an operation the runtime does on its own (a process exits) has none.
 */
function trace(ctx: Ctx, node: string, kind: string, subject: string, message: string, data?: Json, cause?: number): number {
  return ctx.trace({ source: `${SOURCE}/${node}`, kind, subject, message, ...(data !== undefined ? { data } : {}), ...(cause !== undefined ? { causes: [cause] } : {}) });
}

/** The container a record is about: the Pod, the container's name and id. */
function containerData(node: string, c: RuntimeContainer): { [k: string]: Json } {
  return { node, namespace: c.namespace, name: c.podName, uid: c.podUID, container: c.name, containerId: c.id, attempt: c.attempt };
}

// ---- images ----

export function addImage(ctx: Ctx, node: string, img: RuntimeImage): void {
  update(ctx, node, (rt) => {
    const old = rt.images[img.id];
    const merged: RuntimeImage = old
      ? { ...old, repoTags: [...old.repoTags, ...img.repoTags.filter((t) => !old.repoTags.includes(t))], repoDigests: [...old.repoDigests, ...img.repoDigests.filter((d) => !old.repoDigests.includes(d))] }
      : img;
    // A tag moves to the new image: containerd's image store maps a name to one target.
    const images: Record<string, RuntimeImage> = {};
    for (const id of Object.keys(rt.images).sort()) {
      const other = rt.images[id] as RuntimeImage;
      if (id === img.id) continue;
      images[id] = { ...other, repoTags: other.repoTags.filter((t) => !img.repoTags.includes(t)) };
    }
    images[img.id] = merged;
    return { ...rt, images };
  });
}

/** The image a reference names in the node's store: by tag or by digest. */
export function findLocalImage(ctx: Ctx, node: string, ref: { repository: string; tag?: string; digest?: string }): RuntimeImage | undefined {
  const rt = runtimeOf(ctx, node);
  for (const id of Object.keys(rt.images).sort()) {
    const img = rt.images[id] as RuntimeImage;
    if (ref.digest !== undefined) {
      if (img.repoDigests.includes(`${ref.repository}@${ref.digest}`)) return img;
    } else if (img.repoTags.includes(`${ref.repository}:${ref.tag ?? 'latest'}`)) return img;
  }
  return undefined;
}

// ---- sandboxes ----

export interface SandboxRequest {
  podUID: string;
  namespace: string;
  name: string;
  hostNetwork: boolean;
  nodeIP: string;
  podCIDR: string;
  hostname: string;
}

/** host-local IPAM: the next free address after the last one handed out, skipping the network and gateway. */
function allocateIp(rt: NodeRuntime, cidr: string): { ip: string; last: number } {
  const [base, bits] = cidr.split('/') as [string, string];
  const size = 2 ** (32 - Number(bits));
  const o = base.split('.').map(Number) as [number, number, number, number];
  const baseN = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const used = new Set(Object.values(rt.sandboxes).filter((s) => !s.hostNetwork && s.state === 'ready').map((s) => s.ip));
  for (let i = 1; i <= size - 3; i++) {
    let off = rt.lastIp + i;
    if (off > size - 2) off -= size - 3;
    const n = baseN + off;
    const ip = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    if (!used.has(ip)) return { ip, last: off };
  }
  throw new Error(`no free address in ${cidr}`);
}

/** RunPodSandbox, completed: the pause container runs and the network is set up. */
export function runPodSandbox(ctx: Ctx, node: string, req: SandboxRequest, cause?: number): Sandbox {
  let created: Sandbox | undefined;
  update(ctx, node, (rt) => {
    const attempt = Object.values(rt.sandboxes).filter((s) => s.podUID === req.podUID).length;
    let lastIp = rt.lastIp;
    let ip = req.nodeIP;
    if (!req.hostNetwork) {
      const a = allocateIp(rt, req.podCIDR);
      ip = a.ip;
      lastIp = a.last;
    }
    created = { id: newId(ctx), podUID: req.podUID, namespace: req.namespace, name: req.name, attempt, state: 'ready', createdAt: ctx.now, hostNetwork: req.hostNetwork, ip, hostname: req.hostname };
    return { ...rt, lastIp, sandboxes: { ...rt.sandboxes, [created.id]: created } };
  });
  const sb = created as Sandbox;
  trace(ctx, node, 'runtime.sandbox.ready', `pod/${req.namespace}/${req.name}`, `sandbox ${sb.id.slice(0, 13)} ready with IP ${sb.ip}`, { node, namespace: req.namespace, name: req.name, uid: req.podUID, sandbox: sb.id, ip: sb.ip, attempt: sb.attempt }, cause);
  plegEvent(ctx, node, podKey(req.namespace, req.name, req.podUID), 'sandbox ready');
  return sb;
}

/** StopPodSandbox: the network is torn down (the address goes back to the pool) and the pause container stops. */
export function stopPodSandbox(ctx: Ctx, node: string, id: string, cause?: number): void {
  const sb = runtimeOf(ctx, node).sandboxes[id];
  if (!sb || sb.state === 'notready') return;
  update(ctx, node, (rt) => ({ ...rt, sandboxes: { ...rt.sandboxes, [id]: { ...sb, state: 'notready' } } }));
  trace(ctx, node, 'runtime.sandbox.stopped', `pod/${sb.namespace}/${sb.name}`, `sandbox ${id.slice(0, 13)} stopped`, { node, namespace: sb.namespace, name: sb.name, uid: sb.podUID, sandbox: id }, cause);
  plegEvent(ctx, node, podKey(sb.namespace, sb.name, sb.podUID), 'sandbox stopped');
}

export function removePodSandbox(ctx: Ctx, node: string, id: string): void {
  update(ctx, node, (rt) => {
    const sandboxes = { ...rt.sandboxes };
    delete sandboxes[id];
    return { ...rt, sandboxes };
  });
}

export function sandboxesOf(ctx: Ctx, node: string, podUID: string): Sandbox[] {
  const rt = runtimeOf(ctx, node);
  return Object.keys(rt.sandboxes)
    .map((k) => rt.sandboxes[k] as Sandbox)
    .filter((s) => s.podUID === podUID)
    .sort((a, b) => a.createdAt - b.createdAt || a.attempt - b.attempt);
}

export function containersOf(ctx: Ctx, node: string, podUID: string): RuntimeContainer[] {
  const rt = runtimeOf(ctx, node);
  return Object.keys(rt.containers)
    .map((k) => rt.containers[k] as RuntimeContainer)
    .filter((c) => c.podUID === podUID)
    .sort((a, b) => a.createdAt - b.createdAt || a.attempt - b.attempt || (a.id < b.id ? -1 : 1));
}

// ---- containers ----

export interface ContainerRequest {
  sandbox: Sandbox;
  name: string;
  attempt: number;
  imageRef: string;
  image: RuntimeImage;
  /** CRI ContainerStatus image and imageRef as containerd reports them. */
  imageName: string;
  imageDigest: string;
  hash: string;
  logPath: string;
}

/** CreateContainer: the container exists, its log file is open, nothing runs yet. */
export function createContainer(ctx: Ctx, node: string, req: ContainerRequest, cause?: number): RuntimeContainer {
  const c: RuntimeContainer = {
    id: newId(ctx),
    sandboxId: req.sandbox.id,
    podUID: req.sandbox.podUID,
    namespace: req.sandbox.namespace,
    podName: req.sandbox.name,
    name: req.name,
    attempt: req.attempt,
    imageRef: req.imageRef,
    imageId: req.image.id,
    image: req.imageName,
    imageDigest: req.imageDigest,
    hash: req.hash,
    state: 'created',
    createdAt: ctx.now,
    pending: [],
    partial: { stdout: '', stderr: '' },
    logPath: req.logPath,
  };
  setContainer(ctx, node, c);
  createLogFile(ctx, node, c.logPath);
  trace(ctx, node, 'runtime.container.created', `pod/${c.namespace}/${c.podName}/${c.name}`, `container ${c.id.slice(0, 13)} created from ${req.imageRef}`, { ...containerData(node, c), image: req.imageRef }, cause);
  return c;
}

export interface ProcessSpec {
  /** The resolved argv (Entrypoint/Cmd overridden by command/args). */
  argv: string[];
  env: [string, string][];
  /** execvp's lookup in the image's filesystem with the process's PATH. */
  which(name: string): Executable | undefined;
  file(path: string): string | undefined;
}

/** StartContainer, failed: the process could not be started. The container is exited. */
export function failStart(ctx: Ctx, node: string, id: string, exitCode: number, reason: string, message: string, cause?: number): void {
  const c = getContainer(ctx, node, id);
  if (!c) return;
  setContainer(ctx, node, { ...c, state: 'exited', exitCode, reason, message, finishedAt: ctx.now });
  trace(ctx, node, 'runtime.container.start-failed', `pod/${c.namespace}/${c.podName}/${c.name}`, `container ${c.id.slice(0, 13)} failed to start: ${message}`, { ...containerData(node, c), exitCode, reason, message }, cause);
  plegEvent(ctx, node, podKey(c.namespace, c.podName, c.podUID), `container ${c.name} start failed`);
}

/** StartContainer, succeeded: the init process runs its model. */
export function startProcess(ctx: Ctx, node: string, id: string, exe: Executable, spec: ProcessSpec, cause?: number): void {
  const c = getContainer(ctx, node, id);
  if (!c) return;
  const proc: ProcessState = { exe, argv: spec.argv, env: spec.env, pid: 1, state: null, listen: [] };
  setContainer(ctx, node, { ...c, state: 'running', startedAt: ctx.now, proc });
  createLegacySymlink(ctx, node, legacyLogSymlink(c.namespace, c.podName, c.name, c.id), c.logPath);
  const tid = trace(ctx, node, 'runtime.container.started', `pod/${c.namespace}/${c.podName}/${c.name}`, `container ${c.id.slice(0, 13)} started: ${spec.argv.join(' ')}`, { ...containerData(node, c), model: exe.model, argv: spec.argv }, cause);
  const model = modelOf(ctx, exe.model);
  applyStep(ctx, node, id, model.start(processInput(ctx, node, id)), tid);
  plegEvent(ctx, node, podKey(c.namespace, c.podName, c.podUID), `container ${c.name} started`);
}

function modelOf(ctx: Ctx, name: string): ProgramModel {
  return ctx.registry.get<ProgramModel & Contribution>(BEHAVIOR_MODEL, name) ?? (ctx.registry.get<ProgramModel & Contribution>(BEHAVIOR_MODEL, 'unmodeled') as ProgramModel);
}

function processInput(ctx: Ctx, node: string, id: string): ProcessInput {
  const c = getContainer(ctx, node, id) as RuntimeContainer;
  const proc = c.proc as ProcessState;
  const view = imageView(c.imageId);
  const sb = runtimeOf(ctx, node).sandboxes[c.sandboxId];
  return {
    argv: proc.argv,
    env: proc.env,
    exe: proc.exe,
    pid: proc.pid,
    init: true,
    hostname: sb?.hostname ?? c.podName,
    // NODE_CAPACITY cpu (topology/nodes.ts): every simulated node has 2.
    cpus: 2,
    now: ctx.now,
    which: (name) => view.which(proc.env, name),
    file: (path) => view.file(path),
  };
}

/** Writes output that is due now: complete lines go to the log, a partial line waits. */
function writeOutput(ctx: Ctx, node: string, c: RuntimeContainer, stream: 'stdout' | 'stderr', text: string): RuntimeContainer {
  const buf = c.partial[stream] + text;
  const parts = buf.split('\n');
  const rest = parts.pop() as string;
  const clock = appendLogLines(ctx, node, c.logPath, stream, parts, 'F', c.logClock);
  return { ...c, partial: { ...c.partial, [stream]: rest }, ...(clock ? { logClock: clock } : {}) };
}

function applyStep(ctx: Ctx, node: string, id: string, step: ModelStep, cause: number): void {
  let c = getContainer(ctx, node, id);
  if (!c?.proc) return;
  for (const g of step.gaps ?? []) {
    ctx.gap({ kind: 'behavior', program: c.proc.exe.model, what: g.what, commandLine: c.proc.argv.join(' '), machine: node });
    ctx.trace({ source: `${SOURCE}/${node}`, kind: 'runtime.model.gap', subject: `pod/${c.namespace}/${c.podName}/${c.name}`, message: `${g.what}${g.detail ? `: ${g.detail}` : ''}`, data: { ...containerData(node, c), what: g.what }, causes: [cause] });
  }
  const pending = [...c.pending];
  for (const o of step.output ?? []) {
    const after = o.after ?? 0;
    if (after <= 0 && pending.length === 0) c = writeOutput(ctx, node, c, o.stream, o.text);
    else pending.push({ at: ctx.now + after, stream: o.stream, text: o.text });
  }
  const proc: ProcessState = { ...(c.proc as ProcessState) };
  delete proc.wakeAt;
  delete proc.pendingEnd;
  if (step.listen) proc.listen = step.listen;
  const n = step.next;
  if ('wake' in n) {
    proc.state = n.state;
    proc.wakeAt = ctx.now + n.wake;
  } else if ('wait' in n) {
    proc.state = n.state;
  } else if ('exit' in n) {
    proc.pendingEnd = { at: ctx.now + (n.after ?? 0), exit: n.exit };
  } else {
    proc.pendingEnd = { at: ctx.now + (n.after ?? 0), exec: n.exec.env ? { exe: n.exec.exe, argv: n.exec.argv, env: n.exec.env } : { exe: n.exec.exe, argv: n.exec.argv } };
  }
  c = { ...c, pending, proc };
  setContainer(ctx, node, c);
  reschedule(ctx, node, id);
}

/** Keeps one runtime event pending per container, at its earliest due work. */
function reschedule(ctx: Ctx, node: string, id: string): void {
  const c = getContainer(ctx, node, id);
  if (!c) return;
  const times: number[] = [];
  for (const p of c.pending) times.push(p.at);
  if (c.proc?.wakeAt !== undefined) times.push(c.proc.wakeAt);
  if (c.proc?.pendingEnd) times.push(c.proc.pendingEnd.at);
  if (c.killAt !== undefined && c.state === 'running') times.push(c.killAt);
  const at = times.length ? Math.max(ctx.now, Math.min(...times)) : undefined;
  if (c.event && c.event.at === at) return;
  if (c.event) ctx.cancel(c.event.id);
  const next: RuntimeContainer = { ...c };
  delete next.event;
  if (at !== undefined) next.event = { id: ctx.schedule(at - ctx.now, RUNTIME_EVENT, { node, id }), at };
  setContainer(ctx, node, next);
}

/** The process ended: flush its partial lines, record the exit (containerd's reason), tell the kubelet. */
function exited(ctx: Ctx, node: string, id: string, exitCode: number, cause: string, causeId?: number): void {
  let c = getContainer(ctx, node, id);
  if (!c || c.state !== 'running') return;
  for (const p of c.pending) c = writeOutput(ctx, node, c, p.stream, p.text);
  let clock = c.logClock;
  for (const s of ['stdout', 'stderr'] as const) if (c.partial[s] !== '') clock = appendLogLines(ctx, node, c.logPath, s, [c.partial[s]], 'P', clock);
  if (c.event) ctx.cancel(c.event.id);
  const next: RuntimeContainer = { ...c, state: 'exited', exitCode, reason: exitReason(exitCode), finishedAt: ctx.now, pending: [], partial: { stdout: '', stderr: '' } };
  delete next.proc;
  delete next.event;
  delete next.killAt;
  setContainer(ctx, node, next);
  trace(ctx, node, 'runtime.container.exited', `pod/${c.namespace}/${c.podName}/${c.name}`, `container ${c.id.slice(0, 13)} exited with ${exitCode}: ${cause}`, { ...containerData(node, c), exitCode, reason: exitReason(exitCode), cause, startedAt: c.startedAt ?? null, ...(c.stopping ? { stopping: true } : {}) }, causeId);
  // A log stream following this container ends once it has read what is left.
  ctx.publish(LOG_TOPIC);
  plegEvent(ctx, node, podKey(c.namespace, c.podName, c.podUID), `container ${c.name} exited with ${exitCode}`);
  // The kubelet waits on StopContainer and hears about the exit directly.
  if (c.stopping) criReturned(ctx, node, podKey(c.namespace, c.podName, c.podUID), `StopContainer ${c.name} returned`);
}

/**
 * containerd's reason for an exited container without an explicit one: "Completed" for 0, "Error"
 * otherwise, also after a signal (pkg/cri/server/container_status.go toCRIContainerStatus,
 * helpers.go). OOM kills are "OOMKilled" (events.go TaskOOM), which needs memory accounting
 * (phase 16b).
 */
export function exitReason(code: number): string {
  return code === 0 ? 'Completed' : 'Error';
}

function runDue(ctx: Ctx, node: string, id: string): void {
  let c = getContainer(ctx, node, id);
  if (!c) return;
  const ev: RuntimeContainer = { ...c };
  delete ev.event;
  setContainer(ctx, node, ev);
  c = ev;
  if (c.state !== 'running' || !c.proc) return;
  // Output due by now, in order.
  const due = c.pending.filter((p) => p.at <= ctx.now);
  if (due.length > 0) {
    let cur: RuntimeContainer = { ...c, pending: c.pending.filter((p) => p.at > ctx.now) };
    for (const p of due) cur = writeOutput(ctx, node, cur, p.stream, p.text);
    setContainer(ctx, node, cur);
    c = cur;
  }
  if (c.killAt !== undefined && c.killAt <= ctx.now) {
    exited(ctx, node, id, 137, 'killed by SIGKILL after the stop timeout');
    return;
  }
  const proc = c.proc as ProcessState;
  if (proc.pendingEnd && proc.pendingEnd.at <= ctx.now && c.pending.length === 0) {
    const end = proc.pendingEnd;
    if (end.exit !== undefined) {
      exited(ctx, node, id, end.exit, 'the process exited');
      return;
    }
    if (end.exec) {
      const p2: ProcessState = { exe: end.exec.exe, argv: end.exec.argv, env: end.exec.env ?? proc.env, pid: proc.pid, state: null, listen: proc.listen };
      setContainer(ctx, node, { ...c, proc: p2 });
      const tid = trace(ctx, node, 'runtime.process.exec', `pod/${c.namespace}/${c.podName}/${c.name}`, `exec ${end.exec.argv.join(' ')}`, { ...containerData(node, c), model: end.exec.exe.model, argv: end.exec.argv });
      applyStep(ctx, node, id, modelOf(ctx, end.exec.exe.model).start(processInput(ctx, node, id)), tid);
      return;
    }
  }
  if (proc.wakeAt !== undefined && proc.wakeAt <= ctx.now) {
    const tid = trace(ctx, node, 'runtime.process.wake', `pod/${c.namespace}/${c.podName}/${c.name}`, `${proc.exe.model} wakes up`, { ...containerData(node, c), model: proc.exe.model });
    applyStep(ctx, node, id, modelOf(ctx, proc.exe.model).resume(processInput(ctx, node, id), proc.state), tid);
    return;
  }
  reschedule(ctx, node, id);
}

const SIGNALS: Record<string, Signal> = { SIGTERM: 'SIGTERM', SIGINT: 'SIGINT', SIGQUIT: 'SIGQUIT', SIGHUP: 'SIGHUP', SIGUSR1: 'SIGUSR1', SIGUSR2: 'SIGUSR2', SIGWINCH: 'SIGWINCH', '15': 'SIGTERM', '3': 'SIGQUIT', '2': 'SIGINT', '1': 'SIGHUP' };

/**
 * StopContainer(timeout): the image's StopSignal (SIGTERM when it names none) now, SIGKILL when
 * the timeout passes (pkg/cri/server/container_stop.go stopContainer).
 */
export function stopContainer(ctx: Ctx, node: string, id: string, timeout: Millis, stopSignal: string | undefined, cause?: number): void {
  const c = getContainer(ctx, node, id);
  if (!c) return;
  if (c.state !== 'running' || !c.proc) {
    // Created but never started, or already exited: nothing runs.
    if (c.state === 'created') setContainer(ctx, node, { ...c, state: 'exited', exitCode: 0, reason: exitReason(0), finishedAt: ctx.now });
    criReturned(ctx, node, podKey(c.namespace, c.podName, c.podUID), `StopContainer ${c.name} returned`);
    return;
  }
  const signal = SIGNALS[(stopSignal ?? 'SIGTERM').toUpperCase()] ?? 'SIGTERM';
  setContainer(ctx, node, { ...c, stopping: true, killAt: ctx.now + timeout });
  const tid = trace(ctx, node, 'runtime.container.signal', `pod/${c.namespace}/${c.podName}/${c.name}`, `${signal} to container ${c.id.slice(0, 13)}, SIGKILL in ${timeout} ms`, { ...containerData(node, c), signal, killAt: ctx.now + timeout }, cause);
  deliver(ctx, node, id, signal, tid);
}

function deliver(ctx: Ctx, node: string, id: string, signal: Signal, cause: number): void {
  const c = getContainer(ctx, node, id);
  if (!c?.proc) return;
  const model = modelOf(ctx, c.proc.exe.model);
  const r = model.signal ? model.signal(processInput(ctx, node, id), c.proc.state, signal) : 'default';
  if (r === 'default') {
    const action = defaultSignalAction(signal, true);
    if (action) exited(ctx, node, id, action.exit, `killed by ${signal}`, cause);
    else {
      trace(ctx, node, 'runtime.signal.ignored', `pod/${c.namespace}/${c.podName}/${c.name}`, `${signal} ignored: PID 1 has no handler for it`, { ...containerData(node, c), signal }, cause);
      reschedule(ctx, node, id);
    }
    return;
  }
  applyStep(ctx, node, id, r, cause);
}

/** RemoveContainer: the container and its log file are gone. */
export function removeContainer(ctx: Ctx, node: string, id: string): void {
  const c = getContainer(ctx, node, id);
  if (!c) return;
  if (c.event) ctx.cancel(c.event.id);
  removeLogFile(ctx, node, c.logPath);
  removeLogFile(ctx, node, legacyLogSymlink(c.namespace, c.podName, c.name, c.id));
  update(ctx, node, (rt) => {
    const containers = { ...rt.containers };
    delete containers[id];
    return { ...rt, containers };
  });
  ctx.publish(LOG_TOPIC);
}

export const runtimeHandlers: HandlerSpec[] = [
  {
    type: RUNTIME_EVENT,
    handle(ctx, payload) {
      const { node, id } = payload as { node: string; id: string };
      runDue(ctx, node, id);
    },
  },
];
