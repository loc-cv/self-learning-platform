// The ReplicaSet controller in virtual time: Pods from the template as the golden
// controllers/replicaset-pods case shows them, slow start, adoption and release, the order in
// which Pods are deleted, minReadySeconds.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import { timeOf } from '../../apimachinery/time.ts';
import { DEFAULT_START_TIME } from '@simlab/kernel';
import {
  bootWorkloads,
  createDeployment,
  eventLines,
  getDeployment,
  kubectlCreateDeployment,
  pods,
  replicaSets,
  request,
  scale,
  waitFor,
  waitRolledOut,
  type WorkloadEnv,
} from '../../testing/workloads.ts';
import { getPodsToDelete, slowStartBatch } from './replica_set.ts';
import { calculateStatus } from './replica_set_utils.ts';

const meta = (o: JsonObject): JsonObject => o.metadata as JsonObject;
const status = (o: JsonObject): JsonObject => (o.status ?? {}) as JsonObject;
const nameOf = (o: JsonObject): string => meta(o).name as string;
const isReady = (p: JsonObject): boolean => ((status(p).conditions ?? []) as JsonObject[]).some((c) => c.type === 'Ready' && c.status === 'True');

/** A ReplicaSet of its own (no Deployment), selecting app=<name>. */
function createReplicaSet(env: WorkloadEnv, name: string, replicas: number, extra: JsonObject = {}): JsonObject {
  const r = request(env.k, (c) =>
    c.resource('apps/v1/replicasets').create('default', {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: { name },
      spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: 'c', image: 'nginx:1.27' }] } }, ...extra },
    }),
  );
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.object as JsonObject;
}

const getRS = (env: WorkloadEnv, name: string): JsonObject => replicaSets(env).find((r) => nameOf(r) === name) as JsonObject;

describe('fixtures/golden/v1.37.2/controllers/replicaset-pods.yaml', () => {
  test('the Pods of kubectl create deployment web --image=nginx:1.27 --replicas=3 --port=80, then a scale to 1', () => {
    const env = bootWorkloads();
    const body = kubectlCreateDeployment('web', 'nginx:1.27', 3);
    (((body.spec as JsonObject).template as JsonObject).spec as JsonObject).containers = [{ name: 'nginx', image: 'nginx:1.27', ports: [{ containerPort: 80 }], resources: {} }];
    createDeployment(env, body);
    waitRolledOut(env, 'web');
    const rs = replicaSets(env)[0] as JsonObject;
    const hash = (meta(rs).labels as JsonObject)['pod-template-hash'] as string;
    // The fixture's literal label: the template with a port hashes differently from create-and-read's.
    expect(hash).toBe('557577df75');
    const ps = pods(env);
    expect(ps).toHaveLength(3);
    for (const p of ps) {
      const m = meta(p);
      // fixtures: generateName web-<<hash:1>>-, labels, ownerReferences; no annotations, no finalizers.
      expect(m.generateName).toBe(`web-${hash}-`);
      expect(m.name).toMatch(new RegExp(`^web-${hash}-[bcdfghjklmnpqrstvwxz2456789]{5}$`));
      expect(m.labels).toEqual({ app: 'web', 'pod-template-hash': hash });
      expect(m.ownerReferences).toEqual([{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: `web-${hash}`, uid: meta(rs).uid, controller: true, blockOwnerDeletion: true }]);
      expect(m.annotations).toBeUndefined();
      expect(m.finalizers).toBeUndefined();
      expect(((p.spec as JsonObject).containers as JsonObject[])[0]).toMatchObject({ image: 'nginx:1.27', name: 'nginx', ports: [{ containerPort: 80, protocol: 'TCP' }] });
    }
    // The ReplicaSet's events, one per Pod.
    expect(eventLines(env, 'ReplicaSet').sort()).toEqual(ps.map((p) => `Normal SuccessfulCreate replicaset-controller Created pod: ${nameOf(p)}`).sort());

    // kubectl scale deployment web --replicas=1, then wait for one Pod.
    scale(env, 'web', 1);
    waitRolledOut(env, 'web');
    waitFor(env, () => pods(env).length === 1);
    // The last deletion's watch event reaches the ReplicaSet controller after its latency.
    env.k.advance(100);
    const after = getRS(env, `web-${hash}`);
    expect(meta(after).annotations).toEqual({ 'deployment.kubernetes.io/desired-replicas': '1', 'deployment.kubernetes.io/max-replicas': '2', 'deployment.kubernetes.io/revision': '1' });
    expect(meta(after).generation).toBe(2);
    expect(status(after)).toEqual({ availableReplicas: 1, fullyLabeledReplicas: 1, observedGeneration: 2, readyReplicas: 1, replicas: 1, terminatingReplicas: 0 });
    const d = getDeployment(env, 'web');
    expect(meta(d).generation).toBe(2);
    expect(status(d)).toMatchObject({ availableReplicas: 1, observedGeneration: 2, readyReplicas: 1, replicas: 1, terminatingReplicas: 0, updatedReplicas: 1 });
    expect(((status(d).conditions as JsonObject[]) ?? []).map((c) => c.type)).toEqual(['Available', 'Progressing']);
    expect(eventLines(env, 'Deployment')).toEqual([`Normal ScalingReplicaSet deployment-controller Scaled up replica set web-${hash} from 0 to 3`, `Normal ScalingReplicaSet deployment-controller Scaled down replica set web-${hash} from 3 to 1`]);
    const deleted = ps.map(nameOf).filter((n) => n !== nameOf(pods(env)[0] as JsonObject));
    expect(eventLines(env, 'ReplicaSet').filter((l) => l.includes('SuccessfulDelete')).sort()).toEqual(deleted.map((n) => `Normal SuccessfulDelete replicaset-controller Deleted pod: ${n}`).sort());
  });
});

describe('slowStartBatch', () => {
  test('batches of 1, 2, 4, … and a stop after the first batch with an error', () => {
    const calls: number[] = [];
    let i = 0;
    expect(slowStartBatch(10, 1, () => (calls.push(++i), undefined))).toEqual({ successes: 10 });
    expect(calls).toHaveLength(10);
    // The 4th call fails: its batch (calls 4-7) runs to the end, then nothing more.
    let j = 0;
    const r = slowStartBatch(10, 1, () => (++j === 4 ? { message: 'boom', code: 500, reason: 'InternalError', causes: [] } : undefined));
    expect(j).toBe(7);
    expect(r.successes).toBe(6);
    expect(r.error?.message).toBe('boom');
  });

  test('a ReplicaSet of 7 creates its Pods in one sync, in batches 1, 2, 4', () => {
    const env = bootWorkloads();
    createReplicaSet(env, 'rs', 7);
    env.k.advance(10);
    expect(pods(env)).toHaveLength(7);
    const writes = env.traces.filter((t) => t.source === 'k8s.controller/replicaset' && t.kind === 'controller.write' && t.message.startsWith('create pods '));
    expect(writes).toHaveLength(7);
    expect(new Set(writes.map((w) => w.causes?.[0])).size).toBe(1);
  });
});

/** A Pod as the ranking sees it. */
function pod(name: string, o: { node?: string; phase?: string; readySince?: number; created?: number; restarts?: number; cost?: string; uid?: string }): JsonObject {
  const now = DEFAULT_START_TIME;
  return {
    metadata: { name, namespace: 'default', uid: o.uid ?? name, creationTimestamp: timeOf(now + (o.created ?? 0)), ...(o.cost !== undefined ? { annotations: { 'controller.kubernetes.io/pod-deletion-cost': o.cost } } : {}) },
    spec: { ...(o.node ? { nodeName: o.node } : {}) },
    status: {
      phase: o.phase ?? 'Running',
      conditions: [{ type: 'Ready', status: o.readySince !== undefined ? 'True' : 'False', lastTransitionTime: timeOf(now + (o.readySince ?? 0)) }],
      containerStatuses: [{ name: 'c', restartCount: o.restarts ?? 0 }],
    },
  };
}

describe('getPodsToDelete: controller.ActivePodsWithRanks', () => {
  const now = DEFAULT_START_TIME + 3_600_000;
  const order = (ps: JsonObject[], related: JsonObject[] = ps): string[] => getPodsToDelete([...ps], related, ps.length - 1, now).map(nameOf);

  test('unscheduled, pending, unknown, not ready go first', () => {
    const ready = pod('ready', { node: 'n1', readySince: 0 });
    const notReady = pod('not-ready', { node: 'n1' });
    const unknown = pod('unknown', { node: 'n1', phase: 'Unknown' });
    const pending = pod('pending', { node: 'n1', phase: 'Pending' });
    const unscheduled = pod('unscheduled', { phase: 'Pending' });
    expect(order([ready, notReady, unknown, pending, unscheduled])).toEqual(['unscheduled', 'pending', 'unknown', 'not-ready']);
  });

  test('a lower pod-deletion-cost goes first, then Pods doubled up on a node', () => {
    const a = pod('a', { node: 'n1', readySince: 0 });
    const b = pod('b', { node: 'n2', readySince: 0 });
    const c = pod('c', { node: 'n2', readySince: 0 });
    // b and c share n2: one of them goes first.
    expect(order([a, b, c]).slice(0, 1)).not.toEqual(['a']);
    const cheap = pod('a', { node: 'n1', readySince: 0, cost: '-5' });
    expect(order([cheap, b, c])[0]).toBe('a');
  });

  test('ready for less time, on a logarithmic scale, then more restarts, then newer', () => {
    // Ready 1 minute vs 50 minutes ago: different log2 buckets, the newer goes first.
    const recent = pod('recent', { node: 'n1', readySince: 59 * 60_000 });
    const old = pod('old', { node: 'n2', readySince: 10 * 60_000 });
    expect(order([old, recent])).toEqual(['recent']);
    // Ready times in the same bucket (40 and 41 minutes ago): the lower UID, restarts not consulted.
    const r1 = pod('r1', { node: 'n1', readySince: 19 * 60_000, uid: 'b' });
    const r5 = pod('r5', { node: 'n2', readySince: 20 * 60_000, restarts: 5, uid: 'c' });
    expect(order([r5, r1])).toEqual(['r1']);
    // The same ready time: more restarts go first.
    const s1 = pod('s1', { node: 'n1', readySince: 20 * 60_000, uid: 'a' });
    const s5 = pod('s5', { node: 'n2', readySince: 20 * 60_000, restarts: 5, uid: 'b' });
    expect(order([s1, s5])).toEqual(['s5']);
    // Same ready time, same restarts, creation times in the same bucket: the lower UID.
    const u1 = pod('u1', { node: 'n1', readySince: 20 * 60_000, uid: 'b' });
    const u2 = pod('u2', { node: 'n2', readySince: 20 * 60_000, created: 1_000, uid: 'a' });
    expect(order([u1, u2])).toEqual(['u2']);
    // Identical in every respect: the order given (Go's insertion sort for small lists is stable).
    const v2 = pod('v2', { node: 'n2', readySince: 20 * 60_000, uid: 'a' });
    expect(order([u1, v2])).toEqual(['u1']);
  });

  test('all of them when every Pod goes, in the order given', () => {
    const ps = [pod('x', { node: 'n1', readySince: 0 }), pod('y', {})];
    expect(getPodsToDelete([...ps], ps, 2, now).map(nameOf)).toEqual(['x', 'y']);
  });
});

describe('claiming Pods', () => {
  test('an orphan that matches is adopted, and as the extra Pod it is the one deleted', () => {
    const env = bootWorkloads();
    const rs = createReplicaSet(env, 'rs', 2);
    env.k.advance(5_000);
    expect(pods(env).filter(isReady)).toHaveLength(2);
    // An orphan with the selector's labels that never becomes ready.
    request(env.k, (c) => c.resource('v1/pods').create('default', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'orphan', labels: { app: 'rs' }, annotations: { 'simlab.test/kubelet': 'not-ready' } }, spec: { containers: [{ name: 'c', image: 'nginx:1.27' }] } }));
    env.k.advance(10);
    // Adopted (the controller reference patched in), then deleted as the surplus: it is pending.
    const adopt = env.traces.find((t) => t.kind === 'controller.write' && t.message === 'patch pods default/orphan');
    expect(adopt).toBeDefined();
    env.k.advance(5_000);
    expect(pods(env).map(nameOf)).not.toContain('orphan');
    expect(pods(env)).toHaveLength(2);
    expect(eventLines(env, 'ReplicaSet')).toContain('Normal SuccessfulDelete replicaset-controller Deleted pod: orphan');
    expect(meta(rs).uid).toBe(meta(getRS(env, 'rs')).uid);
  });

  test('an orphan is adopted with a controller reference merged into its ownerReferences', () => {
    const env = bootWorkloads();
    createReplicaSet(env, 'rs', 1);
    env.k.advance(5_000);
    const other = { apiVersion: 'v1', kind: 'ConfigMap', name: 'cm', uid: 'cm-uid' };
    // Scale to 2 first so the orphan is wanted.
    request(env.k, (c) => c.resource('apps/v1/replicasets').patch('default', 'rs', { spec: { replicas: 2 } }));
    request(env.k, (c) => c.resource('v1/pods').create('default', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'orphan', labels: { app: 'rs' }, ownerReferences: [other] }, spec: { containers: [{ name: 'c', image: 'nginx:1.27' }] } }));
    env.k.advance(5_000);
    const o = pods(env).find((p) => nameOf(p) === 'orphan') as JsonObject;
    const rs = getRS(env, 'rs');
    expect(meta(o).ownerReferences).toEqual([other, { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'rs', uid: meta(rs).uid, controller: true, blockOwnerDeletion: true }]);
    expect(pods(env)).toHaveLength(2);
  });

  test('a Pod whose labels stop matching is released and replaced', () => {
    const env = bootWorkloads();
    createReplicaSet(env, 'rs', 2);
    env.k.advance(5_000);
    const victim = nameOf(pods(env)[0] as JsonObject);
    request(env.k, (c) => c.resource('v1/pods').patch('default', victim, { metadata: { labels: { app: 'elsewhere' } } }));
    env.k.advance(5_000);
    const released = pods(env).find((p) => nameOf(p) === victim) as JsonObject;
    expect(meta(released).ownerReferences).toBeUndefined();
    expect(pods(env).filter((p) => (meta(p).labels as JsonObject).app === 'rs')).toHaveLength(2);
    expect(status(getRS(env, 'rs'))).toMatchObject({ replicas: 2, readyReplicas: 2, availableReplicas: 2 });
  });
});

describe('minReadySeconds', () => {
  test('Pods count as available minReadySeconds after they become ready', () => {
    const env = bootWorkloads({ kubelet: { readyAfter: 1000 } });
    createReplicaSet(env, 'rs', 2, { minReadySeconds: 5 });
    waitFor(env, () => (status(getRS(env, 'rs')).readyReplicas ?? 0) === 2, 10);
    const readyAt = env.k.now;
    expect(status(getRS(env, 'rs')).availableReplicas ?? 0).toBe(0);
    // The sync requeues itself for the moment the Pods have been ready 5 s.
    waitFor(env, () => (status(getRS(env, 'rs')).availableReplicas ?? 0) === 2, 10);
    const waited = env.k.now - readyAt;
    expect(waited).toBeGreaterThan(4_000);
    expect(waited).toBeLessThanOrEqual(5_100);
  });
});

describe('calculateStatus: the ReplicaFailure condition', () => {
  test('set on a manageReplicas error (FailedCreate when Pods are missing) and removed once it passes', () => {
    const rs: JsonObject = { metadata: { name: 'rs', generation: 1 }, spec: { replicas: 2, template: { metadata: { labels: { app: 'rs' } } } }, status: { replicas: 0 } };
    const err = { message: 'pods "rs-x" is forbidden: exceeded quota', code: 403, reason: 'Forbidden', causes: [] };
    const failed = calculateStatus(rs, [], [], err, DEFAULT_START_TIME);
    expect(failed.conditions).toEqual([{ type: 'ReplicaFailure', status: 'True', lastTransitionTime: timeOf(DEFAULT_START_TIME), reason: 'FailedCreate', message: err.message }]);
    const withCond = { ...rs, status: { replicas: 0, conditions: failed.conditions as unknown as JsonObject[] } };
    // Still failing: the condition is kept as it was.
    expect(calculateStatus(withCond, [], [], err, DEFAULT_START_TIME + 5000).conditions).toEqual(failed.conditions);
    expect(calculateStatus(withCond, [], [], undefined, DEFAULT_START_TIME + 5000).conditions).toEqual([]);
  });
});
