// The engine as the command-line tools assemble it: every plugin, a topology built into a fresh
// world, and the session header a recording starts with.

import { bootKernel, createRegistry, DEFAULT_START_TIME, ENGINE_VERSION, TOPOLOGY, type Kernel, type Plugin, type Ports, type SessionHeader, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin, KUBERNETES_TAG } from '@simlab/k8s';

/** Every plugin the tools load. */
export const PLUGINS: Plugin[] = [hostPlugin, k8sPlugin];

export const registry = createRegistry(PLUGINS);

export function topologyNames(): string[] {
  return registry.list<TopologySpec>(TOPOLOGY).map((t) => t.name);
}

export class UsageError extends Error {}

export function header(topology: string, seed: number): SessionHeader {
  return { topology, seed, startTime: DEFAULT_START_TIME, engine: ENGINE_VERSION, versions: { kubernetes: KUBERNETES_TAG } };
}

/** Boots a world from a session header: the topology built at the start time, with `ports` attached. */
export function boot(h: SessionHeader, ports: Ports = {}): { kernel: Kernel; info: TopologyInfo } {
  const spec = registry.get<TopologySpec>(TOPOLOGY, h.topology);
  if (!spec) throw new UsageError(`unknown topology '${h.topology}'; known: ${topologyNames().join(', ')}`);
  const kernel = bootKernel(registry, { seed: h.seed, startTime: h.startTime, ports });
  const info = kernel.act('topology', (ctx) => spec.build(ctx, h.params ?? {}));
  return { kernel, info };
}
