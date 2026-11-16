// The scheduler against the real v1.37.2 control plane: each scheduling golden case
// (fixtures/golden/cases/scheduling/) replayed on the simulated kubeadm-1cp-2w topology in virtual
// time, and the events of every Pod the case describes compared with the real scheduler's:
// reason and message of each FailedScheduling and Scheduled event, in order, at the same point of
// the case. The PodScheduled conditions of the `objects` steps are compared too.
//
// The oracle's cluster has no kube-system workloads (docs/FIDELITY.md §6.6), the topology has
// CoreDNS on the workers, whose requests would change some fits; each replay deletes the CoreDNS
// Deployment first, so both clusters have the same free capacity.
//
// What `kubectl run --overrides` and `kubectl create -f` send is written out here; kubectl itself
// arrives in phase 07a. The PriorityClass of `preemption` is not served yet (phase 20b), so its
// Pod states preemptionPolicy: Never itself, which the Priority admission plugin would otherwise
// compute; the scheduler sees the same Pod.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Kernel, type TopologySpec } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { createClient, DEFAULT_APISERVER, k8sPlugin } from '@simlab/k8s';
import { repoRoot } from '../oracle/paths.ts';

type Obj = Record<string, unknown>;

const registry = createRegistry([hostPlugin, k8sPlugin]);
const FIXTURES = join(repoRoot, 'fixtures/golden/v1.37.2/scheduling');
const CASES = join(repoRoot, 'fixtures/golden/cases/scheduling');

interface Step {
  run?: string;
  stdout?: string;
  objects?: { ref: string; object: Obj }[];
}

function fixture(name: string): Step[] {
  return (parse(readFileSync(join(FIXTURES, `${name}.yaml`), 'utf8')) as { steps: Step[] }).steps;
}

function caseFiles(name: string): Record<string, Obj[]> {
  const c = parse(readFileSync(join(CASES, `${name}.yaml`), 'utf8')) as { files?: Record<string, string> };
  const out: Record<string, Obj[]> = {};
  for (const [f, text] of Object.entries(c.files ?? {})) out[f] = parseAllDocuments(text).map((d) => d.toJSON() as Obj);
  return out;
}

/** The Events section of a `kubectl describe pod` output: [reason, message] of scheduler events. */
function describedEvents(stdout: string): [string, string][] {
  const out: [string, string][] = [];
  const at = stdout.indexOf('\nEvents:');
  if (at < 0) return out;
  for (const line of stdout.slice(at).split('\n')) {
    const m = /^\s+(Normal|Warning)\s+(Scheduled|FailedScheduling)\s+<<age>>(?: \(x\d+ over <<age>>\))?\s+default-scheduler\s+(.*)$/.exec(line);
    if (m) out.push([m[2] as string, m[3] as string]);
  }
  return out;
}

/** The expected scheduler events of `pod` at its `nth` describe step (0-based). */
function expectedEvents(steps: Step[], pod: string, nth = 0): [string, string][] {
  const describes = steps.filter((s) => s.run === `kubectl describe pod ${pod}`);
  const s = describes[nth];
  if (!s?.stdout) throw new Error(`no describe of ${pod} #${nth}`);
  return describedEvents(s.stdout);
}

/** The PodScheduled condition of `pod` in the nth objects step that lists it. */
function expectedCondition(steps: Step[], pod: string, nth = 0): Obj | undefined {
  const objs = steps.flatMap((s) => (s.objects ?? []).filter((o) => o.ref === `pod/${pod}`));
  const o = objs[nth]?.object as { status?: { conditions?: Obj[] } } | undefined;
  return o?.status?.conditions?.find((c) => c.type === 'PodScheduled');
}

// ---- the simulated cluster ----

interface Env {
  k: Kernel;
}

function boot(): Env {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w');
  if (!spec) throw new Error('no topology kubeadm-1cp-2w');
  k.act('topology', (ctx) => spec.build(ctx, {}));
  k.advance(5_000);
  const env = { k };
  must(env, (c) => c.resource('apps/v1/deployments').delete('kube-system', 'coredns', {}));
  k.advance(5_000);
  // Without a kubelet (phase 06b) the deleted Pods would stay terminating and keep their requests.
  const pods = (must(env, (c) => c.resource('v1/pods').list('kube-system', { labelSelector: 'k8s-app=kube-dns' })).items ?? []) as Obj[];
  for (const p of pods) must(env, (c) => c.resource('v1/pods').delete('kube-system', String(meta(p).name), { gracePeriodSeconds: 0 }));
  k.advance(1_000);
  return env;
}

type C = ReturnType<typeof createClient>;

function must(env: Env, fn: (c: C) => { ok: boolean }): Obj {
  const r = env.k.act('test', (ctx) => fn(createClient(ctx, DEFAULT_APISERVER))) as { ok: boolean; object?: Obj };
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.object as Obj;
}

const meta = (o: Obj): Obj => (o.metadata ?? {}) as Obj;

function createPod(env: Env, pod: Obj): void {
  must(env, (c) => c.resource('v1/pods').create('default', pod as never));
}

/** What `kubectl run NAME --image=nginx:1.27 --overrides=SPEC` creates. */
function kubectlRun(env: Env, name: string, overrides: Obj = {}): void {
  const spec: Obj = { containers: [{ name, image: 'nginx:1.27' }], ...overrides };
  createPod(env, { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels: { run: name } }, spec });
}

function createFile(env: Env, docs: Obj[]): void {
  for (const d of docs) {
    if (d.kind === 'Pod') createPod(env, d);
    else if (d.kind === 'Deployment') must(env, (c) => c.resource('apps/v1/deployments').create('default', d as never));
  }
}

function patchNode(env: Env, name: string, patch: Obj, subresource?: string): void {
  must(env, (c) => c.resource('v1/nodes').patch(undefined, name, patch as never, subresource ? { subresource } : {}));
}

function getNode(env: Env, name: string): Obj {
  return must(env, (c) => c.resource('v1/nodes').get(undefined, name));
}

/** kubectl cordon / uncordon: a merge patch of spec.unschedulable. */
const cordon = (env: Env, node: string, on = true): void => patchNode(env, node, { spec: { unschedulable: on ? true : null } });

/** The scheduler's events about a Pod, oldest first, as [reason, note]. */
function simEvents(env: Env, pod: string): [string, string][] {
  const list = must(env, (c) => c.resource('events.k8s.io/v1/events').list('default'));
  return ((list.items ?? []) as Obj[])
    .filter((e) => (e.regarding as Obj | undefined)?.name === pod && e.reportingController === 'default-scheduler')
    .sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime)))
    .map((e) => [String(e.reason), String(e.note)]);
}

function simCondition(env: Env, pod: string): Obj | undefined {
  const p = must(env, (c) => c.resource('v1/pods').get('default', pod)) as { status?: { conditions?: Obj[] } };
  return p.status?.conditions?.find((c) => c.type === 'PodScheduled');
}

function nodeOf(env: Env, pod: string): string {
  const p = must(env, (c) => c.resource('v1/pods').get('default', pod)) as { spec?: { nodeName?: string } };
  return p.spec?.nodeName ?? '';
}

function sameCondition(sim: Obj | undefined, real: Obj | undefined): void {
  const pick = (c: Obj | undefined) => (c ? { status: c.status, reason: c.reason, message: c.message, observedGeneration: c.observedGeneration } : undefined);
  expect(pick(sim)).toEqual(pick(real));
}

/** Lets the scheduler and controllers react (scheduling takes milliseconds; well under a second). */
const settle = (env: Env): void => env.k.advance(2_000);

describe('scheduler against the golden scheduling cases', () => {
  test('failures: taint, node selector, cpu, memory, both; a toleration fixes the taint case', () => {
    const steps = fixture('failures');
    const env = boot();
    createFile(env, caseFiles('failures')['pods.yaml'] ?? []);
    settle(env);
    for (const pod of ['on-controlplane', 'wants-ssd', 'too-much-cpu', 'too-much-memory', 'too-much-both']) {
      expect(simEvents(env, pod), pod).toEqual(expectedEvents(steps, pod));
    }
    expect(nodeOf(env, 'tolerates')).toBe('controlplane');
    expect(simEvents(env, 'tolerates')).toEqual([['Scheduled', 'Successfully assigned default/tolerates to controlplane']]);
    sameCondition(simCondition(env, 'wants-ssd'), expectedCondition(steps, 'wants-ssd'));
  });

  test('fixed-by-label: a label on node02 schedules the Pod with no further input', () => {
    const steps = fixture('fixed-by-label');
    const env = boot();
    kubectlRun(env, 'picky', { nodeSelector: { disktype: 'ssd' } });
    settle(env);
    patchNode(env, 'node02', { metadata: { labels: { disktype: 'ssd' } } });
    settle(env);
    expect(simEvents(env, 'picky')).toEqual(expectedEvents(steps, 'picky'));
    expect(nodeOf(env, 'picky')).toBe('node02');
  });

  test('fixed-by-untaint: removing the control-plane taint schedules the Pod', () => {
    const steps = fixture('fixed-by-untaint');
    const env = boot();
    kubectlRun(env, 'on-cp', { nodeSelector: { 'node-role.kubernetes.io/control-plane': '' } });
    settle(env);
    expect(simEvents(env, 'on-cp')).toEqual(expectedEvents(steps, 'on-cp', 0));
    patchNode(env, 'controlplane', { spec: { taints: null } });
    settle(env);
    expect(simEvents(env, 'on-cp')).toEqual(expectedEvents(steps, 'on-cp', 1));
    sameCondition(simCondition(env, 'on-cp'), expectedCondition(steps, 'on-cp'));
  });

  test('cordoned: both workers cordoned, then node01 uncordoned (one more failure while the taint lingers)', () => {
    const steps = fixture('cordoned');
    const env = boot();
    cordon(env, 'node01');
    cordon(env, 'node02');
    settle(env);
    // The node lifecycle controller tainted both nodes.
    for (const n of ['node01', 'node02']) {
      const taints = ((getNode(env, n).spec as Obj).taints ?? []) as Obj[];
      expect(taints.map((t) => `${String(t.key)}:${String(t.effect)}`)).toEqual(['node.kubernetes.io/unschedulable:NoSchedule']);
    }
    kubectlRun(env, 'waits');
    settle(env);
    expect(simEvents(env, 'waits')).toEqual(expectedEvents(steps, 'waits', 0));
    sameCondition(simCondition(env, 'waits'), expectedCondition(steps, 'waits', 0));
    cordon(env, 'node01', false);
    settle(env);
    expect(simEvents(env, 'waits')).toEqual(expectedEvents(steps, 'waits', 1));
    expect(nodeOf(env, 'waits')).toBe('node01');
  });

  test('mixed-reasons: a different reason on each node', () => {
    const steps = fixture('mixed-reasons');
    const env = boot();
    cordon(env, 'node01');
    settle(env);
    kubectlRun(env, 'mem-fill', { nodeSelector: { 'kubernetes.io/hostname': 'node02' }, containers: [{ name: 'fill', image: 'nginx:1.27', resources: { requests: { memory: '3Gi' } } }] });
    settle(env);
    kubectlRun(env, 'mem-1gi', { containers: [{ name: 'app', image: 'nginx:1.27', resources: { requests: { memory: '1Gi' } } }] });
    kubectlRun(env, 'mem-8gi', { containers: [{ name: 'app', image: 'nginx:1.27', resources: { requests: { memory: '8Gi' } } }] });
    settle(env);
    for (const pod of ['mem-1gi', 'mem-8gi']) {
      expect(simEvents(env, pod), pod).toEqual(expectedEvents(steps, pod));
      sameCondition(simCondition(env, pod), expectedCondition(steps, pod));
    }
  });

  test('host-ports: the second Pod waits for the port and gets it when the first is deleted', () => {
    const steps = fixture('host-ports');
    const env = boot();
    const files = caseFiles('host-ports');
    createFile(env, files['web-a.yaml'] ?? []);
    settle(env);
    createFile(env, files['web-b.yaml'] ?? []);
    settle(env);
    expect(simEvents(env, 'web-b')).toEqual(expectedEvents(steps, 'web-b'));
    sameCondition(simCondition(env, 'web-b'), expectedCondition(steps, 'web-b', 0));
    must(env, (c) => c.resource('v1/pods').delete('default', 'web-a', { gracePeriodSeconds: 0 }));
    settle(env);
    expect(nodeOf(env, 'web-b')).toBe('node01');
    expect(simEvents(env, 'web-b').at(-1)).toEqual(['Scheduled', 'Successfully assigned default/web-b to node01']);
  });

  test('preemption: no victims for a Pod that fits allocatable, not eligible with preemptionPolicy Never', () => {
    const steps = fixture('preemption');
    const env = boot();
    for (const n of ['node01', 'node02']) {
      kubectlRun(env, `fill-${n}`, { nodeSelector: { 'kubernetes.io/hostname': n }, containers: [{ name: 'fill', image: 'nginx:1.27', resources: { requests: { cpu: '1500m' } } }] });
    }
    settle(env);
    const docs = (caseFiles('preemption')['pods.yaml'] ?? []).filter((d) => d.kind === 'Pod');
    for (const d of docs) {
      const spec = { ...(d.spec as Obj) };
      if (spec.priorityClassName) {
        delete spec.priorityClassName;
        spec.preemptionPolicy = 'Never';
      }
      createPod(env, { ...d, spec });
    }
    settle(env);
    for (const pod of ['cpu-1', 'cpu-1-never']) expect(simEvents(env, pod), pod).toEqual(expectedEvents(steps, pod));
    must(env, (c) => c.resource('v1/pods').delete('default', 'fill-node02', { gracePeriodSeconds: 0 }));
    settle(env);
    expect(nodeOf(env, 'cpu-1')).toBe('node02');
    expect(nodeOf(env, 'cpu-1-never')).toBe('node02');
  });

  test('extended-resources: none offered, then offered by node01, then exhausted', () => {
    const steps = fixture('extended-resources');
    const env = boot();
    const files = caseFiles('extended-resources');
    createFile(env, files['dongle-1.yaml'] ?? []);
    settle(env);
    expect(simEvents(env, 'dongle-1')).toEqual(expectedEvents(steps, 'dongle-1').slice(0, 1));
    patchNode(env, 'node01', { status: { capacity: { 'example.com/dongle': '2' }, allocatable: { 'example.com/dongle': '2' } } }, 'status');
    settle(env);
    expect(simEvents(env, 'dongle-1').at(-1)).toEqual(['Scheduled', 'Successfully assigned default/dongle-1 to node01']);
    createFile(env, files['more.yaml'] ?? []);
    settle(env);
    for (const pod of ['dongle-2', 'dongle-3']) {
      expect(simEvents(env, pod), pod).toEqual(expectedEvents(steps, pod));
      sameCondition(simCondition(env, pod), expectedCondition(steps, pod));
    }
  });

  test('node-affinity: unmatched required affinity, a nonexistent node in matchFields, preferred placement', () => {
    const steps = fixture('node-affinity');
    const env = boot();
    const files = caseFiles('node-affinity');
    createFile(env, files['prefers.yaml'] ?? []);
    settle(env);
    const pods = ((must(env, (c) => c.resource('v1/pods').list('default')).items ?? []) as Obj[]).filter((p) => String(meta(p).name).startsWith('prefers-node02-'));
    expect(pods.length).toBe(4);
    for (const p of pods) expect((p.spec as Obj).nodeName).toBe('node02');
    createFile(env, files['pods.yaml'] ?? []);
    settle(env);
    for (const pod of ['affinity-ssd', 'affinity-node03']) {
      expect(simEvents(env, pod), pod).toEqual(expectedEvents(steps, pod));
      sameCondition(simCondition(env, pod), expectedCondition(steps, pod));
    }
  });
});
