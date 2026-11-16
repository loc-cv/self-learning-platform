// kubectl logs -f in virtual time (phase 08 exit criterion): lines appear as the container writes
// them, the stream ends when the container exits (status 0), Ctrl-C ends it with kubectl's
// interrupt status (1), a container still being created is retried every second with the
// kubelet's message until it runs, --pod-running-timeout bounds that, a stopped kubelet ends a
// stream and refuses new ones with the dial error, and -l … -f follows several Pods at once.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Kernel, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, hostPlugin, openSession } from '@simlab/host';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../../../apiserver/config.ts';
import { handle } from '../../../apiserver/pipeline.ts';
import { stopKubelet } from '../../../kubelet/kubelet.ts';
import { k8sPlugin } from '../../../plugin.ts';

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

function createPod(kernel: Kernel, name: string, script: string, labels: Record<string, string> = {}, image = 'busybox:1.36'): void {
  const body = { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels }, spec: { containers: [{ name: 'app', image, command: ['sh', '-c', script] }] } };
  kernel.act('create', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body }));
}

function nodeOf(kernel: Kernel, name: string): string {
  const r = kernel.act('get', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'get', group: '', version: 'v1', resource: 'pods', namespace: 'default', name }));
  return String(((r as { object: JsonObject }).object.spec as JsonObject).nodeName);
}

const COUNT = 'i=0; while [ $i -lt 4 ]; do i=$((i+1)); echo line $i; sleep 10; done';

describe('kubectl logs -f', () => {
  test('streams lines as the container writes them and ends when it exits', () => {
    const { kernel, session } = boot();
    createPod(kernel, 'count', COUNT);
    kernel.advance(5_000);
    session.type('kubectl logs -f count\n');
    kernel.advance(100);
    expect(session.take()).toBe('line 1\n');
    // One line every 10 s, each printed when it is written.
    for (const n of [2, 3, 4]) {
      kernel.advance(10_000);
      expect(session.take()).toBe(`line ${n}\n`);
    }
    // The script ends 10 s after its last line: the stream ends with it.
    expect(session.wait(15_000)).toBe(true);
    expect(session.run('echo $?').output).toBe('0\n');
  });

  test('Ctrl-C ends it with status 1', () => {
    const { kernel, session } = boot();
    createPod(kernel, 'count', COUNT);
    kernel.advance(5_000);
    session.type('kubectl logs count -f --timestamps\n');
    kernel.advance(100);
    expect(session.take()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z line 1\n$/);
    session.type('\x03');
    expect(session.wait(1_000)).toBe(true);
    expect(session.run('echo $?').output).toBe('1\n');
    kernel.advance(20_000);
    expect(session.take()).toBe('');
  });

  test('a container being created: the kubelet’s answer every second, then the stream', () => {
    const { kernel, session } = boot();
    createPod(kernel, 'late', 'echo hello; sleep 3600');
    // Scheduled, not started yet (a Pod with no node has no logs at all: 204, nothing printed).
    kernel.advance(300);
    session.type('kubectl logs -f late\n');
    kernel.advance(30_000);
    const out = session.take().split('\n').filter((l) => l !== '');
    const waiting = out.filter((l) => l === 'container "app" in pod "late" is waiting to start: ContainerCreating');
    expect(waiting.length).toBeGreaterThan(0);
    expect(out.slice(waiting.length)).toEqual(['hello']);
    session.type('\x03');
    expect(session.wait(1_000)).toBe(true);
  });

  test('--pod-running-timeout bounds the retries: context deadline exceeded', () => {
    const { kernel, session } = boot();
    createPod(kernel, 'nopull', 'true', {}, 'busybox:0.0.0-missing');
    kernel.advance(20_000);
    session.type('kubectl logs -f nopull --pod-running-timeout=3s\n');
    expect(session.wait(10_000)).toBe(true);
    const out = session.take().split('\n').filter((l) => l !== '');
    expect(out.at(-1)).toBe('error: context deadline exceeded');
    expect(out.slice(0, -1)).toHaveLength(3);
    for (const l of out.slice(0, -1)) expect(l).toMatch(/^container "app" in pod "nopull" is waiting to start: (image can't be pulled|trying and failing to pull image)$/);
    expect(session.run('echo $?').output).toBe('1\n');
  });

  test('a stopped kubelet ends the stream; a new request gets the dial error', () => {
    const { kernel, session } = boot();
    createPod(kernel, 'count', COUNT);
    kernel.advance(5_000);
    const node = nodeOf(kernel, 'count');
    session.type('kubectl logs -f count\n');
    kernel.advance(100);
    expect(session.take()).toBe('line 1\n');
    kernel.act('stop', (ctx) => stopKubelet(ctx, node));
    expect(session.wait(1_000)).toBe(true);
    expect(session.run('echo $?').output).toBe('0\n');
    const r = session.run('kubectl logs count --tail=1');
    const ip = node === 'node01' ? '172.16.0.11' : '172.16.0.12';
    expect(r.output).toBe(`Error from server: Get "https://${ip}:10250/containerLogs/default/count/app?tailLines=1": dial tcp ${ip}:10250: connect: connection refused\n`);
  });

  test('-l … -f follows several Pods at once, each line with its prefix', () => {
    const { kernel, session } = boot();
    createPod(kernel, 'a', 'sleep 1; echo a1; sleep 10; echo a2; sleep 3600', { app: 'pair' });
    createPod(kernel, 'b', 'sleep 6; echo b1; sleep 3600', { app: 'pair' });
    kernel.advance(4_000);
    session.type('kubectl logs -l app=pair -f --prefix\n');
    kernel.advance(100);
    expect(session.take()).toBe('[pod/a/app] a1\n');
    kernel.advance(5_000);
    expect(session.take()).toBe('[pod/b/app] b1\n');
    kernel.advance(5_000);
    expect(session.take()).toBe('[pod/a/app] a2\n');
    // Deleting a Pod stops its container; the other stream goes on.
    kernel.act('delete', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'delete', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'a' }));
    kernel.advance(5_000);
    expect(session.wait(100)).toBe(false);
    kernel.act('delete', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'delete', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'b' }));
    expect(session.wait(40_000)).toBe(true);
    expect(session.run('echo $?').output).toBe('0\n');
  });
});
