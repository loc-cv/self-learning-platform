// kubectl rollout in virtual time: status blocks while the deployment controller and the kubelets
// work, prints the status viewer's line on every event, ends on success, on the progress
// deadline, on --timeout, on deletion and on Ctrl-C (exit 1, nothing printed); restart twice in
// one second is refused. The lines come from upstream source (FIDELITY §6.9: they depend on
// timing): polymorphichelpers/rollout_status.go DeploymentStatusViewer.Status.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, hostPlugin, openSession } from '@simlab/host';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../../../apiserver/config.ts';
import { handle } from '../../../apiserver/pipeline.ts';
import { k8sPlugin } from '../../../plugin.ts';
import { deploymentStatus } from './status.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot() {
  const capture = captureOutput();
  const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
  kernel.advance(10_000);
  const session = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user });
  return { kernel, session };
}

const deployment = (image: string, extra: JsonObject = {}): JsonObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web' },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'web' } },
    template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'nginx', image }] } },
    ...extra,
  },
});

type Kernel = ReturnType<typeof boot>['kernel'];

function create(kernel: Kernel, body: JsonObject): void {
  const r = kernel.act('create', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: 'apps', version: 'v1', resource: 'deployments', namespace: 'default', body }));
  expect(r.ok).toBe(true);
}

const lines = (s: string): string[] => s.split('\n').filter((l) => l !== '');
const unique = (a: string[]): string[] => a.filter((l, i) => i === 0 || a[i - 1] !== l);

describe('kubectl rollout status', () => {
  test('blocks while the rollout runs, prints a line per event, ends when it is done', () => {
    const { kernel, session } = boot();
    create(kernel, deployment('nginx:1.27'));
    session.type('kubectl rollout status deployment/web\n');
    kernel.advance(100);
    // The controller has not observed the new Deployment, or no Pod is available yet.
    expect(session.wait(0)).toBe(false);
    const first = session.take();
    expect(lines(first)[0]).toBe('Waiting for deployment spec update to be observed...');
    expect(session.wait(60_000)).toBe(true);
    const out = unique(lines(first + session.take()));
    expect(out.at(-1)).toBe('deployment "web" successfully rolled out');
    expect(out).toContain('Waiting for deployment "web" rollout to finish: 0 of 2 updated replicas are available...');
    expect(out).toContain('Waiting for deployment "web" rollout to finish: 1 of 2 updated replicas are available...');
    expect(session.run('echo $?').output).toBe('0\n');
  });

  test('a rollout that cannot progress: the deadline error; --timeout; Ctrl-C', () => {
    const { kernel, session } = boot();
    create(kernel, deployment('nginx:1.27', { progressDeadlineSeconds: 30 }));
    kernel.advance(30_000);
    // A tag the registry does not have: the new Pods never start.
    const r = kernel.act('patch', (ctx) =>
      handle(ctx, DEFAULT_APISERVER, {
        verb: 'patch',
        group: 'apps',
        version: 'v1',
        resource: 'deployments',
        namespace: 'default',
        name: 'web',
        body: { spec: { template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.99' }] } } } },
        options: { patchType: 'strategic' },
      }),
    );
    expect(r.ok).toBe(true);
    // --timeout ends the watch first.
    session.type('kubectl rollout status deployment/web --timeout=5s\n');
    expect(session.wait(4_000)).toBe(false);
    expect(session.wait(2_000)).toBe(true);
    const timedOut = lines(session.take());
    expect(timedOut.at(-1)).toBe('error: timed out waiting for the condition');
    expect(session.run('echo $?').output).toBe('1\n');
    // Ctrl-C: exit 1, nothing more printed.
    session.type('kubectl rollout status deployment/web\n');
    kernel.advance(2_000);
    expect(session.wait(0)).toBe(false);
    session.take();
    session.type('\x03');
    expect(session.wait(1_000)).toBe(true);
    expect(session.take()).not.toMatch(/error/);
    expect(session.run('echo $?').output).toBe('1\n');
    // Without either: blocks until the controller marks the deadline exceeded.
    session.type('kubectl rollout status deployment/web\n');
    expect(session.wait(120_000)).toBe(true);
    const out = unique(lines(session.take()));
    expect(out).toContain('Waiting for deployment "web" rollout to finish: 1 out of 2 new replicas have been updated...');
    expect(out.at(-1)).toBe('error: deployment "web" exceeded its progress deadline');
    expect(session.run('echo $?').output).toBe('1\n');
  });

  test('--watch=false prints the current line once; a deleted object ends the watch', () => {
    const { kernel, session } = boot();
    create(kernel, deployment('nginx:1.99'));
    kernel.advance(5_000);
    expect(session.run('kubectl rollout status deployment/web --watch=false').output).toBe('Waiting for deployment "web" rollout to finish: 0 of 2 updated replicas are available...\n');
    session.type('kubectl rollout status deployment/web\n');
    kernel.advance(1_000);
    session.take();
    kernel.act('delete', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'delete', group: 'apps', version: 'v1', resource: 'deployments', namespace: 'default', name: 'web' }));
    expect(session.wait(1_000)).toBe(true);
    expect(lines(session.take()).at(-1)).toBe('error: object has been deleted');
  });
});

describe('kubectl rollout restart', () => {
  test('twice in one second: the second patch is empty and refused', () => {
    const { kernel, session } = boot();
    create(kernel, deployment('nginx:1.27'));
    kernel.advance(20_000);
    expect(session.run('kubectl rollout restart deployment/web').output).toBe('deployment.apps/web restarted\n');
    const again = session.run('kubectl rollout restart deployment/web');
    expect(again.output).toBe(
      'error: failed to create patch for web: if restart has already been triggered within the past second, please wait before attempting to trigger another\n',
    );
    kernel.advance(1_000);
    expect(session.run('kubectl rollout restart deployment/web').output).toBe('deployment.apps/web restarted\n');
    expect(session.run("kubectl get deployment web -o yaml | grep restartedAt").output).toBe('        kubectl.kubernetes.io/restartedAt: "2026-11-13T09:00:31Z"\n');
  });
});

describe('DeploymentStatusViewer.Status', () => {
  const d = (generation: number, st: JsonObject, extra: JsonObject = {}): JsonObject => ({
    metadata: { name: 'web', generation, annotations: { 'deployment.kubernetes.io/revision': '3' } },
    spec: { replicas: 3, ...extra },
    status: st,
  });
  test('each line and error, in upstream order', () => {
    expect(deploymentStatus(d(2, { observedGeneration: 1 }), 0n)).toEqual({ text: 'Waiting for deployment spec update to be observed...\n', done: false });
    expect(deploymentStatus(d(2, { observedGeneration: 2, updatedReplicas: 1, replicas: 4 }), 0n)).toEqual({
      text: 'Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...\n',
      done: false,
    });
    expect(deploymentStatus(d(2, { observedGeneration: 2, updatedReplicas: 3, replicas: 4 }), 0n)).toEqual({
      text: 'Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...\n',
      done: false,
    });
    expect(deploymentStatus(d(2, { observedGeneration: 2, updatedReplicas: 3, replicas: 3, availableReplicas: 2 }), 0n)).toEqual({
      text: 'Waiting for deployment "web" rollout to finish: 2 of 3 updated replicas are available...\n',
      done: false,
    });
    expect(deploymentStatus(d(2, { observedGeneration: 2, updatedReplicas: 3, replicas: 3, availableReplicas: 3 }), 3n)).toEqual({ text: 'deployment "web" successfully rolled out\n', done: true });
    const stuck = d(2, { observedGeneration: 2, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] });
    expect(deploymentStatus(stuck, 0n)).toEqual({ error: { type: 'message', message: 'deployment "web" exceeded its progress deadline' } });
    expect(deploymentStatus(stuck, 2n)).toEqual({ error: { type: 'message', message: 'desired revision (2) is different from the running revision (3)' } });
    const bad = { ...stuck, metadata: { name: 'web', annotations: { 'deployment.kubernetes.io/revision': 'x' } } };
    expect(deploymentStatus(bad, 1n)).toEqual({ error: { type: 'message', message: 'cannot get the revision of deployment "web": strconv.ParseInt: parsing "x": invalid syntax' } });
  });
});
