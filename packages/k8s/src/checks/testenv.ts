// Test support for the checks: the kubeadm-1cp-2w cluster booted once, a fork per test, the
// requests a setup or a learner would send, and a check run against a baseline. Nothing here is
// user-visible.

import { bootKernel, CHECK, createRegistry, DEFAULT_START_TIME, forkWorld, TOPOLOGY, type CheckResult, type CheckSpec, type Json, type Kernel, type StepSession, type TopologySpec, type World } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import type { ApiResponse } from '../apiserver/types.ts';
import { createClient, type Client } from '../client/client.ts';
import { k8sPlugin } from '../plugin.ts';

export const registry = createRegistry([hostPlugin, k8sPlugin]);

let booted: Kernel | undefined;

/** A fork of the cluster as the topology leaves it after 10 s: nodes Ready, kube-system running. */
export function cluster(): Kernel {
  if (!booted) {
    booted = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
    const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
    booted.act('topology', (ctx) => spec.build(ctx, {}));
    booted.advance(10_000);
  }
  return booted.fork();
}

const SESSION: StepSession = {
  entry: { machine: 'controlplane', user: 'root' },
  local: <T>(_key: string, create: () => T): T => create(),
  onEnd: () => {},
  listen: () => () => {},
};

/** Runs a registered check on a fork of `kernel` against `baseline` (default: the kernel's world now). */
export function runCheck(name: string, kernel: Kernel, args: JsonObject, baseline: World = forkWorld(kernel.world)): CheckResult {
  const spec = registry.get<CheckSpec>(CHECK, name);
  if (!spec) throw new Error(`no check ${name}`);
  return spec.run({ kernel: kernel.fork(), registry, session: SESSION, baseline }, args as Json);
}

export function api(k: Kernel, fn: (c: Client) => ApiResponse): JsonObject {
  const r = k.act('kubectl', (ctx) => fn(createClient(ctx, DEFAULT_APISERVER)));
  if (!r.ok) throw new Error(`request failed: ${JSON.stringify('status' in r ? r.status : r)}`);
  return r.object as JsonObject;
}

export function deployment(name: string, image: string, replicas: number, extra: JsonObject = {}): JsonObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels: { app: name } },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: 'nginx', image }] } },
      ...extra,
    },
  };
}

export function service(name: string, selector: JsonObject | undefined): JsonObject {
  return { apiVersion: 'v1', kind: 'Service', metadata: { name }, spec: { ...(selector ? { selector } : {}), ports: [{ port: 80, targetPort: 80 }] } };
}

export function namespace(k: Kernel, name: string): void {
  api(k, (c) => c.resource('v1/namespaces').create(undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name } }));
}
