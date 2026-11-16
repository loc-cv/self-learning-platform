// kubectl delete waits in virtual time until each deleted object is gone (--wait, the default):
// a Pod whose container ignores SIGTERM takes its grace period, and kubectl returns when the
// kubelet has killed it and the Pod is removed. --timeout ends the wait with the real error, Ctrl-C
// with status 1 and nothing printed, --wait=false not at all.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/delete/delete.go DeleteResult;
//             staging/src/k8s.io/kubectl/pkg/cmd/wait/delete.go IsDeleted, condition.go
//             extendErrWaitTimeout; staging/src/k8s.io/kubectl/pkg/util/interrupt (exit 1)
//   the timeout's text: fixtures/golden/v1.37.2/delete/options.yaml

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, hostPlugin, openSession } from '@simlab/host';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import type { ApiResponse } from '../../apiserver/types.ts';
import type { JsonObject } from '../../apimachinery/json.ts';
import { k8sPlugin } from '../../plugin.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

/** A Pod whose container is `sleep` as PID 1: it ignores SIGTERM, so it lives out its grace period. */
const sleeper = (name: string, grace?: number): JsonObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name },
  spec: { ...(grace !== undefined ? { terminationGracePeriodSeconds: grace } : {}), containers: [{ name: 'sleep', image: 'busybox:1.37', command: ['sleep', '3600'] }] },
});

function boot(...pods: JsonObject[]) {
  const capture = captureOutput();
  const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
  kernel.advance(10_000);
  for (const body of pods) kernel.act('create', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body }));
  kernel.advance(30_000);
  const session = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user });
  const getPod = (name: string): ApiResponse =>
    kernel.act('get', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'get', group: '', version: 'v1', resource: 'pods', namespace: 'default', name })) as ApiResponse;
  return { kernel, session, getPod };
}

describe('kubectl delete waits in virtual time', () => {
  test('a Pod with a 30 s grace period: kubectl returns once it is gone', () => {
    const { kernel, session, getPod } = boot(sleeper('slow'));
    expect(getPod('slow').ok).toBe(true);
    const start = kernel.now;
    session.type('kubectl delete pod slow\n');
    // The line is printed at once; the wait goes on through the grace period.
    expect(session.wait(20_000)).toBe(false);
    expect(session.take()).toBe('pod "slow" deleted from default namespace\n');
    expect(getPod('slow').ok).toBe(true);
    expect(session.wait(20_000)).toBe(true);
    const took = kernel.now - start;
    expect(took).toBeGreaterThanOrEqual(30_000);
    expect(took).toBeLessThan(35_000);
    expect(getPod('slow').ok).toBe(false);
    expect(session.run('echo $?').output).toBe('0\n');
  });

  test('the Pod spec grace period counts, and --grace-period overrides it', () => {
    const { kernel, session } = boot(sleeper('short', 5), sleeper('long'));
    let start = kernel.now;
    expect(session.run('kubectl delete pod short', { timeout: 60_000 }).finished).toBe(true);
    expect(kernel.now - start).toBeGreaterThanOrEqual(5_000);
    expect(kernel.now - start).toBeLessThan(10_000);
    start = kernel.now;
    const r = session.run('kubectl delete pod long --grace-period=3', { timeout: 60_000 });
    expect(r.output).toBe('pod "long" deleted from default namespace\n');
    expect(kernel.now - start).toBeGreaterThanOrEqual(3_000);
    expect(kernel.now - start).toBeLessThan(8_000);
  });

  test('--timeout expires with the real error, and the Pod is still terminating', () => {
    const { kernel, session, getPod } = boot(sleeper('slow'));
    const start = kernel.now;
    const r = session.run('kubectl delete pod slow --timeout=5s', { timeout: 60_000 });
    expect(r.finished).toBe(true);
    expect(r.output).toBe('pod "slow" deleted from default namespace\nerror: timed out waiting for the condition on pods/slow\n');
    expect(r.status).toBe(1);
    expect(kernel.now - start).toBe(5_000);
    const pod = getPod('slow');
    expect(pod.ok && (pod.object as { metadata: { deletionTimestamp?: string } }).metadata.deletionTimestamp).toBeTruthy();
  });

  test('Ctrl-C ends the wait with status 1 and prints nothing; the deletion goes on', () => {
    const { session, getPod } = boot(sleeper('slow'));
    session.type('kubectl delete pod slow\n');
    expect(session.wait(5_000)).toBe(false);
    expect(session.take()).toBe('pod "slow" deleted from default namespace\n');
    session.type('\x03');
    expect(session.wait(1_000)).toBe(true);
    expect(session.take()).toBe('');
    expect(session.run('echo $?').output).toBe('1\n');
    expect(getPod('slow').ok).toBe(true);
    session.run('sleep 30');
    expect(getPod('slow').ok).toBe(false);
  });

  test('--wait=false returns at once; several objects share one deadline', () => {
    const { kernel, session } = boot(sleeper('a'), sleeper('b'));
    let start = kernel.now;
    expect(session.run('kubectl delete pod a --wait=false').output).toBe('pod "a" deleted from default namespace\n');
    expect(kernel.now - start).toBe(0);
    start = kernel.now;
    const r = session.run('kubectl delete pod a b --timeout=10s', { timeout: 60_000 });
    expect(r.output).toBe('pod "a" deleted from default namespace\npod "b" deleted from default namespace\nerror: timed out waiting for the condition on pods/a\n');
    expect(kernel.now - start).toBe(10_000);
  });
});
