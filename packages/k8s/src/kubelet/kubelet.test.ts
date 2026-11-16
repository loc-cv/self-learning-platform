// Simulation tests of the kubelet and the container runtime in virtual time on kubeadm-1cp-2w:
// the phase 06b exit criteria, asserting on Pod status, events, the trace and the node's files.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { createFs, hostPlugin, ROOT_CRED } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { createClient } from '../client/client.ts';
import { k8sPlugin } from '../plugin.ts';
import { buildCluster } from '../topology/build.ts';
import { KUBEADM_1CP_2W } from '../topology/cluster.ts';
import { isKubeletRunning, startKubelet, stopKubelet } from './kubelet.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);
const ADMIN = { username: 'kubernetes-admin', groups: ['kubeadm:cluster-admins', 'system:authenticated'] };

interface Env {
  k: Kernel;
  traces: TraceRecord[];
}

function boot(seed = 1): Env {
  const traces: TraceRecord[] = [];
  const k = bootKernel(registry, { seed, startTime: DEFAULT_START_TIME, ports: { trace: (r: TraceRecord) => traces.push(r) } });
  k.act('topology', (ctx) => buildCluster(ctx, KUBEADM_1CP_2W));
  k.advance(5_000);
  return { k, traces };
}

const client = (k: Kernel, f: (c: ReturnType<typeof createClient>) => unknown): unknown => k.act('api', (ctx) => f(createClient(ctx, DEFAULT_APISERVER, ADMIN)));

function create(env: Env, resource: string, body: JsonObject, ns = 'default'): JsonObject {
  const r = client(env.k, (c) => c.resource(resource).create(ns, body)) as { ok: boolean; object?: JsonObject };
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.object as JsonObject;
}

function pods(env: Env, ns = 'default'): JsonObject[] {
  const r = client(env.k, (c) => c.resource('v1/pods').list(ns)) as { ok: boolean; object: JsonObject };
  return (r.object.items ?? []) as JsonObject[];
}

function pod(env: Env, name: string, ns = 'default'): JsonObject | undefined {
  return pods(env, ns).find((p) => (p.metadata as JsonObject).name === name);
}

function events(env: Env, involved: string, ns = 'default'): { reason: string; message: string; type: string; count: number; fieldPath?: string }[] {
  const r = client(env.k, (c) => c.resource('v1/events').list(ns)) as { ok: boolean; object: JsonObject };
  return ((r.object.items ?? []) as JsonObject[])
    .filter((e) => (e.involvedObject as JsonObject).name === involved)
    .map((e) => ({ reason: String(e.reason), message: String(e.message), type: String(e.type), count: Number(e.count), ...((e.involvedObject as JsonObject).fieldPath ? { fieldPath: String((e.involvedObject as JsonObject).fieldPath) } : {}) }));
}

const status = (p: JsonObject | undefined): JsonObject => (p?.status ?? {}) as JsonObject;
const cs = (p: JsonObject | undefined): JsonObject => ((status(p).containerStatuses as JsonObject[] | undefined) ?? [])[0] ?? {};
const waiting = (p: JsonObject | undefined): JsonObject | undefined => (cs(p).state as JsonObject | undefined)?.waiting as JsonObject | undefined;
const nodeOf = (p: JsonObject | undefined): string => String(((p?.spec ?? {}) as JsonObject).nodeName ?? '');

function simplePod(name: string, container: JsonObject, spec: JsonObject = {}): JsonObject {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec: { containers: [{ name: 'c', ...container }], ...spec } };
}

/** Samples `f` every `step` ms for `total` ms; returns the distinct consecutive values with their first time. */
function watch<T>(env: Env, total: number, step: number, f: () => T): { t: number; v: T }[] {
  const out: { t: number; v: T }[] = [];
  for (let t = 0; t <= total; t += step) {
    const v = f();
    if (out.length === 0 || JSON.stringify(out[out.length - 1]?.v) !== JSON.stringify(v)) out.push({ t: env.k.now, v });
    env.k.advance(step);
  }
  return out;
}

const tracesOf = (env: Env, kind: string, subject?: string): TraceRecord[] => env.traces.filter((r) => r.kind === kind && (subject === undefined || (r.subject ?? '').includes(subject)));

describe('kubelet and container runtime', () => {
  test('a three-replica Deployment reaches Running across the workers in a few seconds', () => {
    const env = boot();
    const t0 = env.k.now;
    create(env, 'apps/v1/deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web' },
      spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.29' }] } } },
    });
    const allReady = (): boolean => pods(env).length === 3 && pods(env).every((p) => status(p).phase === 'Running' && cs(p).ready === true);
    let readyAt = 0;
    for (let i = 0; i < 300 && !readyAt; i++) {
      env.k.advance(100);
      if (allReady()) readyAt = env.k.now;
    }
    expect(readyAt).toBeGreaterThan(0);
    // A pull of nginx (about 60 MB) and the container start: seconds, not milliseconds or minutes.
    expect(readyAt - t0).toBeGreaterThan(1_500);
    expect(readyAt - t0).toBeLessThan(15_000);
    const ps = pods(env);
    expect(new Set(ps.map(nodeOf))).toEqual(new Set(['node01', 'node02']));
    for (const p of ps) {
      const name = String((p.metadata as JsonObject).name);
      const reasons = events(env, name).map((e) => e.reason);
      expect(reasons.filter((r) => r !== 'Scheduled').slice(0, 1)).toEqual(['Pulling']);
      expect(reasons).toEqual(expect.arrayContaining(['Pulling', 'Pulled', 'Created', 'Started']));
      const st = status(p);
      expect((st.podIP as string).startsWith(nodeOf(p) === 'node01' ? '10.244.1.' : '10.244.2.')).toBe(true);
      expect(cs(p).image).toBe('docker.io/library/nginx:1.29');
      expect(String(cs(p).imageID)).toMatch(/^docker\.io\/library\/nginx@sha256:[0-9a-f]{64}$/);
      expect(String(cs(p).containerID)).toMatch(/^containerd:\/\/[0-9a-f]{64}$/);
      expect((st.conditions as JsonObject[]).map((c) => `${String(c.type)}=${String(c.status)}`)).toEqual(['PodReadyToStartContainers=True', 'Initialized=True', 'Ready=True', 'ContainersReady=True', 'PodScheduled=True']);
    }
    // The first Pod on a node pulls; a second one on the same node waits in the serial puller or
    // finds the image present.
    const pulled = ps.flatMap((p) => events(env, String((p.metadata as JsonObject).name)).filter((e) => e.reason === 'Pulled'));
    for (const e of pulled) expect(e.message).toMatch(/^(Successfully pulled image "nginx:1\.29" in [0-9.]+m?s \([0-9.]+m?s including waiting\)\. Image size: \d+ bytes\.|Container image "nginx:1\.29" already present on machine and can be accessed by the pod)$/);
  });

  test('a wrong image tag walks through ErrImagePull and ImagePullBackOff with the back-off between pulls', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('bad', { image: 'nginx:1.299' }));
    const seen = watch(env, 330_000, 100, () => (waiting(pod(env, 'bad'))?.reason as string | undefined) ?? '');
    const reasons = seen.map((s) => s.v);
    expect(reasons.slice(0, 4)).toEqual(['', 'ContainerCreating', 'ErrImagePull', 'ImagePullBackOff']);
    expect(new Set(reasons.slice(2))).toEqual(new Set(['ErrImagePull', 'ImagePullBackOff']));
    const err = 'rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:1.299": failed to resolve reference "docker.io/library/nginx:1.299": docker.io/library/nginx:1.299: not found';
    const p = pod(env, 'bad');
    const w = waiting(p) as JsonObject;
    expect(w.message).toBe(w.reason === 'ErrImagePull' ? err : `Back-off pulling image "nginx:1.299": ErrImagePull: ${err}`);
    // Pull attempts: each waits out the doubled back-off (10 s, 20 s, 40 s, 80 s, 160 s), and the
    // pod worker's requeue (10 s, jitter 0.5) adds at most 15 s.
    const pulls = tracesOf(env, 'kubelet.pull.start', 'bad').map((r) => r.t);
    expect(pulls.length).toBeGreaterThanOrEqual(5);
    const gaps = pulls.slice(1).map((t, i) => t - (pulls[i] as number));
    [10_000, 20_000, 40_000, 80_000].forEach((b, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(b);
      expect(gaps[i]).toBeLessThan(b + 16_000);
    });
    const ev = events(env, 'bad');
    const find = (reason: string, message: string) => ev.find((e) => e.reason === reason && e.message === message);
    expect(find('Pulling', 'Pulling image "nginx:1.299"')?.type).toBe('Normal');
    expect(find('Failed', `Failed to pull image "nginx:1.299": ${err}`)?.type).toBe('Warning');
    expect(find('Failed', 'Error: ErrImagePull')?.type).toBe('Warning');
    expect(find('BackOff', 'Back-off pulling image "nginx:1.299"')?.type).toBe('Normal');
    expect(find('Failed', 'Error: ImagePullBackOff')?.type).toBe('Warning');
    expect(find('Pulling', 'Pulling image "nginx:1.299"')?.count).toBe(pulls.length);
    expect(ev.every((e) => e.fieldPath === 'spec.containers{c}' || e.reason === 'Scheduled')).toBe(true);
  });

  test('an unknown official repository is denied as on Docker Hub; an image outside the catalog is a [sim] gap', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('typo', { image: 'ngnix' }));
    create(env, 'v1/pods', simplePod('other', { image: 'python:3.12' }));
    env.k.advance(5_000);
    // Code Unknown: the kubelet's CRI client strips the gRPC prefix.
    const denied = 'failed to pull and unpack image "docker.io/library/ngnix:latest": failed to resolve reference "docker.io/library/ngnix:latest": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed';
    expect(events(env, 'typo').map((e) => e.message)).toContain(`Failed to pull image "ngnix": ${denied}`);
    expect(String(waiting(pod(env, 'typo'))?.message)).toContain(denied);
    expect(events(env, 'other').map((e) => e.message)).toContain('Failed to pull image "python:3.12": [sim] image docker.io/library/python:3.12 is not in the simulator\'s image catalog');
  });

  test('a container that exits non-zero restarts with the doubling back-off and shows CrashLoopBackOff', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('crash', { image: 'busybox:1.36', command: ['sh', '-c', 'echo starting; exit 3'] }));
    const seen = watch(env, 400_000, 200, () => [cs(pod(env, 'crash')).restartCount, (waiting(pod(env, 'crash'))?.reason as string | undefined) ?? Object.keys((cs(pod(env, 'crash')).state as JsonObject | undefined) ?? {})[0]]);
    const counts = seen.map((s) => (s.v as [number])[0]).filter((x) => x !== undefined);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(5);
    // Restart counts only rise.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(seen.some((s) => (s.v as [number, string])[1] === 'CrashLoopBackOff')).toBe(true);
    const starts = tracesOf(env, 'runtime.container.started', 'crash').map((r) => r.t);
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
    // The first restart is immediate (the PLEG notices within a second); then 10 s, 20 s, 40 s, 80 s
    // after each exit, plus the pod worker's jittered wake-up (at most half the back-off).
    expect(gaps[0]).toBeLessThan(2_000);
    [10_000, 20_000, 40_000, 80_000].forEach((b, i) => {
      expect(gaps[i + 1]).toBeGreaterThanOrEqual(b);
      expect(gaps[i + 1]).toBeLessThan(b * 1.5 + 2_000);
    });
    const p = pod(env, 'crash');
    const last = (cs(p).lastState as JsonObject).terminated as JsonObject;
    expect(last.exitCode).toBe(3);
    expect(last.reason).toBe('Error');
    expect(status(p).phase).toBe('Running');
    const backoff = events(env, 'crash').find((e) => e.reason === 'BackOff') as { message: string; type: string };
    expect(backoff.type).toBe('Warning');
    expect(backoff.message).toBe(`Back-off restarting failed container c in pod crash_default(${String((p?.metadata as JsonObject).uid)})`);
    const w = waiting(p);
    if (w) expect(String(w.message)).toMatch(new RegExp(`^back-off (10s|20s|40s|1m20s|2m40s|5m0s) restarting failed container=c pod=crash_default\\(${String((p?.metadata as JsonObject).uid)}\\)$`));
  });

  test('a container that exits zero under restartPolicy Never ends Completed and the Pod Succeeded', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('once', { image: 'busybox', command: ['sh', '-c', 'echo done'] }, { restartPolicy: 'Never' }));
    env.k.advance(10_000);
    const p = pod(env, 'once');
    expect(status(p).phase).toBe('Succeeded');
    const t = (cs(p).state as JsonObject).terminated as JsonObject;
    expect([t.exitCode, t.reason]).toEqual([0, 'Completed']);
    expect(cs(p).restartCount).toBe(0);
    const conds = (status(p).conditions as JsonObject[]).map((c) => [c.type, c.status, c.reason ?? '']);
    expect(conds).toEqual([
      ['PodReadyToStartContainers', 'False', 'PodSandboxNotReady'],
      ['Initialized', 'True', 'PodCompleted'],
      ['Ready', 'False', 'PodCompleted'],
      ['ContainersReady', 'False', 'PodCompleted'],
      ['PodScheduled', 'True', ''],
    ]);
  });

  test('a missing executable fails at start with runc’s error, RunContainerError, then back-off', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('nocmd', { image: 'busybox:1.36', command: ['nosuch'] }));
    env.k.advance(8_000);
    const p = pod(env, 'nocmd');
    const msg = 'failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "nosuch": executable file not found in $PATH: unknown';
    const failed = events(env, 'nocmd').find((e) => e.reason === 'Failed');
    expect(failed?.message).toBe(`Error: ${msg}`);
    const terminated = ((cs(p).state as JsonObject).terminated ?? (cs(p).lastState as JsonObject).terminated) as JsonObject;
    expect([terminated.exitCode, terminated.reason, terminated.message]).toEqual([128, 'StartError', msg]);
  });

  test('deleting a Pod terminates it gracefully and the ReplicaSet replaces it', () => {
    const env = boot();
    create(env, 'apps/v1/deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sleeper' },
      spec: { replicas: 2, selector: { matchLabels: { app: 's' } }, template: { metadata: { labels: { app: 's' } }, spec: { containers: [{ name: 'sleep', image: 'busybox:1.36', command: ['sleep', '3600'] }] } } },
    });
    env.k.advance(10_000);
    const victim = pods(env)[0] as JsonObject;
    const name = String((victim.metadata as JsonObject).name);
    const tDelete = env.k.now;
    client(env.k, (c) => c.resource('v1/pods').delete('default', name));
    env.k.advance(1_000);
    expect((pod(env, name)?.metadata as JsonObject).deletionTimestamp).toBeDefined();
    expect(pods(env).length).toBe(3);
    const killing = events(env, name).find((e) => e.reason === 'Killing');
    expect(killing).toEqual({ reason: 'Killing', message: 'Stopping container sleep', type: 'Normal', count: 1, fieldPath: 'spec.containers{sleep}' });
    // sleep is PID 1 with no SIGTERM handler: it ignores SIGTERM and is killed after the 30 s grace period.
    env.k.advance(25_000);
    expect(pod(env, name)).toBeDefined();
    env.k.advance(10_000);
    expect(pod(env, name)).toBeUndefined();
    const exit = tracesOf(env, 'runtime.container.exited', name)[0] as TraceRecord;
    expect(exit.t - tDelete).toBeGreaterThanOrEqual(30_000);
    expect(exit.message).toContain('exited with 137');
    env.k.advance(10_000);
    expect(pods(env).filter((p) => status(p).phase === 'Running').length).toBe(2);
  });

  test('nginx logs its startup, and stops at once on its StopSignal (SIGQUIT) when deleted', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('web', { image: 'nginx' }, { nodeName: 'node01' }));
    env.k.advance(10_000);
    const uid = String((pod(env, 'web')?.metadata as JsonObject).uid);
    const read = (): string => env.k.act('read', (ctx) => createFs(ctx, 'node01', { cred: ROOT_CRED, umask: 0o022 }).readFile(`/var/log/pods/default_web_${uid}/c/0.log`));
    const start = read();
    expect(start).toContain('stdout F /docker-entrypoint.sh: Configuration complete; ready for start up');
    expect(start).toMatch(/stderr F \d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \[notice\] 1#1: nginx\/1\.31\.8\n/);
    expect(start).toContain('start worker processes');
    const tDelete = env.k.now;
    client(env.k, (c) => c.resource('v1/pods').delete('default', 'web'));
    env.k.advance(5_000);
    expect(pod(env, 'web')).toBeUndefined();
    const exit = tracesOf(env, 'runtime.container.exited', 'web')[0] as TraceRecord;
    expect(exit.message).toContain('exited with 0');
    expect(exit.t - tDelete).toBeLessThan(1_000);
    expect(tracesOf(env, 'runtime.container.signal', 'web')[0]?.message).toMatch(/^SIGQUIT to container/);
  });

  test('with a kubelet stopped its Pods’ status stops changing; containers keep running and logging', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('ticker', { image: 'busybox:1.36', command: ['sh', '-c', 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 1; done'] }, { nodeName: 'node01' }));
    create(env, 'v1/pods', simplePod('crasher', { image: 'busybox:1.36', command: ['sh', '-c', 'sleep 5; exit 1'] }, { nodeName: 'node01' }));
    env.k.advance(10_000);
    env.k.act('stop', (ctx) => stopKubelet(ctx, 'node01'));
    expect(env.k.act('q', (ctx) => isKubeletRunning(ctx, 'node01'))).toBe(false);
    const before = { ticker: pod(env, 'ticker'), crasher: pod(env, 'crasher') };
    const lease = (): string => String(((client(env.k, (c) => c.resource('coordination.k8s.io/v1/leases').get('kube-node-lease', 'node01')) as { object: JsonObject }).object.spec as JsonObject).renewTime);
    const renewed = lease();
    // Within the node lifecycle controller's grace period nobody writes the Pods (after it, the
    // controller marks them not ready: the next test).
    env.k.advance(40_000);
    expect(pod(env, 'ticker')).toEqual(before.ticker);
    expect(pod(env, 'crasher')).toEqual(before.crasher);
    expect(lease()).toBe(renewed);
    const logPath = `/var/log/pods/default_ticker_${String((before.ticker?.metadata as JsonObject).uid)}/c/0.log`;
    const log = env.k.act('read', (ctx) => createFs(ctx, 'node01', { cred: ROOT_CRED, umask: 0o022 }).readFile(logPath));
    expect(log.split('\n').filter(Boolean).length).toBeGreaterThan(45);
    // Started again, it adopts the running container and restarts the exited one.
    env.k.act('start', (ctx) => startKubelet(ctx, DEFAULT_APISERVER, { name: 'node01', ip: '172.16.0.11', podCIDR: '10.244.1.0/24' }));
    env.k.advance(15_000);
    expect(cs(pod(env, 'ticker')).restartCount).toBe(0);
    expect(Number(cs(pod(env, 'crasher')).restartCount)).toBeGreaterThan(Number(cs(before.crasher).restartCount));
    expect(lease()).not.toBe(renewed);
    expect(events(env, 'node01').map((e) => e.reason)).toEqual(expect.arrayContaining(['Starting', 'NodeAllocatableEnforced']));
  });

  test('a node whose kubelet stops goes Unknown after the grace period and comes back when it starts', () => {
    const env = boot();
    create(env, 'v1/pods', simplePod('w', { image: 'busybox:1.36', command: ['sleep', '3600'] }, { nodeName: 'node02' }));
    env.k.advance(10_000);
    const node = (): JsonObject => (client(env.k, (c) => c.resource('v1/nodes').get(undefined, 'node02')) as { object: JsonObject }).object;
    const ready = (): JsonObject => ((node().status as JsonObject).conditions as JsonObject[]).find((c) => c.type === 'Ready') as JsonObject;
    const podReady = (): string => String(((status(pod(env, 'w')).conditions as JsonObject[]).find((c) => c.type === 'Ready') as JsonObject).status);
    env.k.act('stop', (ctx) => stopKubelet(ctx, 'node02'));
    const stoppedAt = env.k.now;
    const seen = watch(env, 90_000, 500, () => String(ready().status));
    const unknownAt = (seen.find((s) => s.v === 'Unknown') as { t: number }).t;
    // The last renewal was at most 10.4 s before the stop; then 50 s of grace on a 5 s grid.
    expect(unknownAt - stoppedAt).toBeGreaterThan(50_000 - 10_400);
    expect(unknownAt - stoppedAt).toBeLessThanOrEqual(60_500);
    expect([ready().reason, ready().message]).toEqual(['NodeStatusUnknown', 'Kubelet stopped posting node status.']);
    expect(((node().spec as JsonObject).taints as JsonObject[]).map((t) => `${String(t.key)}:${String(t.effect)}`)).toContain('node.kubernetes.io/unreachable:NoSchedule');
    expect(events(env, 'node02').map((e) => `${e.reason} ${e.message}`)).toEqual(expect.arrayContaining(['RegisteredNode Node node02 event: Registered Node node02 in Controller', 'NodeNotReady Node node02 status is now: NodeNotReady']));
    expect(podReady()).toBe('False');
    expect(events(env, 'w').find((e) => e.reason === 'NodeNotReady')).toMatchObject({ type: 'Warning', message: 'Node is not ready' });
    env.k.act('start', (ctx) => startKubelet(ctx, DEFAULT_APISERVER, { name: 'node02', ip: '172.16.0.12', podCIDR: '10.244.2.0/24' }));
    env.k.advance(5_000);
    expect(ready().status).toBe('True');
    expect(((node().spec as JsonObject).taints as JsonObject[] | undefined) ?? []).toEqual([]);
    expect(events(env, 'node02').map((e) => e.reason)).toContain('NodeReady');
    expect(podReady()).toBe('True');
  });

  test('logs appear in the node’s filesystem in the CRI format; the world hash is stable across runs', () => {
    const run = (): { k: Kernel; log: string } => {
      const env = boot(3);
      create(env, 'v1/pods', simplePod('hello', { image: 'busybox:1.36', command: ['sh', '-c', 'echo hello; echo oops >&2; sleep 2; echo bye'] }, { nodeName: 'node02', restartPolicy: 'Never' }));
      env.k.advance(10_000);
      const uid = String((pod(env, 'hello')?.metadata as JsonObject).uid);
      const log = env.k.act('read', (ctx) => createFs(ctx, 'node02', { cred: ROOT_CRED, umask: 0o022 }).readFile(`/var/log/pods/default_hello_${uid}/c/0.log`));
      return { k: env.k, log };
    };
    const a = run();
    const lines = a.log.trimEnd().split('\n');
    expect(lines.map((l) => l.replace(/^\S+ /, ''))).toEqual(['stdout F hello', 'stderr F oops', 'stdout F bye']);
    for (const l of lines) expect(l).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z /);
    // Stamps never go backwards, also within one millisecond.
    const stamps = lines.map((l) => {
      const m = /^(\S+?)(?:\.(\d+))?Z /.exec(l) as RegExpExecArray;
      return `${m[1] as string}.${(m[2] ?? '').padEnd(9, '0')}`;
    });
    expect(stamps).toEqual([...stamps].sort());
    const b = run();
    expect(b.log).toBe(a.log);
    expect(b.k.hash()).toBe(a.k.hash());
  });
});
