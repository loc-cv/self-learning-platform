// The Deployment controller in virtual time: creation and scaling, rolling updates within
// maxSurge and maxUnavailable at every instant, rollback, Recreate, proportional scaling,
// hash collisions, the rollback annotation, history cleanup, determinism.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import { computeHash } from '../hash/podtemplate.ts';
import {
  bootWorkloads,
  createDeployment,
  eventLines,
  getDeployment,
  kubectlCreateDeployment,
  patchDeployment,
  pods,
  replicaSets,
  request,
  rolloutStatus,
  rolloutUndo,
  scale,
  setImage,
  waitRolledOut,
  type WorkloadEnv,
} from '../../testing/workloads.ts';

const meta = (o: JsonObject): JsonObject => o.metadata as JsonObject;
const spec = (o: JsonObject): JsonObject => o.spec as JsonObject;
const status = (o: JsonObject): JsonObject => (o.status ?? {}) as JsonObject;
const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
const annotations = (o: JsonObject): JsonObject => (meta(o).annotations ?? {}) as JsonObject;
const hashOf = (rs: JsonObject): string => (meta(rs).labels as JsonObject)['pod-template-hash'] as string;
const imageOf = (o: JsonObject): string => ((((spec(o).template as JsonObject).spec as JsonObject).containers as JsonObject[])[0] as JsonObject).image as string;

const isReady = (p: JsonObject): boolean => ((status(p).conditions ?? []) as JsonObject[]).some((c) => c.type === 'Ready' && c.status === 'True');
const active = (env: WorkloadEnv): JsonObject[] => pods(env).filter((p) => meta(p).deletionTimestamp === undefined && status(p).phase !== 'Failed' && status(p).phase !== 'Succeeded');

describe('creation and scaling', () => {
  test('a Deployment gets one ReplicaSet and its Pods; scaling up and down follows', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 3));
    waitRolledOut(env, 'web');
    expect(replicaSets(env)).toHaveLength(1);
    expect(active(env)).toHaveLength(3);
    expect(active(env).every(isReady)).toBe(true);

    scale(env, 'web', 5);
    waitRolledOut(env, 'web');
    expect(replicaSets(env)).toHaveLength(1);
    expect(n(spec(replicaSets(env)[0] as JsonObject).replicas)).toBe(5);
    expect(active(env)).toHaveLength(5);
    expect(annotations(replicaSets(env)[0] as JsonObject)).toMatchObject({ 'deployment.kubernetes.io/desired-replicas': '5', 'deployment.kubernetes.io/max-replicas': '7' });

    scale(env, 'web', 2);
    waitRolledOut(env, 'web');
    env.k.advance(2_000);
    expect(active(env)).toHaveLength(2);
    expect(pods(env)).toHaveLength(2);
    const name = meta(replicaSets(env)[0] as JsonObject).name as string;
    expect(eventLines(env, 'Deployment')).toEqual([
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${name} from 0 to 3`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${name} from 3 to 5`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set ${name} from 5 to 2`,
    ]);
  });
});

/**
 * Rolls `replicas` Pods to a new image, checking after every millisecond of virtual time that the
 * ReplicaSets' sizes and the active Pods stay within desired + maxSurge and that the available
 * (ready, not terminating) Pods stay at or above desired - maxUnavailable.
 */
function rollWithinBounds(replicas: number, maxSurge: number | string, maxUnavailable: number | string, surge: number, unavailable: number): void {
  // Pods become ready 1.5 s after binding and finish terminating 0.7 s after deletion, so
  // creations, readiness and deletions interleave at many instants.
  const env = bootWorkloads({ kubelet: { readyAfter: 1500, terminateAfter: 700 } });
  createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', replicas, { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge, maxUnavailable } } }));
  waitRolledOut(env, 'web');
  setImage(env, 'web', 'nginx', 'nginx:1.28');
  let maxTotal = 0;
  let minAvailable = Infinity;
  let steps = 0;
  while (rolloutStatus(getDeployment(env, 'web')) !== 'done') {
    env.k.advance(1);
    if (++steps > 120_000) throw new Error('rollout did not finish');
    const rsTotal = replicaSets(env).reduce((s, rs) => s + n(spec(rs).replicas), 0);
    const live = active(env);
    const available = live.filter(isReady).length;
    maxTotal = Math.max(maxTotal, rsTotal, live.length);
    minAvailable = Math.min(minAvailable, available);
    expect(rsTotal).toBeLessThanOrEqual(replicas + surge);
    expect(live.length).toBeLessThanOrEqual(replicas + surge);
    expect(available).toBeGreaterThanOrEqual(replicas - unavailable);
  }
  // The bounds are reached, not just respected.
  expect(maxTotal).toBe(replicas + surge);
  expect(minAvailable).toBe(replicas - unavailable);
  const rss = replicaSets(env);
  expect(rss).toHaveLength(2);
  const cur = rss.find((rs) => imageOf(rs) === 'nginx:1.28') as JsonObject;
  expect(n(spec(cur).replicas)).toBe(replicas);
  expect(active(env).every((p) => (meta(p).labels as JsonObject)['pod-template-hash'] === hashOf(cur))).toBe(true);
}

describe('rolling update', () => {
  test('2 replicas, 25%/25%: surge 1, unavailable 0', () => rollWithinBounds(2, '25%', '25%', 1, 0));
  test('10 replicas, maxSurge 3, maxUnavailable 2', () => rollWithinBounds(10, 3, 2, 3, 2));
  test('4 replicas, maxSurge 0, maxUnavailable 1', () => rollWithinBounds(4, 0, 1, 0, 1));

  test('rollout undo restores the template, reuses the old ReplicaSet and gives it the next revision', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 2));
    waitRolledOut(env, 'web');
    const first = replicaSets(env)[0] as JsonObject;
    setImage(env, 'web', 'nginx', 'nginx:1.28');
    waitRolledOut(env, 'web');
    rolloutUndo(env, 'web');
    waitRolledOut(env, 'web');
    const d = getDeployment(env, 'web');
    expect(imageOf(d)).toBe('nginx:1.27');
    expect(annotations(d)['deployment.kubernetes.io/revision']).toBe('3');
    const rss = replicaSets(env);
    expect(rss).toHaveLength(2);
    const back = rss.find((rs) => meta(rs).uid === meta(first).uid) as JsonObject;
    expect(n(spec(back).replicas)).toBe(2);
    // SetNewReplicaSetAnnotations keeps the replaced revision in revision-history.
    expect(annotations(back)).toMatchObject({ 'deployment.kubernetes.io/revision': '3', 'deployment.kubernetes.io/revision-history': '1' });
    expect(active(env).every((p) => (meta(p).labels as JsonObject)['pod-template-hash'] === hashOf(first))).toBe(true);
  });

  test('scaling in the middle of a rollout spreads the change over both ReplicaSets in proportion', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 10, { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 3, maxUnavailable: 2 } } }));
    waitRolledOut(env, 'web');
    // A template change whose Pods never become ready: the new ReplicaSet gets 3 (13 = 10 + 3),
    // the old one goes down by 2 (to minAvailable 8), the new one up to 5, and there it stays.
    patchDeployment(env, 'web', { spec: { template: { metadata: { annotations: { 'simlab.test/kubelet': 'not-ready' } } } } });
    env.k.advance(10_000);
    const sizes = (): number[] => {
      const rss = replicaSets(env);
      const old = rss.find((rs) => annotations(rs)['deployment.kubernetes.io/revision'] === '1') as JsonObject;
      const cur = rss.find((rs) => annotations(rs)['deployment.kubernetes.io/revision'] === '2') as JsonObject;
      return [n(spec(old).replicas), n(spec(cur).replicas)];
    };
    expect(sizes()).toEqual([8, 5]);
    scale(env, 'web', 20);
    env.k.advance(1_000);
    // sync.go scale: 23 allowed (20 + 3), 10 to add, largest first; getReplicaSetFraction:
    // old round(8·23/13) - 8 = 6, new round(5·23/13) - 5 = 4.
    expect(sizes()).toEqual([14, 9]);
    for (const rs of replicaSets(env)) expect(annotations(rs)).toMatchObject({ 'deployment.kubernetes.io/desired-replicas': '20', 'deployment.kubernetes.io/max-replicas': '23' });
    // And the rollout cannot go on: 23 Pods, 9 of them unavailable, minAvailable 18.
    env.k.advance(5_000);
    expect(sizes()).toEqual([14, 9]);
  });
});

describe('Recreate', () => {
  test('old Pods are all gone before the new ReplicaSet is created', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 3, { strategy: { type: 'Recreate' } }));
    waitRolledOut(env, 'web');
    setImage(env, 'web', 'nginx', 'nginx:1.28');
    let sawGap = false;
    while (rolloutStatus(getDeployment(env, 'web')) !== 'done') {
      env.k.advance(10);
      const ps = pods(env);
      const images = new Set(ps.map((p) => ((spec(p).containers as JsonObject[])[0] as JsonObject).image as string));
      // Never old and new Pods at once, terminating ones included.
      expect(images.size).toBeLessThanOrEqual(1);
      if (ps.length === 0) sawGap = true;
    }
    expect(sawGap).toBe(true);
    const lines = eventLines(env, 'Deployment');
    const [oldRS, newRS] = [...replicaSets(env)].sort((a, b) => (imageOf(a) === 'nginx:1.27' ? -1 : 1) - (imageOf(b) === 'nginx:1.27' ? -1 : 1));
    expect(lines).toEqual([
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${meta(oldRS as JsonObject).name as string} from 0 to 3`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set ${meta(oldRS as JsonObject).name as string} from 3 to 0`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${meta(newRS as JsonObject).name as string} from 0 to 3`,
    ]);
  });
});

describe('getNewReplicaSet', () => {
  test('a name taken by another template raises collisionCount and the next hash is used', () => {
    const env = bootWorkloads();
    const body = kubectlCreateDeployment('web', 'nginx:1.27', 1);
    // An unowned ReplicaSet already holds web-69c6f74b8b with a different template.
    request(env.k, (c) =>
      c.resource('apps/v1/replicasets').create('default', {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: { name: 'web-69c6f74b8b', labels: { other: 'x' } },
        spec: { replicas: 0, selector: { matchLabels: { other: 'x' } }, template: { metadata: { labels: { other: 'x' } }, spec: { containers: [{ name: 'c', image: 'busybox' }] } } },
      }),
    );
    createDeployment(env, body);
    waitRolledOut(env, 'web');
    const d = getDeployment(env, 'web');
    expect(status(d).collisionCount).toBe(1);
    const mine = replicaSets(env).find((rs) => (meta(rs).ownerReferences as JsonObject[] | undefined)?.[0]?.uid === meta(d).uid) as JsonObject;
    expect(hashOf(mine)).toBe(computeHash(spec(d).template as JsonObject, 1));
    expect(meta(mine).name).toBe(`web-${computeHash(spec(d).template as JsonObject, 1)}`);
  });

  test('revisionHistoryLimit: the oldest scaled-down ReplicaSets are deleted', () => {
    const env = bootWorkloads({ kubelet: { readyAfter: 200, terminateAfter: 100 } });
    createDeployment(env, { ...kubectlCreateDeployment('web', 'nginx:1.0', 1), spec: { ...spec(kubectlCreateDeployment('web', 'nginx:1.0', 1)), revisionHistoryLimit: 2 } });
    waitRolledOut(env, 'web');
    for (const v of ['1.1', '1.2', '1.3', '1.4']) {
      setImage(env, 'web', 'nginx', `nginx:${v}`);
      waitRolledOut(env, 'web');
      env.k.advance(500);
    }
    // Revisions 3 and 4 kept as history, 5 current.
    expect(replicaSets(env).map((rs) => annotations(rs)['deployment.kubernetes.io/revision']).sort()).toEqual(['3', '4', '5']);
  });
});

describe('the deprecated.deployment.rollback.to annotation', () => {
  test('rolls back to the previous revision and clears the annotation', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 1));
    waitRolledOut(env, 'web');
    setImage(env, 'web', 'nginx', 'nginx:1.28');
    waitRolledOut(env, 'web');
    patchDeployment(env, 'web', { metadata: { annotations: { 'deprecated.deployment.rollback.to': '0' } } });
    env.k.advance(100);
    const d = getDeployment(env, 'web');
    expect(annotations(d)['deprecated.deployment.rollback.to']).toBeUndefined();
    expect(imageOf(d)).toBe('nginx:1.27');
    waitRolledOut(env, 'web');
    expect(eventLines(env, 'Deployment')).toContain('Normal DeploymentRollback deployment-controller Rolled back deployment "web" to revision 1');
    expect(annotations(getDeployment(env, 'web'))['deployment.kubernetes.io/revision']).toBe('3');
  });

  test('a revision that does not exist: a warning, and the annotation is cleared', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 1));
    waitRolledOut(env, 'web');
    patchDeployment(env, 'web', { metadata: { annotations: { 'deprecated.deployment.rollback.to': '9' } } });
    env.k.advance(100);
    expect(annotations(getDeployment(env, 'web'))['deprecated.deployment.rollback.to']).toBeUndefined();
    expect(eventLines(env, 'Deployment')).toContain('Warning DeploymentRollbackRevisionNotFound deployment-controller Unable to find the revision to rollback to.');
  });
});

describe('determinism', () => {
  test('same seed, same world hash for a full rollout', () => {
    const run = (): string => {
      const env = bootWorkloads({ seed: 42 });
      createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 4));
      env.k.advance(10_000);
      setImage(env, 'web', 'nginx', 'nginx:1.28');
      env.k.advance(30_000);
      expect(rolloutStatus(getDeployment(env, 'web'))).toBe('done');
      return env.k.hash();
    };
    expect(run()).toBe(run());
  });
});

