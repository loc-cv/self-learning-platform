// pods/binding: assigning a Pod to a node (upstream BindingREST.Create, setPodNodeAndMetadata).

import { expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from './bootstrap.ts';
import { DEFAULT_APISERVER } from './config.ts';
import { handle } from './pipeline.ts';
import type { ApiResponse } from './types.ts';
import type { JsonObject } from '../apimachinery/json.ts';

function boot(): Kernel {
  const k = bootKernel(createRegistry([hostPlugin, k8sPlugin]), { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  k.act('pod', (ctx) =>
    handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: 'nginx' }] } } }),
  );
  return k;
}

const bind = (k: Kernel, node: string, name = 'p'): ApiResponse =>
  k.act('bind', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', subresource: 'binding', namespace: 'default', name: 'p', body: { apiVersion: 'v1', kind: 'Binding', metadata: { name }, target: { kind: 'Node', name: node } } }));

const getPod = (k: Kernel): JsonObject => {
  const r = k.act('get', (ctx) => handle(ctx, DEFAULT_APISERVER, { verb: 'get', group: '', version: 'v1', resource: 'pods', namespace: 'default', name: 'p' }));
  return (r.ok ? r.object : {}) as JsonObject;
};

test('a binding sets nodeName and PodScheduled, without a generation bump, and answers a 201 Status', () => {
  const k = boot();
  const before = getPod(k);
  const r = bind(k, 'node01');
  expect(r).toMatchObject({ ok: true, code: 201, object: { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success', code: 201 } });
  const pod = getPod(k);
  expect((pod.spec as JsonObject).nodeName).toBe('node01');
  expect((pod.metadata as JsonObject).generation).toBe((before.metadata as JsonObject).generation);
  expect((pod.status as JsonObject).conditions).toEqual([{ type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: '2026-11-13T09:00:00Z' }]);
});

test('binding a bound Pod is a Conflict on pods/binding', () => {
  const k = boot();
  bind(k, 'node01');
  const r = bind(k, 'node02');
  expect(r.code).toBe(409);
  expect(!r.ok && 'status' in r ? r.status.message : '').toBe('Operation cannot be fulfilled on pods/binding "p": pod p is already assigned to node "node01"');
});

test('a Binding named differently from the URL is a BadRequest', () => {
  const k = boot();
  const r = bind(k, 'node01', 'other');
  expect(r.code).toBe(400);
  expect(!r.ok && 'status' in r ? r.status.message : '').toBe('name in URL does not match name in Binding object');
});
