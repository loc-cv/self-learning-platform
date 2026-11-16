// Test support for workload controllers (Deployment, ReplicaSet): a booted API server with the
// controllers and the fake kubelet, the requests kubectl sends for create, set image, scale and
// rollout undo, and readers for the stored objects. Nothing here is user-visible.

import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { cloneJson, type JsonObject } from '../apimachinery/json.ts';
import { bootstrapApiServer } from '../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import type { ApiResponse } from '../apiserver/types.ts';
import { createClient } from '../client/client.ts';
import { startController } from '../controllers/runtime.ts';
import { k8sPlugin } from '../plugin.ts';
import { fakeKubeletPlugin, startFakeKubelet, type FakeKubeletConfig } from './kubelet.ts';

const registry = createRegistry([hostPlugin, k8sPlugin, fakeKubeletPlugin]);

export interface WorkloadEnv {
  k: Kernel;
  traces: TraceRecord[];
}

export interface BootOptions {
  seed?: number;
  kubelet?: Partial<FakeKubeletConfig>;
  controllers?: string[];
}

/** An API server with the deployment and replicaset controllers and the fake kubelet running. */
export function bootWorkloads(opts: BootOptions = {}): WorkloadEnv {
  const traces: TraceRecord[] = [];
  const k = bootKernel(registry, { seed: opts.seed ?? 1, startTime: DEFAULT_START_TIME, ports: { trace: (r: TraceRecord) => traces.push(r) } });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  k.act('start', (ctx) => {
    for (const name of opts.controllers ?? ['deployment', 'replicaset']) startController(ctx, 'kube-controller-manager', name, DEFAULT_APISERVER);
    startFakeKubelet(ctx, DEFAULT_APISERVER, opts.kubelet ?? {});
  });
  return { k, traces };
}

export function request(k: Kernel, fn: (c: ReturnType<typeof createClient>) => ApiResponse): ApiResponse {
  return k.act('kubectl', (ctx) => fn(createClient(ctx, DEFAULT_APISERVER)));
}

function must(r: ApiResponse): JsonObject {
  if (!r.ok) throw new Error(`request failed: ${JSON.stringify('status' in r ? r.status : r)}`);
  return r.object as JsonObject;
}

/** What `kubectl create deployment <name> --image=<image> --replicas=<n>` sends (fixtures/golden/v1.37.2/client/generators.yaml). */
export function kubectlCreateDeployment(name: string, image: string, replicas: number, extra: { strategy?: JsonObject; container?: string } = {}): JsonObject {
  const container = extra.container ?? image.replace(/[:@].*$/, '').replace(/^.*\//, '');
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels: { app: name } },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      strategy: extra.strategy ?? {},
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: container, image, resources: {} }] } },
    },
  };
}

export function createDeployment(env: WorkloadEnv, body: JsonObject, namespace = 'default'): JsonObject {
  return must(request(env.k, (c) => c.resource('apps/v1/deployments').create(namespace, body)));
}

export function getDeployment(env: WorkloadEnv, name: string, namespace = 'default'): JsonObject {
  return must(request(env.k, (c) => c.resource('apps/v1/deployments').get(namespace, name)));
}

/** A merge patch of the Deployment (kubectl set image, scale, patch all end in a write of spec). */
export function patchDeployment(env: WorkloadEnv, name: string, patch: JsonObject, namespace = 'default'): JsonObject {
  return must(request(env.k, (c) => c.resource('apps/v1/deployments').patch(namespace, name, patch)));
}

/** `kubectl set image deployment/<name> <container>=<image>`: the container's image changes. */
export function setImage(env: WorkloadEnv, name: string, container: string, image: string): JsonObject {
  const d = getDeployment(env, name);
  const spec = cloneJson(d.spec as JsonObject);
  const containers = ((spec.template as JsonObject).spec as JsonObject).containers as JsonObject[];
  for (const c of containers) if (c.name === container) c.image = image;
  return must(request(env.k, (c) => c.resource('apps/v1/deployments').update('default', { ...d, spec })));
}

/** `kubectl scale deployment <name> --replicas=<n>`. */
export function scale(env: WorkloadEnv, name: string, replicas: number): JsonObject {
  return patchDeployment(env, name, { spec: { replicas } });
}

const ANNOTATIONS_TO_SKIP = ['kubectl.kubernetes.io/last-applied-configuration', 'deployment.kubernetes.io/revision', 'deployment.kubernetes.io/revision-history', 'deployment.kubernetes.io/desired-replicas', 'deployment.kubernetes.io/max-replicas', 'deprecated.deployment.rollback.to'];

/**
 * `kubectl rollout undo deployment/<name> [--to-revision=N]`: the template of the ReplicaSet with
 * that revision (default: the previous one), minus the pod-template-hash label, replaces the
 * Deployment's, and its annotations (but the skipped ones, which the Deployment keeps) replace the
 * Deployment's (staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollback.go
 * DeploymentRollbacker.Rollback: a JSON patch of /spec/template and /metadata/annotations).
 */
export function rolloutUndo(env: WorkloadEnv, name: string, toRevision = 0): JsonObject {
  const d = getDeployment(env, name);
  const rss = replicaSets(env).filter((rs) => ((rs.metadata as JsonObject).ownerReferences as JsonObject[] | undefined)?.some((r) => r.uid === (d.metadata as JsonObject).uid));
  const rev = (rs: JsonObject): number => Number(((rs.metadata as JsonObject).annotations as JsonObject | undefined)?.['deployment.kubernetes.io/revision'] ?? 0);
  const sorted = [...rss].sort((a, b) => rev(a) - rev(b));
  const target = toRevision === 0 ? sorted[sorted.length - 2] : sorted.find((rs) => rev(rs) === toRevision);
  if (!target) throw new Error('no revision to roll back to');
  const template = cloneJson((target.spec as JsonObject).template as JsonObject);
  delete ((template.metadata as JsonObject).labels as JsonObject)['pod-template-hash'];
  const annotations: JsonObject = {};
  const da = ((d.metadata as JsonObject).annotations ?? {}) as JsonObject;
  for (const k of ANNOTATIONS_TO_SKIP) if (k in da) annotations[k] = da[k] as string;
  const ra = ((target.metadata as JsonObject).annotations ?? {}) as JsonObject;
  for (const k of Object.keys(ra)) if (!ANNOTATIONS_TO_SKIP.includes(k)) annotations[k] = ra[k] as string;
  return must(request(env.k, (c) => c.resource('apps/v1/deployments').update('default', { ...d, metadata: { ...(d.metadata as JsonObject), annotations }, spec: { ...(d.spec as JsonObject), template } })));
}

export function list(env: WorkloadEnv, resource: string, namespace = 'default'): JsonObject[] {
  const r = must(request(env.k, (c) => c.resource(resource).list(namespace)));
  return r.items as JsonObject[];
}

export const replicaSets = (env: WorkloadEnv): JsonObject[] => list(env, 'apps/v1/replicasets');
export const pods = (env: WorkloadEnv): JsonObject[] => list(env, 'v1/pods');
/** Events in creation order (the store lists by name, which is not creation order). */
export function events(env: WorkloadEnv): JsonObject[] {
  const ev = list(env, 'v1/events');
  const rv = (e: JsonObject): number => Number((e.metadata as JsonObject).resourceVersion);
  return ev.sort((a, b) => rv(a) - rv(b));
}

export function eventLines(env: WorkloadEnv, kind?: string): string[] {
  return events(env)
    .filter((e) => kind === undefined || (e.involvedObject as JsonObject).kind === kind)
    .map((e) => `${e.type as string} ${e.reason as string} ${(e.source as JsonObject).component as string} ${e.message as string}`);
}

/**
 * What `kubectl rollout status` waits for (staging/src/k8s.io/kubectl/pkg/polymorphichelpers/
 * rollout_status.go DeploymentStatusViewer.Status): 'done', 'waiting', or 'deadline' when the
 * Progressing condition says ProgressDeadlineExceeded.
 */
export function rolloutStatus(d: JsonObject): 'done' | 'waiting' | 'deadline' {
  const m = d.metadata as JsonObject;
  const spec = d.spec as JsonObject;
  const st = (d.status ?? {}) as JsonObject;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  if (n(m.generation) > n(st.observedGeneration)) return 'waiting';
  const progressing = ((st.conditions ?? []) as JsonObject[]).find((c) => c.type === 'Progressing');
  if (progressing?.reason === 'ProgressDeadlineExceeded') return 'deadline';
  if (spec.replicas !== undefined && n(st.updatedReplicas) < n(spec.replicas)) return 'waiting';
  if (n(st.replicas) > n(st.updatedReplicas)) return 'waiting';
  if (n(st.availableReplicas) < n(st.updatedReplicas)) return 'waiting';
  return 'done';
}

/** Advances in steps until `done` holds; throws after `max` ms of virtual time. Returns the time waited. */
export function waitFor(env: WorkloadEnv, done: () => boolean, step = 100, max = 120_000): number {
  let waited = 0;
  while (!done()) {
    if (waited >= max) throw new Error(`condition not reached after ${max} ms`);
    env.k.advance(step);
    waited += step;
  }
  return waited;
}

/** `kubectl rollout status deployment/<name> --timeout=60s` as a setup step. */
export function waitRolledOut(env: WorkloadEnv, name: string): number {
  return waitFor(env, () => rolloutStatus(getDeployment(env, name)) === 'done', 100, 60_000);
}

export { DEFAULT_START_TIME };
