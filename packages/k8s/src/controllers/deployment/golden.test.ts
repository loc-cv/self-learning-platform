// The Deployment and ReplicaSet controllers against the real v1.37.2 control plane: the golden
// cases replayed in virtual time, with the stored objects and events compared to the captures.
//
// Kubelet timing: the fake kubelet makes a Pod ready 2 s after binding and finishes a graceful
// deletion 1 s after the request. None of the compared sequences depends on it: with maxSurge 1 and
// maxUnavailable 0 (2 replicas) or 1 (4 replicas) each step waits for the previous one's Pods, so
// the interleaving is the same for any readiness delay; it only stretches the timeline.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import {
  bootWorkloads,
  createDeployment,
  eventLines,
  events,
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
  waitFor,
  waitRolledOut,
  type WorkloadEnv,
} from '../../testing/workloads.ts';

/** The fixtures' normalization (docs/FIDELITY.md §6): times, resourceVersions and uids as tokens. */
function normalize(obj: JsonObject, uids: Record<string, string>): JsonObject {
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    if (typeof v !== 'string') return v;
    if (key === 'creationTimestamp' || key === 'lastUpdateTime' || key === 'lastTransitionTime' || key === 'firstTimestamp' || key === 'lastTimestamp') return '<<time>>';
    if (key === 'resourceVersion') return '<<rv>>';
    if (key === 'uid') return uids[v] ?? v;
    return v;
  };
  return walk(obj) as JsonObject;
}

const uidOf = (o: JsonObject): string => (o.metadata as JsonObject).uid as string;
const nameOf = (o: JsonObject): string => (o.metadata as JsonObject).name as string;
const hashOf = (rs: JsonObject): string => ((rs.metadata as JsonObject).labels as JsonObject)['pod-template-hash'] as string;
const rsNamed = (env: WorkloadEnv, name: string): JsonObject => replicaSets(env).find((r) => nameOf(r) === name) as JsonObject;

/** The template kubectl create deployment web --image=nginx:1.27 leaves after defaulting (fixtures). */
const TEMPLATE_SPEC_127 = {
  containers: [{ image: 'nginx:1.27', imagePullPolicy: 'IfNotPresent', name: 'nginx', resources: {}, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File' }],
  dnsPolicy: 'ClusterFirst',
  restartPolicy: 'Always',
  schedulerName: 'default-scheduler',
  securityContext: {},
  terminationGracePeriodSeconds: 30,
};

const DEPLOYMENT_SPEC = (replicas: number, extra: JsonObject = {}): JsonObject => ({
  progressDeadlineSeconds: 600,
  replicas,
  revisionHistoryLimit: 10,
  selector: { matchLabels: { app: 'web' } },
  strategy: { rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' }, type: 'RollingUpdate' },
  template: { metadata: { labels: { app: 'web' } }, spec: TEMPLATE_SPEC_127 },
  ...extra,
});

const cond = (type: string, status: string, reason: string, message: string): JsonObject => ({ lastTransitionTime: '<<time>>', lastUpdateTime: '<<time>>', message, reason, status, type });
const AVAILABLE = cond('Available', 'True', 'MinimumReplicasAvailable', 'Deployment has minimum availability.');
const progressed = (rs: string): JsonObject => cond('Progressing', 'True', 'NewReplicaSetAvailable', `ReplicaSet "${rs}" has successfully progressed.`);

describe('fixtures/golden/v1.37.2/deployments/create-and-read.yaml', () => {
  test('kubectl create deployment web --image=nginx:1.27 --replicas=3: the Deployment and its ReplicaSet', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 3));
    waitRolledOut(env, 'web');
    const d = getDeployment(env, 'web');
    const rss = replicaSets(env);
    expect(rss).toHaveLength(1);
    // A list's items carry no kind; kubectl get -o yaml prints them with it.
    const rs = { apiVersion: 'apps/v1', kind: 'ReplicaSet', ...(rss[0] as JsonObject) };
    const uids = { [uidOf(d)]: '<<uid:1>>', [uidOf(rs)]: '<<uid:2>>' };
    // fixtures/golden/v1.37.2/deployments/create-and-read.yaml, the objects step.
    expect(normalize(d, uids)).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { annotations: { 'deployment.kubernetes.io/revision': '1' }, creationTimestamp: '<<time>>', generation: 1, labels: { app: 'web' }, name: 'web', namespace: 'default', resourceVersion: '<<rv>>', uid: '<<uid:1>>' },
      spec: DEPLOYMENT_SPEC(3),
      status: { availableReplicas: 3, conditions: [AVAILABLE, progressed('web-69c6f74b8b')], observedGeneration: 1, readyReplicas: 3, replicas: 3, terminatingReplicas: 0, updatedReplicas: 3 },
    });
    expect(normalize(rs, uids)).toEqual({
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        annotations: { 'deployment.kubernetes.io/desired-replicas': '3', 'deployment.kubernetes.io/max-replicas': '4', 'deployment.kubernetes.io/revision': '1' },
        creationTimestamp: '<<time>>',
        generation: 1,
        labels: { app: 'web', 'pod-template-hash': '69c6f74b8b' },
        name: 'web-69c6f74b8b',
        namespace: 'default',
        ownerReferences: [{ apiVersion: 'apps/v1', blockOwnerDeletion: true, controller: true, kind: 'Deployment', name: 'web', uid: '<<uid:1>>' }],
        resourceVersion: '<<rv>>',
        uid: '<<uid:2>>',
      },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'web', 'pod-template-hash': '69c6f74b8b' } },
        template: { metadata: { labels: { app: 'web', 'pod-template-hash': '69c6f74b8b' } }, spec: TEMPLATE_SPEC_127 },
      },
      status: { availableReplicas: 3, fullyLabeledReplicas: 3, observedGeneration: 1, readyReplicas: 3, replicas: 3, terminatingReplicas: 0 },
    });
    // describe deployment web / describe rs: the events.
    expect(eventLines(env, 'Deployment')).toEqual(['Normal ScalingReplicaSet deployment-controller Scaled up replica set web-69c6f74b8b from 0 to 3']);
    const podNames = pods(env).map(nameOf);
    expect(podNames).toHaveLength(3);
    expect(eventLines(env, 'ReplicaSet').sort()).toEqual(podNames.map((n) => `Normal SuccessfulCreate replicaset-controller Created pod: ${n}`).sort());
  });
});

describe('fixtures/golden/v1.37.2/deployments/rollout.yaml', () => {
  test('set image, undo and scale: events, revisions, ReplicaSets and the final Deployment', () => {
    const env = bootWorkloads();
    // setup
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 2));
    waitRolledOut(env, 'web');
    const first = replicaSets(env)[0] as JsonObject;
    const hash2 = hashOf(first); // the fixture's <<hash:2>>: the nginx:1.27 template
    expect(hash2).toBe('69c6f74b8b');

    setImage(env, 'web', 'nginx', 'nginx:1.28');
    waitRolledOut(env, 'web');
    expect(rolloutStatus(getDeployment(env, 'web'))).toBe('done');
    const second = replicaSets(env).find((r) => hashOf(r) !== hash2) as JsonObject;
    const hash1 = hashOf(second);
    // kubectl rollout history: revisions 1 and 2.
    const rev = (r: JsonObject): string => ((r.metadata as JsonObject).annotations as JsonObject)['deployment.kubernetes.io/revision'] as string;
    expect(rev(rsNamed(env, `web-${hash2}`))).toBe('1');
    expect(rev(rsNamed(env, `web-${hash1}`))).toBe('2');
    // kubectl get rs: web-<<hash:2>> 0 0 0, web-<<hash:1>> 2 2 2.
    const counts = (r: JsonObject): number[] => [(r.spec as JsonObject).replicas as number, ((r.status as JsonObject).replicas as number | undefined) ?? 0, ((r.status as JsonObject).readyReplicas as number | undefined) ?? 0];
    expect(counts(rsNamed(env, `web-${hash2}`))).toEqual([0, 0, 0]);
    expect(counts(rsNamed(env, `web-${hash1}`))).toEqual([2, 2, 2]);
    // kubectl describe deployment web: replicas, conditions, events.
    const d2 = getDeployment(env, 'web');
    const st2 = d2.status as JsonObject;
    expect([st2.replicas, st2.updatedReplicas, st2.availableReplicas, st2.unavailableReplicas ?? 0]).toEqual([2, 2, 2, 0]);
    expect(((st2.conditions as JsonObject[]) ?? []).map((c) => [c.type, c.status, c.reason])).toEqual([
      ['Available', 'True', 'MinimumReplicasAvailable'],
      ['Progressing', 'True', 'NewReplicaSetAvailable'],
    ]);
    expect(eventLines(env, 'Deployment')).toEqual([
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set web-${hash2} from 0 to 2`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set web-${hash1} from 0 to 1`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set web-${hash2} from 2 to 1`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set web-${hash1} from 1 to 2`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set web-${hash2} from 1 to 0`,
    ]);

    // kubectl rollout undo: the old ReplicaSet comes back as revision 3; history shows 2 and 3.
    rolloutUndo(env, 'web');
    waitRolledOut(env, 'web');
    expect(replicaSets(env).map(nameOf).sort()).toEqual([`web-${hash1}`, `web-${hash2}`].sort());
    expect(uidOf(rsNamed(env, `web-${hash2}`))).toBe(uidOf(first));
    expect(rev(rsNamed(env, `web-${hash2}`))).toBe('3');
    expect(rev(rsNamed(env, `web-${hash1}`))).toBe('2');

    // kubectl scale deployment web --replicas=4
    scale(env, 'web', 4);
    waitRolledOut(env, 'web');
    const d = getDeployment(env, 'web');
    // the objects step
    expect(normalize(d, { [uidOf(d)]: '<<uid:1>>' })).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { annotations: { 'deployment.kubernetes.io/revision': '3' }, creationTimestamp: '<<time>>', generation: 4, labels: { app: 'web' }, name: 'web', namespace: 'default', resourceVersion: '<<rv>>', uid: '<<uid:1>>' },
      spec: DEPLOYMENT_SPEC(4),
      status: { availableReplicas: 4, conditions: [progressed(`web-${hash2}`), AVAILABLE], observedGeneration: 4, readyReplicas: 4, replicas: 4, terminatingReplicas: 0, updatedReplicas: 4 },
    });
  });
});

describe('fixtures/golden/v1.37.2/controllers/rollout-stuck.yaml', () => {
  test('new Pods that never become ready stop the rollout at old 3, new 2, with ProgressDeadlineExceeded', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 4));
    waitRolledOut(env, 'web');
    // The fixture's annotation makes KWOK keep the Pods not ready; the fake kubelet's does the same.
    patchDeployment(env, 'web', { spec: { progressDeadlineSeconds: 10, template: { metadata: { annotations: { 'simlab.test/kubelet': 'not-ready' } } } } });
    const waited = waitFor(env, () => rolloutStatus(getDeployment(env, 'web')) === 'deadline', 100, 60_000);
    // The deadline counts from the last progress (the second new Pod's creation), plus the
    // requeue's extra second at most.
    expect(waited).toBeGreaterThanOrEqual(10_000);
    expect(waited).toBeLessThanOrEqual(13_000);

    const d = getDeployment(env, 'web');
    const rss = replicaSets(env);
    const old = rss.find((r) => hashOf(r) === '69c6f74b8b') as JsonObject;
    const cur = rss.find((r) => hashOf(r) !== '69c6f74b8b') as JsonObject;
    const uids = { [uidOf(d)]: '<<uid:1>>', [uidOf(old)]: '<<uid:2>>', [uidOf(cur)]: '<<uid:3>>' };
    const nd = normalize(d, uids);
    expect(nd.metadata).toEqual({ annotations: { 'deployment.kubernetes.io/revision': '2' }, creationTimestamp: '<<time>>', generation: 2, labels: { app: 'web' }, name: 'web', namespace: 'default', resourceVersion: '<<rv>>', uid: '<<uid:1>>' });
    expect(nd.status).toEqual({
      availableReplicas: 3,
      conditions: [AVAILABLE, cond('Progressing', 'False', 'ProgressDeadlineExceeded', `ReplicaSet "${nameOf(cur)}" has timed out progressing.`)],
      observedGeneration: 2,
      readyReplicas: 3,
      replicas: 5,
      terminatingReplicas: 0,
      unavailableReplicas: 2,
      updatedReplicas: 2,
    });
    const no = normalize(old, uids);
    expect((no.metadata as JsonObject).annotations).toEqual({ 'deployment.kubernetes.io/desired-replicas': '4', 'deployment.kubernetes.io/max-replicas': '5', 'deployment.kubernetes.io/revision': '1' });
    expect((no.metadata as JsonObject).generation).toBe(2);
    expect((no.spec as JsonObject).replicas).toBe(3);
    expect(no.status).toEqual({ availableReplicas: 3, fullyLabeledReplicas: 3, observedGeneration: 2, readyReplicas: 3, replicas: 3, terminatingReplicas: 0 });
    const nc = normalize(cur, uids);
    expect((nc.metadata as JsonObject).annotations).toEqual({ 'deployment.kubernetes.io/desired-replicas': '4', 'deployment.kubernetes.io/max-replicas': '5', 'deployment.kubernetes.io/revision': '2' });
    expect((nc.metadata as JsonObject).generation).toBe(2);
    expect((nc.metadata as JsonObject).ownerReferences).toEqual([{ apiVersion: 'apps/v1', blockOwnerDeletion: true, controller: true, kind: 'Deployment', name: 'web', uid: '<<uid:1>>' }]);
    expect((nc.spec as JsonObject).replicas).toBe(2);
    expect(nc.status).toEqual({ fullyLabeledReplicas: 2, observedGeneration: 2, replicas: 2, terminatingReplicas: 0 });
    // describe deployment web: the events (ProgressDeadlineExceeded records none).
    expect(eventLines(env, 'Deployment')).toEqual([
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${nameOf(old)} from 0 to 4`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${nameOf(cur)} from 0 to 1`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set ${nameOf(old)} from 4 to 3`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${nameOf(cur)} from 1 to 2`,
    ]);
    // Once timed out, nothing more happens.
    env.k.advance(30_000);
    expect(eventLines(env, 'Deployment')).toHaveLength(4);
    expect(replicaSets(env).map((r) => (r.spec as JsonObject).replicas)).toEqual(rss.map((r) => (r.spec as JsonObject).replicas));
  });
});

describe('fixtures/golden/v1.37.2/controllers/paused.yaml', () => {
  test('pause, a template change that starts no rollout, resume', () => {
    const env = bootWorkloads();
    createDeployment(env, kubectlCreateDeployment('web', 'nginx:1.27', 2));
    waitRolledOut(env, 'web');
    // kubectl rollout pause
    patchDeployment(env, 'web', { spec: { paused: true } });
    waitFor(env, () => ((getDeployment(env, 'web').status as JsonObject).conditions as JsonObject[]).some((c) => c.reason === 'DeploymentPaused'));
    const paused = getDeployment(env, 'web');
    expect(normalize(paused.status as JsonObject, {})).toEqual({
      availableReplicas: 2,
      conditions: [AVAILABLE, cond('Progressing', 'Unknown', 'DeploymentPaused', 'Deployment is paused')],
      observedGeneration: 2,
      readyReplicas: 2,
      replicas: 2,
      terminatingReplicas: 0,
      updatedReplicas: 2,
    });
    // kubectl set image while paused: observed, but no new ReplicaSet.
    setImage(env, 'web', 'nginx', 'nginx:1.28');
    waitFor(env, () => {
      const d = getDeployment(env, 'web');
      return (d.metadata as JsonObject).generation === (d.status as JsonObject).observedGeneration;
    });
    env.k.advance(5_000);
    expect(replicaSets(env)).toHaveLength(1);
    const st = getDeployment(env, 'web').status as JsonObject;
    // rollout status --watch=false: "0 out of 2 new replicas have been updated..."
    expect(st.updatedReplicas ?? 0).toBe(0);
    expect(normalize(((st.conditions as JsonObject[]).find((c) => c.type === 'Progressing') as JsonObject), {})).toEqual(cond('Progressing', 'Unknown', 'DeploymentPaused', 'Deployment is paused'));
    // kubectl rollout resume
    patchDeployment(env, 'web', { spec: { paused: null } });
    waitRolledOut(env, 'web');
    // rollout status returns once the last old Pod is terminating; the fixture's next commands
    // (a resume that fails, get rs) take long enough for KWOK to finish it: terminatingReplicas 0.
    env.k.advance(2_000);
    const d = getDeployment(env, 'web');
    const rss = replicaSets(env);
    const old = rss.find((r) => hashOf(r) === '69c6f74b8b') as JsonObject;
    const cur = rss.find((r) => hashOf(r) !== '69c6f74b8b') as JsonObject;
    expect([(old.spec as JsonObject).replicas, (cur.spec as JsonObject).replicas]).toEqual([0, 2]);
    expect(((d.metadata as JsonObject).annotations as JsonObject)['deployment.kubernetes.io/revision']).toBe('2');
    expect((d.metadata as JsonObject).generation).toBe(4);
    expect(normalize(d.status as JsonObject, {})).toEqual({
      availableReplicas: 2,
      conditions: [AVAILABLE, progressed(nameOf(cur))],
      observedGeneration: 4,
      readyReplicas: 2,
      replicas: 2,
      terminatingReplicas: 0,
      updatedReplicas: 2,
    });
    // The events, in the order they happened (pause and resume record none).
    expect(eventLines(env, 'Deployment')).toEqual([
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${nameOf(old)} from 0 to 2`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${nameOf(cur)} from 0 to 1`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set ${nameOf(old)} from 2 to 1`,
      `Normal ScalingReplicaSet deployment-controller Scaled up replica set ${nameOf(cur)} from 1 to 2`,
      `Normal ScalingReplicaSet deployment-controller Scaled down replica set ${nameOf(old)} from 1 to 0`,
    ]);
    expect(events(env).filter((e) => (e.involvedObject as JsonObject).kind === 'Deployment').every((e) => e.count === 1)).toBe(true);
  });
});

describe('fixtures/golden/v1.37.2/controllers/gc-orphan-foreground.yaml', () => {
  test('a foreground delete held by a Pod finalizer: the status of a Deployment being deleted (syncStatusOnly)', () => {
    const env = bootWorkloads({ controllers: ['deployment', 'replicaset', 'garbage-collector'] });
    createDeployment(env, kubectlCreateDeployment('fg', 'nginx:1.27', 1));
    waitRolledOut(env, 'fg');
    const pod = pods(env)[0] as JsonObject;
    request(env.k, (c) => c.resource('v1/pods').patch('default', nameOf(pod), { metadata: { finalizers: ['example.com/hold'] } }));
    request(env.k, (c) => c.resource('apps/v1/deployments').delete('default', 'fg', { propagationPolicy: 'Foreground' }));
    waitFor(env, () => {
      const st = (getDeployment(env, 'fg').status ?? {}) as JsonObject;
      return st.terminatingReplicas === 1 && ((st.conditions ?? []) as JsonObject[]).some((c) => c.type === 'Available' && c.status === 'False');
    });
    const d = getDeployment(env, 'fg');
    expect((d.metadata as JsonObject).finalizers).toEqual(['foregroundDeletion']);
    expect(normalize(d.status as JsonObject, {})).toEqual({
      conditions: [progressed(nameOf(replicaSets(env)[0] as JsonObject)), cond('Available', 'False', 'MinimumReplicasUnavailable', 'Deployment does not have minimum availability.')],
      observedGeneration: 2,
      terminatingReplicas: 1,
      unavailableReplicas: 1,
    });
    const rs = replicaSets(env)[0] as JsonObject;
    expect((rs.spec as JsonObject).replicas).toBe(1);
    expect(rs.status).toEqual({ observedGeneration: 2, replicas: 0, terminatingReplicas: 1 });
  });
});
