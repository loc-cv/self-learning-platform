// The Pod status the kubelet writes, generated from what the runtime reports (the PLEG cache) and
// the reason cache of the last sync's failures.
//
// upstream (v1.37.2): pkg/kubelet/kubelet_pods.go generateAPIPodStatus, getPhase,
// convertToAPIContainerStatuses (default ContainerCreating statuses, state and lastState from the
// two newest containers, the reason cache overriding the state of a container that will be
// restarted, sorted by name); pkg/kubelet/status/generate.go (the conditions and their reasons);
// pkg/kubelet/kuberuntime/util/util.go PodSandboxChanged (PodReadyToStartContainers' messages,
// pkg/kubelet/types/constants.go); pkg/kubelet/status/status_manager.go updateStatusInternal
// (lastTransitionTime kept while the status is unchanged; times in whole seconds; startTime set
// once), mergePodStatus (conditions the kubelet does not own first; a terminal phase forces Ready
// and ContainersReady to False), TerminatePod (ContainerStatusUnknown).
// Feature gates at their v1.37 defaults: PodReadyToStartContainersCondition, PodObservedGenerationTracking,
// InPlacePodVerticalScaling, RecursiveReadOnlyMounts, ContainerRestartRules (all on);
// ContainerStopSignals off; containerd 1.7 reports no user, so `user` is absent.

import type { Millis } from '@simlab/kernel';
import { cloneJson, isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { timeOf } from '../apimachinery/time.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { getPodQOS } from '../apis/core/helper/qos.ts';
import type { RuntimeContainer, Sandbox } from '../runtime/types.ts';

export interface ReasonEntry {
  /** The error's name: `ErrImagePull`, `CrashLoopBackOff`, `RunContainerError`. */
  err: string;
  message: string;
}

export interface PodRuntimeView {
  /** Newest first, as the runtime's PodStatus lists them. */
  sandboxes: Sandbox[];
  /** All containers of the Pod, any order. */
  containers: RuntimeContainer[];
}

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const arr = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObject) as JsonObject[]) : []);

export function specContainers(pod: ApiObject): JsonObject[] {
  return arr(obj(pod.spec as Json).containers);
}

export function isHostNetwork(pod: ApiObject): boolean {
  return obj(pod.spec as Json).hostNetwork === true;
}

/** kubetypes PodSandboxNotReadyMsg* and PodSandboxChanged's order of checks. */
export function sandboxChange(pod: ApiObject, sandboxes: Sandbox[]): { needed: boolean; message: string; previous?: Sandbox } {
  if (sandboxes.length === 0) return { needed: true, message: 'no pod sandbox exists' };
  const latest = sandboxes[0] as Sandbox;
  if (sandboxes.filter((s) => s.state === 'ready').length > 1) return { needed: true, message: 'multiple pod sandboxes are ready and need to be reconciled', previous: latest };
  if (latest.state !== 'ready') return { needed: true, message: 'pod sandbox is not ready', previous: latest };
  if (!isHostNetwork(pod) && latest.ip === '') return { needed: true, message: 'pod sandbox has no IP address', previous: latest };
  return { needed: false, message: '' };
}

/** podutil.ContainerShouldRestart with the Pod's restartPolicy (container restartPolicy and rules are sidecar features). */
export function shouldRestartOnExit(pod: ApiObject, exitCode: number): boolean {
  const policy = str(obj(pod.spec as Json).restartPolicy) || 'Always';
  if (policy === 'Always') return true;
  if (policy === 'OnFailure') return exitCode !== 0;
  return false;
}

/** kubecontainer.ShouldContainerBeRestarted for the newest container of a name. */
export function shouldContainerBeRestarted(pod: ApiObject, newest: RuntimeContainer | undefined): boolean {
  if (obj(pod.metadata as Json).deletionTimestamp) return false;
  if (!newest) return true;
  if (newest.state === 'running') return false;
  if (newest.state === 'created') return true;
  return shouldRestartOnExit(pod, newest.exitCode ?? 0);
}

/** A container's runtime instances, newest first. */
export function instances(view: PodRuntimeView, name: string): RuntimeContainer[] {
  return view.containers.filter((c) => c.name === name).sort((a, b) => b.createdAt - a.createdAt || b.attempt - a.attempt);
}

function containerState(c: RuntimeContainer): JsonObject {
  if (c.state === 'running') return { running: { startedAt: timeOf(c.startedAt ?? c.createdAt) } };
  if (c.state === 'created') return { waiting: {} };
  const t: JsonObject = { exitCode: c.exitCode ?? 0 };
  if (c.reason) t.reason = c.reason;
  if (c.message) t.message = c.message;
  // containerd leaves StartedAt zero for a container that never started (StartError).
  t.startedAt = c.startedAt !== undefined ? timeOf(c.startedAt) : '1970-01-01T00:00:00Z';
  t.finishedAt = timeOf(c.finishedAt ?? c.createdAt);
  t.containerID = `containerd://${c.id}`;
  return { terminated: t };
}

/** `resources` of a container status: the allocated spec resources ({} without any). */
function statusResources(spec: JsonObject): JsonObject {
  const r = obj(spec.resources);
  const out: JsonObject = {};
  if (isObject(r.limits) && Object.keys(r.limits).length > 0) out.limits = cloneJson(r.limits) as JsonObject;
  if (isObject(r.requests) && Object.keys(r.requests).length > 0) out.requests = cloneJson(r.requests) as JsonObject;
  return out;
}

/** `volumeMounts` from the spec: recursiveReadOnly only on read-only mounts, Disabled unless asked for. */
function statusMounts(spec: JsonObject): JsonObject[] | undefined {
  const mounts = arr(spec.volumeMounts);
  if (mounts.length === 0) return undefined;
  return mounts.map((m) => ({
    name: str(m.name),
    mountPath: str(m.mountPath),
    ...(m.readOnly === true ? { readOnly: true, recursiveReadOnly: str(m.recursiveReadOnly) === 'Enabled' ? 'Enabled' : 'Disabled' } : {}),
  }));
}

function containerStatus(pod: ApiObject, spec: JsonObject, view: PodRuntimeView, old: JsonObject | undefined, reason: ReasonEntry | undefined): JsonObject {
  const name = str(spec.name);
  const [newest, previous] = instances(view, name);
  let status: JsonObject;
  if (!newest) {
    status = {
      name,
      state: { waiting: { reason: 'ContainerCreating' } },
      lastState: old && isObject(old.lastState) ? cloneJson(old.lastState) as JsonObject : {},
      ready: false,
      restartCount: typeof old?.restartCount === 'number' ? old.restartCount : 0,
      image: str(spec.image),
      imageID: '',
      started: false,
    };
  } else {
    const running = newest.state === 'running';
    status = {
      name,
      state: containerState(newest),
      lastState: previous && previous.state === 'exited' ? containerState(previous) : {},
      ready: running,
      restartCount: newest.attempt,
      image: newest.image,
      imageID: newest.imageDigest,
      containerID: `containerd://${newest.id}`,
      started: running,
      resources: statusResources(spec),
    };
    const requests = obj(obj(spec.resources).requests);
    if (Object.keys(requests).length > 0) status.allocatedResources = cloneJson(requests) as JsonObject;
  }
  const mounts = statusMounts(spec);
  if (mounts) status.volumeMounts = mounts;
  if (reason && shouldContainerBeRestarted(pod, newest)) {
    if (isObject(status.state) && status.state.terminated) status.lastState = status.state;
    status.state = { waiting: { reason: reason.err, ...(reason.message ? { message: reason.message } : {}) } };
  }
  return status;
}

/** getPhase for a Pod without init containers (kubelet_pods.go). */
export function podPhase(pod: ApiObject, statuses: JsonObject[], podIsTerminal: boolean): string {
  let running = 0;
  let waiting = 0;
  let stopped = 0;
  let succeeded = 0;
  let stoppedNotRestartable = 0;
  let unknown = 0;
  for (const c of specContainers(pod)) {
    const s = statuses.find((x) => x.name === c.name);
    if (!s) {
      unknown++;
      continue;
    }
    const st = obj(s.state);
    const last = obj(s.lastState);
    if (st.running) running++;
    else if (st.terminated) {
      stopped++;
      const code = Number(obj(st.terminated).exitCode ?? 0);
      if (code === 0) succeeded++;
      if (!shouldRestartOnExit(pod, code)) stoppedNotRestartable++;
    } else if (st.waiting && last.terminated) {
      stopped++;
      const code = Number(obj(last.terminated).exitCode ?? 0);
      if (code === 0) succeeded++;
      if (!shouldRestartOnExit(pod, code)) stoppedNotRestartable++;
    } else if (st.waiting) waiting++;
    else unknown++;
  }
  if (waiting > 0) return 'Pending';
  if (running > 0 && unknown === 0) return 'Running';
  if (running === 0 && stopped > 0 && unknown === 0) {
    if (podIsTerminal) return stopped === succeeded ? 'Succeeded' : 'Failed';
    if (stopped !== stoppedNotRestartable) return 'Running';
    return stopped === succeeded ? 'Succeeded' : 'Failed';
  }
  return 'Pending';
}

const KUBELET_CONDITIONS = ['PodScheduled', 'Ready', 'Initialized', 'ContainersReady', 'PodResizeInProgress', 'PodResizePending', 'PodReadyToStartContainers', 'AllContainersRestarting'];
const TRACKED = ['ContainersReady', 'Ready', 'Initialized', 'PodReadyToStartContainers', 'PodScheduled', 'DisruptionTarget', 'AllContainersRestarting'];

export interface GenerateInput {
  pod: ApiObject;
  view: PodRuntimeView;
  reasons: Record<string, ReasonEntry>;
  hostIP: string;
  now: Millis;
  /** The sync after the Pod's containers were killed: Succeeded or Failed. */
  podIsTerminal: boolean;
}

/** generateAPIPodStatus plus what the status manager adds before sending it. */
export function generatePodStatus(input: GenerateInput): JsonObject {
  const { pod, view, reasons, now } = input;
  const old = obj(pod.status as Json);
  const oldStatuses = arr(old.containerStatuses);
  const generation = typeof obj(pod.metadata as Json).generation === 'number' ? (obj(pod.metadata as Json).generation as number) : 1;
  const statuses = specContainers(pod)
    .map((c) => containerStatus(pod, c, view, oldStatuses.find((o) => o.name === c.name), reasons[str(c.name)]))
    .sort((a, b) => (str(a.name) < str(b.name) ? -1 : str(a.name) > str(b.name) ? 1 : 0));
  let phase = podPhase(pod, statuses, input.podIsTerminal);
  // A terminal phase never goes back.
  if (str(old.phase) === 'Succeeded' || str(old.phase) === 'Failed') phase = str(old.phase);
  const terminal = phase === 'Succeeded' || phase === 'Failed';

  const cond = (type: string, status: string, reason?: string, message?: string): JsonObject => ({
    type,
    observedGeneration: generation,
    status,
    ...(reason ? { reason } : {}),
    ...(message ? { message } : {}),
  });
  const sb = sandboxChange(pod, view.sandboxes);
  const readyToStart = sb.needed ? cond('PodReadyToStartContainers', 'False', 'PodSandboxNotReady', sb.message) : cond('PodReadyToStartContainers', 'True');
  const initialized = phase === 'Succeeded' ? cond('Initialized', 'True', 'PodCompleted') : cond('Initialized', 'True');
  let containersReady: JsonObject;
  if (terminal) containersReady = cond('ContainersReady', 'False', phase === 'Failed' ? 'PodFailed' : 'PodCompleted');
  else {
    const unready = specContainers(pod)
      .map((c) => str(c.name))
      .filter((n) => statuses.find((s) => s.name === n)?.ready !== true);
    containersReady = unready.length > 0 ? cond('ContainersReady', 'False', 'ContainersNotReady', `containers with unready status: [${unready.join(' ')}]`) : cond('ContainersReady', 'True');
  }
  const ready = containersReady.status !== 'True' ? { ...containersReady, type: 'Ready' } : cond('Ready', 'True');
  const scheduled = cond('PodScheduled', 'True');
  const kubeletConds = [readyToStart, initialized, ready, containersReady, scheduled];

  // Conditions others own (DisruptionTarget, readiness gates) stay first, as mergePodStatus puts them.
  const oldConds = arr(old.conditions);
  const foreign = oldConds.filter((c) => !KUBELET_CONDITIONS.includes(str(c.type)));
  const conditions = [...foreign.map((c) => cloneJson(c) as JsonObject), ...kubeletConds].map((c) => {
    const prev = oldConds.find((o) => o.type === c.type);
    const keep = prev && prev.status === c.status && TRACKED.includes(str(c.type)) && typeof prev.lastTransitionTime === 'string';
    const lastTransitionTime = keep ? (prev.lastTransitionTime as string) : timeOf(now);
    // Field order of v1.PodCondition: type, observedGeneration, status, lastProbeTime, lastTransitionTime, reason, message.
    const { type, observedGeneration, status, reason, message } = c;
    return {
      type: type as Json,
      ...(observedGeneration !== undefined ? { observedGeneration } : {}),
      status: status as Json,
      lastProbeTime: null,
      lastTransitionTime,
      ...(reason !== undefined ? { reason } : {}),
      ...(message !== undefined ? { message } : {}),
    } as JsonObject;
  });

  const status: JsonObject = { observedGeneration: generation, phase, conditions };
  if (str(old.message)) status.message = old.message as string;
  if (str(old.reason)) status.reason = old.reason as string;
  if (str(old.nominatedNodeName)) status.nominatedNodeName = old.nominatedNodeName as string;
  status.hostIP = input.hostIP;
  status.hostIPs = [{ ip: input.hostIP }];
  const latest = view.sandboxes[0];
  let podIP = '';
  if (isHostNetwork(pod)) podIP = input.hostIP;
  else if (latest && latest.state === 'ready') podIP = latest.ip;
  else if (str(old.podIP)) podIP = old.podIP as string; // the PLEG keeps the last IPs of a stopped Pod
  if (podIP) {
    status.podIP = podIP;
    status.podIPs = [{ ip: podIP }];
  }
  status.startTime = typeof old.startTime === 'string' ? old.startTime : timeOf(now);
  status.containerStatuses = statuses;
  status.qosClass = getPodQOS(pod as JsonObject);
  return status;
}

/**
 * TerminatePod: containers without a terminated state are marked ContainerStatusUnknown and a
 * Pending or Running phase becomes Failed (status_manager.go TerminatePod).
 */
export function terminatedStatus(status: JsonObject): JsonObject {
  const s = cloneJson(status) as JsonObject;
  s.containerStatuses = arr(s.containerStatuses).map((c) => {
    if (obj(c.state).terminated) return c;
    const out: JsonObject = { ...c };
    if (isObject(c.state) && Object.keys(c.state).length > 0 && obj(c.state).waiting === undefined) out.lastState = c.state;
    out.state = { terminated: { exitCode: 137, reason: 'ContainerStatusUnknown', message: 'The container could not be located when the pod was terminated' } };
    return out;
  });
  if (s.phase === 'Pending' || s.phase === 'Running') s.phase = 'Failed';
  return s;
}

/** isPodStatusByKubeletEqual, loosely: the same status apart from timestamps of unchanged conditions. */
export function statusEqual(a: JsonObject, b: JsonObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
