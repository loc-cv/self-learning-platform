// kubectl get -w streams changes in virtual time and stops on Ctrl-C (phase 07a exit criterion).
// The watch prints the list, then one row per event, aligned with remembered widths and no second
// header (get.go watch, the server's watch Tables); Ctrl-C ends it with status 1 (kubectl's
// interrupt handler exits 1).

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, hostPlugin, openSession } from '@simlab/host';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import { k8sPlugin } from '../../plugin.ts';

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

const pod = (name: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } });

describe('kubectl get -w', () => {
  test('prints each change as it happens and stops on Ctrl-C', () => {
    const { kernel, session } = boot();
    session.type('kubectl get pods -w\n');
    kernel.advance(100);
    expect(session.take()).toBe('');
    // No pods: nothing printed yet, but the watch is open. A Pod appears and starts.
    kernel.act('create', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body: pod('web') }));
    kernel.advance(30_000);
    const lines = session.take().split('\n').filter((l) => l !== '');
    expect(lines[0]).toMatch(/^NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE$/);
    expect(lines.slice(1).map((l) => l.split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'web 0/1 Pending',
      'web 0/1 Pending',
      'web 0/1 ContainerCreating',
      'web 1/1 Running',
    ]);
    expect(lines.filter((l) => l.startsWith('NAME'))).toHaveLength(1);
    // Nothing changes: nothing printed, however long.
    kernel.advance(60_000);
    expect(session.take()).toBe('');
    session.type('\x03');
    expect(session.wait(1_000)).toBe(true);
    expect(session.run('echo $?').output).toBe('1\n');
    // The watch is closed: a later change is not printed anywhere.
    kernel.act('delete', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'delete', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'web' }));
    kernel.advance(40_000);
    expect(session.take()).toBe('');
  });

  test('a named object: its current row, then only its changes', () => {
    const { kernel, session } = boot();
    kernel.act('create', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body: pod('web') }));
    kernel.advance(30_000);
    session.type('kubectl get pod web -w\n');
    kernel.advance(100);
    const first = session.take().split('\n').filter((l) => l !== '');
    expect(first).toHaveLength(2);
    expect(first[1]).toMatch(/^web\s+1\/1\s+Running\s+0\s+30s$/);
    kernel.act('delete', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'delete', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'web' }));
    kernel.advance(40_000);
    const rest = session.take().split('\n').filter((l) => l !== '');
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((l) => l.startsWith('web '))).toBe(true);
    expect(rest.some((l) => /\sTerminating\s/.test(l))).toBe(true);
    session.type('\x03');
    expect(session.wait(1_000)).toBe(true);
  });
});
