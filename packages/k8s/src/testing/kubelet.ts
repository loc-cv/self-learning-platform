// A stand-in for the scheduler and the kubelets, for controller tests only (never registered by
// the k8s plugin; tests add `fakeKubeletPlugin`). It is itself a controller on the runtime: it
// watches Pods, binds an unbound Pod to the next node (round robin) through pods/binding, then
// after `readyAfter` writes a status the way a kubelet would for the Pod's behavior, and finishes
// graceful deletions after `terminateAfter` (or the grace period, if shorter) by deleting with
// grace period 0, as the kubelet's status manager does.
//
// Behavior per Pod: the annotation `simlab.test/kubelet` (`ready`, `not-ready`, `fail`), else the
// configured default. Status shapes follow the kubelet's generateAPIPodStatus loosely; the real
// kubelet is src/kubelet/, and topologies run it. Nothing here is user-visible.

import type { Contribution, Ctx, Millis, Plugin } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { parseTime as parseRfc3339, timeOf } from '../apimachinery/time.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { CONTROLLER, startController, stopController } from '../controllers/runtime.ts';
import type { ControllerSpec, SyncCtx, SyncResult } from '../controllers/types.ts';

export const FAKE_KUBELET = 'fake-kubelet';
export const FAKE_KUBELET_INSTANCE = 'test';
export const BEHAVIOR_ANNOTATION = 'simlab.test/kubelet';

export type PodBehavior = 'ready' | 'not-ready' | 'fail';

export interface FakeKubeletConfig {
  nodes: { name: string; ip: string }[];
  /** From binding to the status write. */
  readyAfter: Millis;
  /** From the deletion request to the final delete, unless the grace period is shorter. */
  terminateAfter: Millis;
  behavior: PodBehavior;
}

/** The workers of kubeadm-1cp-2w (tools/src/oracle/topology.ts). */
export const DEFAULT_FAKE_KUBELET: FakeKubeletConfig = {
  nodes: [
    { name: 'node01', ip: '172.16.0.11' },
    { name: 'node02', ip: '172.16.0.12' },
  ],
  readyAfter: 2000,
  terminateAfter: 1000,
  behavior: 'ready',
};

const meta = (o: ApiObject): JsonObject => (o.metadata ?? {}) as JsonObject;
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

function config(c: SyncCtx): FakeKubeletConfig {
  return (c.data().config as unknown as FakeKubeletConfig | undefined) ?? DEFAULT_FAKE_KUBELET;
}

function parseTime(t: string): Millis {
  const r = parseRfc3339(t, false);
  return 'micros' in r ? r.micros / 1000 : 0;
}

function condition(pod: ApiObject, type: string): JsonObject | undefined {
  const cs = ((pod.status as JsonObject | undefined)?.conditions ?? []) as JsonObject[];
  return cs.find((c) => c.type === type);
}

function sync(c: SyncCtx, key: string): SyncResult {
  const [namespace, name] = key.split('/') as [string, string];
  const pod = c.get('v1/pods', namespace, name);
  if (!pod) return { done: true };
  const cfg = config(c);
  const m = meta(pod);
  const spec = (pod.spec ?? {}) as JsonObject;
  const pods = c.client.resource('v1/pods');
  if (m.deletionTimestamp) {
    if (str(spec.nodeName) === '') return { done: true };
    const grace = typeof m.deletionGracePeriodSeconds === 'number' ? m.deletionGracePeriodSeconds * 1000 : 0;
    // deletionTimestamp = request time + grace period.
    const requested = parseTime(str(m.deletionTimestamp)) - grace;
    const due = requested + Math.min(cfg.terminateAfter, grace);
    if (c.now < due) return { requeueAfter: due - c.now };
    pods.delete(namespace, name, { gracePeriodSeconds: 0, preconditions: { uid: str(m.uid) } });
    return { done: true };
  }
  if (str(spec.nodeName) === '') {
    const n = Number(c.data().next ?? 0);
    const node = cfg.nodes[n % cfg.nodes.length] as { name: string };
    c.setData('next', n + 1);
    // The exact bind time: PodScheduled's lastTransitionTime has whole seconds only.
    c.setData(`bound:${str(m.uid)}`, c.now);
    c.client.request({ verb: 'create', group: '', version: 'v1', resource: 'pods', subresource: 'binding', namespace, name, body: { apiVersion: 'v1', kind: 'Binding', metadata: { name }, target: { kind: 'Node', name: node.name } } });
    return { done: true };
  }
  const status = (pod.status ?? {}) as JsonObject;
  if (str(status.phase) !== 'Pending' || Array.isArray(status.containerStatuses)) return { done: true };
  const scheduled = condition(pod, 'PodScheduled');
  const recorded = c.data()[`bound:${str(m.uid)}`];
  const boundAt = typeof recorded === 'number' ? recorded : scheduled ? parseTime(str(scheduled.lastTransitionTime)) : c.now;
  if (c.now < boundAt + cfg.readyAfter) return { requeueAfter: boundAt + cfg.readyAfter - c.now };
  c.setData(`bound:${str(m.uid)}`, undefined);
  const behavior = (str((m.annotations as JsonObject | undefined)?.[BEHAVIOR_ANNOTATION]) || cfg.behavior) as PodBehavior;
  const node = cfg.nodes.find((x) => x.name === spec.nodeName) ?? { name: str(spec.nodeName), ip: '172.16.0.99' };
  const nodeIndex = cfg.nodes.indexOf(node as { name: string; ip: string }) + 1;
  const ipN = c.ctx.nextId('test.kubelet.ip');
  const podIP = `10.244.${nodeIndex}.${(ipN % 250) + 2}`;
  pods.updateStatus(namespace, { ...pod, status: podStatus(pod, behavior, c.ctx, node.ip, podIP) });
  return { done: true };
}

function podStatus(pod: ApiObject, behavior: PodBehavior, ctx: Ctx, hostIP: string, podIP: string): JsonObject {
  const now = timeOf(ctx.now);
  const status = (pod.status ?? {}) as JsonObject;
  const containers = (((pod.spec ?? {}) as JsonObject).containers ?? []) as JsonObject[];
  const names = containers.map((x) => str(x.name));
  const ready = behavior === 'ready';
  const failed = behavior === 'fail';
  const unready = ready ? {} : { reason: failed ? 'PodFailed' : 'ContainersNotReady', message: `containers with unready status: [${names.join(' ')}]` };
  const conds: JsonObject[] = [
    { type: 'PodReadyToStartContainers', status: failed ? 'False' : 'True', lastProbeTime: null, lastTransitionTime: now },
    { type: 'Initialized', status: 'True', lastProbeTime: null, lastTransitionTime: now },
    { type: 'Ready', status: ready ? 'True' : 'False', lastProbeTime: null, lastTransitionTime: now, ...unready },
    { type: 'ContainersReady', status: ready ? 'True' : 'False', lastProbeTime: null, lastTransitionTime: now, ...unready },
    condition(pod, 'PodScheduled') ?? { type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: now },
  ];
  return {
    ...status,
    phase: failed ? 'Failed' : 'Running',
    conditions: conds,
    hostIP,
    hostIPs: [{ ip: hostIP }],
    podIP,
    podIPs: [{ ip: podIP }],
    startTime: now,
    containerStatuses: containers.map((x) => ({
      name: str(x.name),
      image: str(x.image),
      imageID: '',
      ready,
      restartCount: 0,
      started: !failed,
      state: failed ? { terminated: { exitCode: 1, reason: 'Error', startedAt: now, finishedAt: now } } : { running: { startedAt: now } },
    })),
  };
}

export const fakeKubeletSpec: ControllerSpec = {
  name: FAKE_KUBELET,
  component: 'kube-controller-manager',
  serviceAccount: 'fake-kubelet',
  watches: [
    {
      resource: 'v1/pods',
      keys: (ev) => (ev.type === 'DELETED' ? [] : [`${str(meta(ev.object).namespace)}/${str(meta(ev.object).name)}`]),
    },
  ],
  sync,
  latency: 1,
};

/** Add to the registry's plugins in tests that need Pods to run. */
export const fakeKubeletPlugin: Plugin = {
  name: 'test-fake-kubelet',
  requires: ['k8s'],
  contributions: { [CONTROLLER]: [fakeKubeletSpec as unknown as Contribution] },
};

export function startFakeKubelet(ctx: Ctx, server: ApiServerConfig, cfg: Partial<FakeKubeletConfig> = {}): void {
  // Config lives in the controller's world data, so forks and snapshots keep it. It is set before
  // the start, whose initial list already queues the existing Pods.
  startController(ctx, FAKE_KUBELET_INSTANCE, FAKE_KUBELET, server, { config: { ...DEFAULT_FAKE_KUBELET, ...cfg } as unknown as Json });
}

export function stopFakeKubelet(ctx: Ctx): void {
  stopController(ctx, FAKE_KUBELET_INSTANCE, FAKE_KUBELET);
}
