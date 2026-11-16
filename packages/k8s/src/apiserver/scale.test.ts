// Writes to the scale subresource (scale.ts). The responses and errors are compared with the real
// API server in tools/src/golden/api.test.ts (change/scale-subresource); these check what the
// write does to the object.

import { expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from './bootstrap.ts';
import { DEFAULT_APISERVER } from './config.ts';
import { handle } from './pipeline.ts';
import type { ApiRequest, ApiResponse } from './types.ts';
import type { JsonObject } from '../apimachinery/json.ts';

const base = { group: 'apps', version: 'v1', resource: 'deployments', namespace: 'default' } as const;

function boot(): Kernel {
  const k = bootKernel(createRegistry([hostPlugin, k8sPlugin]), { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  const labels = { app: 'web' };
  send(k, {
    verb: 'create',
    ...base,
    body: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web' }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'app', image: 'nginx' }] } } } },
  });
  return k;
}

const send = (k: Kernel, req: ApiRequest): ApiResponse => k.act('req', (ctx) => handle(ctx, DEFAULT_APISERVER, req));
const deployment = (k: Kernel): JsonObject => {
  const r = send(k, { verb: 'get', ...base, name: 'web' });
  return (r.ok ? r.object : {}) as JsonObject;
};
const spec = (o: JsonObject): JsonObject => o.spec as JsonObject;
const meta = (o: JsonObject): JsonObject => o.metadata as JsonObject;

test('a merge patch of deployments/scale sets spec.replicas, bumps the generation and answers the new Scale', () => {
  const k = boot();
  const before = deployment(k);
  const r = send(k, { verb: 'patch', ...base, name: 'web', subresource: 'scale', body: { spec: { replicas: 3 } }, options: { patchType: 'merge' } });
  expect(r.ok).toBe(true);
  const scale = r.ok ? (r.object as JsonObject) : {};
  expect(scale).toMatchObject({ kind: 'Scale', apiVersion: 'autoscaling/v1', spec: { replicas: 3 }, status: { selector: 'app=web' } });
  const after = deployment(k);
  expect(spec(after).replicas).toBe(3);
  expect(meta(after).generation).toBe((meta(before).generation as number) + 1);
  expect(meta(scale).resourceVersion).toBe(meta(after).resourceVersion);
});

test('a PUT with the current resourceVersion succeeds; a stale one is a Conflict and changes nothing', () => {
  const k = boot();
  const got = send(k, { verb: 'get', ...base, name: 'web', subresource: 'scale' });
  const scale = (got.ok ? got.object : {}) as JsonObject;
  const ok = send(k, { verb: 'update', ...base, name: 'web', subresource: 'scale', body: { ...scale, spec: { replicas: 2 } } });
  expect(ok.ok).toBe(true);
  const stale = send(k, { verb: 'update', ...base, name: 'web', subresource: 'scale', body: { ...scale, spec: { replicas: 7 } } });
  expect(stale.code).toBe(409);
  expect(spec(deployment(k)).replicas).toBe(2);
});

test('a server dry run answers the Scale without storing it', () => {
  const k = boot();
  const r = send(k, { verb: 'patch', ...base, name: 'web', subresource: 'scale', body: { spec: { replicas: 9 } }, options: { patchType: 'merge', dryRun: true } });
  expect(r.ok && (r.object as JsonObject).spec).toEqual({ replicas: 9 });
  expect(spec(deployment(k)).replicas).toBe(1);
});

test('negative replicas are Invalid on Scale.autoscaling', () => {
  const k = boot();
  const r = send(k, { verb: 'patch', ...base, name: 'web', subresource: 'scale', body: { spec: { replicas: -1 } }, options: { patchType: 'merge' } });
  expect(!r.ok && 'status' in r ? r.status.message : '').toBe('Scale.autoscaling "web" is invalid: spec.replicas: Invalid value: -1: must be greater than or equal to 0');
});
