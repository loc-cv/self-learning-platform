// The API server's pods/log: PodLogOptions validation, LogLocation's container errors (which only
// clients other than kubectl reach), a Pod with no node, a kubelet that is not running, and the
// kubelet's errors for a container the runtime no longer has and a log file that is gone.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Kernel, type TopologySpec } from '@simlab/kernel';
import { createFs, hostPlugin } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { stopKubelet } from '../kubelet/kubelet.ts';
import { k8sPlugin } from '../plugin.ts';
import { removeContainer, runtimeOf } from '../runtime/runtime.ts';
import { DEFAULT_APISERVER } from './config.ts';
import { openPodLog, readPodLog, type PodLogOptions } from './log.ts';
import { handle } from './pipeline.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  k.act('topology', (ctx) => spec.build(ctx, {}));
  k.advance(10_000);
  return k;
}

function create(k: Kernel, body: JsonObject): void {
  k.act('create', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body }));
}

const pod = (name: string, containers: JsonObject[], spec: JsonObject = {}): JsonObject => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec: { ...spec, containers } });
const sh = (name: string, script: string): JsonObject => ({ name, image: 'busybox:1.36', command: ['sh', '-c', script] });

function open(k: Kernel, name: string, o: PodLogOptions = {}) {
  return k.act('log', (ctx) => openPodLog(ctx, DEFAULT_APISERVER, 'default', name, o));
}

function read(k: Kernel, name: string, o: PodLogOptions = {}): string {
  const r = open(k, name, o);
  if (!('stream' in r)) throw new Error(JSON.stringify(r));
  return k.act('read', (ctx) => readPodLog(ctx, r.stream).data);
}

const message = (r: ReturnType<typeof open>): string => ('status' in r ? `${r.status.code ?? ''} ${r.status.reason ?? ''}: ${r.status.message ?? ''}` : JSON.stringify(r));

describe('pods/log', () => {
  test('options, containers and a Pod with no node', () => {
    const k = boot();
    create(k, pod('two', [sh('a', 'sleep 3600'), sh('b', 'sleep 3600')], { initContainers: [sh('i', 'true')], nodeSelector: { disktype: 'nvme' } }));
    expect(message(open(k, 'two', { tailLines: -1, limitBytes: 0, sinceSeconds: 0 }))).toBe(
      '422 Invalid: PodLogOptions "two" is invalid: [tailLines: Invalid value: -1: must be greater than or equal to 0, limitBytes: Invalid value: 0: must be greater than 0, sinceSeconds: Invalid value: 0: must be greater than 0]',
    );
    expect(message(open(k, 'two'))).toBe('400 BadRequest: a container name must be specified for pod two, choose one of: [i a b]');
    expect(message(open(k, 'two', { container: 'x' }))).toBe('400 BadRequest: container x is not valid for pod two');
    expect(open(k, 'two', { container: 'i' })).toEqual({ empty: true });
    expect(message(open(k, 'none'))).toBe('404 NotFound: pods "none" not found');
  });

  test('after a crash: the previous instance, then its removal; a removed log file', () => {
    const k = boot();
    create(k, pod('crash', [sh('app', 'echo run; exit 3')]));
    k.advance(30_000);
    expect(read(k, 'crash', { previous: true })).toBe('run\n');
    const node = k.act('get', (ctx) => {
      const r = handle(ctx, DEFAULT_APISERVER, { verb: 'get', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'crash' });
      return String(((r as { object: JsonObject }).object.spec as JsonObject).nodeName);
    });
    // The runtime garbage-collects the previous container: the kubelet cannot find it.
    const status = k.act('get', (ctx) => (handle(ctx, DEFAULT_APISERVER, { verb: 'get', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'crash' }) as { object: JsonObject }).object.status as JsonObject);
    const last = (((status.containerStatuses as JsonObject[])[0] as JsonObject).lastState as JsonObject).terminated as JsonObject;
    const id = String(last.containerID).replace('containerd://', '');
    const path = k.act('path', (ctx) => runtimeOf(ctx, node).containers[id]?.logPath as string);
    k.act('rm', (ctx) => createFs(ctx, node, { cred: { uid: 0, gid: 0, groups: [] }, umask: 0o022 }).unlink(path));
    expect(message(open(k, 'crash', { previous: true }))).toBe(`400 BadRequest: failed to try resolving symlinks in path "${path}": lstat ${path}: no such file or directory`);
    k.act('gc', (ctx) => removeContainer(ctx, node, id));
    expect(message(open(k, 'crash', { previous: true }))).toBe(`400 BadRequest: unable to retrieve container logs for containerd://${id}`);
  });

  test('a stopped kubelet: the dial error, with the query LogLocation builds', () => {
    const k = boot();
    create(k, pod('web', [sh('app', 'echo hi; sleep 3600')], { nodeName: 'node01' }));
    k.advance(10_000);
    expect(read(k, 'web')).toBe('hi\n');
    k.act('stop', (ctx) => stopKubelet(ctx, 'node01'));
    expect(message(open(k, 'web', { follow: true, tailLines: 5, sinceTime: '2026-11-13T09:00:00Z', timestamps: true }))).toBe(
      '500 : Get "https://172.16.0.11:10250/containerLogs/default/web/app?follow=true&sinceTime=2026-11-13T09%3A00%3A00Z&tailLines=5&timestamps=true": dial tcp 172.16.0.11:10250: connect: connection refused',
    );
  });
});
