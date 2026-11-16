// kubectl scale --timeout waits in virtual time until the Scale's status shows the new replicas,
// polling once a second (scale.go WaitForScaleHasDesiredReplicas), and gives up with the real
// error. With the replicaset controller stopped no Pod is created, so the wait runs out.
//   upstream: staging/src/k8s.io/kubectl/pkg/scale/scale.go WaitForScaleHasDesiredReplicas,
//             scaleHasDesiredReplicas (`timed out waiting for %q to be synced`)

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, hostPlugin, openSession } from '@simlab/host';
import { startController, stopController } from '../../../controllers/runtime.ts';
import { DEFAULT_APISERVER } from '../../../apiserver/config.ts';
import { k8sPlugin } from '../../../plugin.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot() {
  const capture = captureOutput();
  const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
  kernel.advance(10_000);
  const session = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user });
  session.run('kubectl create deployment web --image=nginx:1.27');
  kernel.advance(30_000);
  return { kernel, session };
}

describe('kubectl scale --timeout waits in virtual time', () => {
  test('the replicas arrive: kubectl returns within the poll after they do', () => {
    const { kernel, session } = boot();
    const start = kernel.now;
    const r = session.run('kubectl scale deployment web --replicas=3 --timeout=60s');
    expect(r.output).toBe('deployment.apps/web scaled\n');
    expect(r.status).toBe(0);
    expect(kernel.now - start).toBeLessThan(10_000);
    expect(session.run('kubectl get deployment web --no-headers').output).toMatch(/^web +\d\/3 +3 /);
  });

  test('no Pods are created: the wait ends at the timeout with the real error', () => {
    const { kernel, session } = boot();
    kernel.act('stop', (ctx) => stopController(ctx, 'kube-controller-manager', 'replicaset'));
    const start = kernel.now;
    const r = session.run('kubectl scale deployment web --replicas=3 --timeout=5s');
    expect(r.output).toBe('error: timed out waiting for "web" to be synced\n');
    expect(r.status).toBe(1);
    expect(kernel.now - start).toBe(5_000);
    // The scale itself went through; once Pods can be created the replicas come.
    kernel.act('start', (ctx) => startController(ctx, 'kube-controller-manager', 'replicaset', DEFAULT_APISERVER));
    const again = session.run('kubectl scale deployment web --replicas=3 --timeout=30s');
    expect(again.output).toBe('deployment.apps/web scaled\n');
  });

  test('without --timeout, or with a dry run, kubectl does not wait', () => {
    const { kernel, session } = boot();
    kernel.act('stop', (ctx) => stopController(ctx, 'kube-controller-manager', 'replicaset'));
    const start = kernel.now;
    expect(session.run('kubectl scale deployment web --replicas=3').output).toBe('deployment.apps/web scaled\n');
    expect(session.run('kubectl scale deployment web --replicas=4 --timeout=5s --dry-run=server').output).toBe('deployment.apps/web scaled (server dry run)\n');
    expect(kernel.now - start).toBe(0);
  });
});
