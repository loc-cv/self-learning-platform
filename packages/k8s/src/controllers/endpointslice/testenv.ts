// Test environment of the endpoint controllers' simulation tests (not used by the plugin): a
// cluster with an API server, Nodes node01 and node02, the fake kubelet, and the endpoint
// controllers (plus the garbage collector, which removes a deleted Service's slices).

import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import type { ApiResponse, RequestOptions } from '../../apiserver/types.ts';
import { createClient } from '../../client/client.ts';
import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { BEHAVIOR_ANNOTATION, fakeKubeletPlugin, startFakeKubelet } from '../../testing/kubelet.ts';
import { startControllerManager } from '../manager.ts';

const registry = createRegistry([hostPlugin, k8sPlugin, fakeKubeletPlugin]);

export interface EnvOptions {
  seed?: number;
  traces?: TraceRecord[];
  nodes?: string[];
  controllers?: string[];
}

export function bootCluster(opts: EnvOptions = {}): Kernel {
  const traces = opts.traces;
  const k = bootKernel(registry, { seed: opts.seed ?? 1, startTime: DEFAULT_START_TIME, ...(traces ? { ports: { trace: (r: TraceRecord) => traces.push(r) } } : {}) });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  for (const name of opts.nodes ?? ['node01', 'node02']) {
    api(k, 'v1/nodes').create({ apiVersion: 'v1', kind: 'Node', metadata: { name, labels: { 'kubernetes.io/hostname': name } } }, undefined);
  }
  k.act('kubelet', (ctx) => startFakeKubelet(ctx, DEFAULT_APISERVER));
  k.act('kcm', (ctx) => startControllerManager(ctx, DEFAULT_APISERVER, { controllers: opts.controllers ?? ['endpoints', 'endpointslice', 'garbage-collector'] }));
  return k;
}

export function api(k: Kernel, resource: string) {
  const c = (ctx: Parameters<Parameters<Kernel['act']>[1]>[0]) => createClient(ctx, DEFAULT_APISERVER).resource(resource);
  const must = (r: ApiResponse): JsonObject => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.object as JsonObject;
  };
  return {
    create: (body: JsonObject, ns: string | undefined = 'default') => must(k.act('create', (ctx) => c(ctx).create(ns, body))),
    get: (name: string, ns: string | undefined = 'default') => {
      const r = k.act('get', (ctx) => c(ctx).get(ns, name));
      return r.ok ? (r.object as JsonObject) : undefined;
    },
    list: (ns: string | undefined = 'default') => (must(k.act('list', (ctx) => c(ctx).list(ns))).items ?? []) as JsonObject[],
    patch: (name: string, patch: Json, ns: string | undefined = 'default') => must(k.act('patch', (ctx) => c(ctx).patch(ns, name, patch))),
    update: (body: JsonObject, ns: string | undefined = 'default') => must(k.act('update', (ctx) => c(ctx).update(ns, body))),
    del: (name: string, options?: RequestOptions, ns: string | undefined = 'default') => k.act('delete', (ctx) => c(ctx).delete(ns, name, options)),
  };
}

export const meta = (o: JsonObject | undefined): JsonObject => (o?.metadata ?? {}) as JsonObject;

export interface PodOptions {
  labels: Record<string, string>;
  /** Container ports. */
  ports?: { name?: string; containerPort: number }[];
  notReady?: boolean;
  extra?: JsonObject;
}

export function pod(name: string, o: PodOptions): JsonObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, labels: o.labels, ...(o.notReady ? { annotations: { [BEHAVIOR_ANNOTATION]: 'not-ready' } } : {}) },
    spec: { containers: [{ name: 'app', image: 'nginx:1.27', ...(o.ports ? { ports: o.ports } : {}) }], ...(o.extra ?? {}) },
  };
}

export function service(name: string, selector: Record<string, string> | undefined, ports: JsonObject[], extra: JsonObject = {}, metadata: JsonObject = {}): JsonObject {
  return { apiVersion: 'v1', kind: 'Service', metadata: { name, ...metadata }, spec: { ...(selector ? { selector } : {}), ports, ...extra } };
}

/** The slices the EndpointSlice controller manages for a Service. */
export function slicesOf(k: Kernel, svc: string, ns = 'default'): JsonObject[] {
  return api(k, 'discovery.k8s.io/v1/endpointslices')
    .list(ns)
    .filter((s) => (meta(s).labels as Record<string, string> | undefined)?.['kubernetes.io/service-name'] === svc && (meta(s).labels as Record<string, string>)['endpointslice.kubernetes.io/managed-by'] === 'endpointslice-controller.k8s.io');
}

/** Endpoints sorted by targetRef name (the real controller's order within a slice varies). */
export function endpointsByPod(slice: JsonObject): JsonObject[] {
  const eps = (slice.endpoints ?? []) as JsonObject[];
  const n = (e: JsonObject) => ((e.targetRef as JsonObject | undefined)?.name as string) ?? '';
  return [...eps].sort((a, b) => (n(a) < n(b) ? -1 : n(a) > n(b) ? 1 : 0));
}

export function podIP(k: Kernel, name: string, ns = 'default'): string {
  return ((api(k, 'v1/pods').get(name, ns)?.status as JsonObject | undefined)?.podIP as string) ?? '';
}

export function podUID(k: Kernel, name: string, ns = 'default'): string {
  return meta(api(k, 'v1/pods').get(name, ns)).uid as string;
}

export function events(k: Kernel, ns = 'default'): JsonObject[] {
  return api(k, 'v1/events').list(ns);
}
