// Building an item's world (docs/SCENARIO_FORMAT.md §3, §5): the topology into an empty world,
// then the setup steps, headlessly in virtual time. The result is the baseline: the world a
// learner's session starts from (a fork of it, so reset is a new fork) and what constraint
// checks compare against. The baseline kernel itself never runs again.

import { bootKernel, DEFAULT_START_TIME, TOPOLOGY, type Entry, type Kernel, type Millis, type Ports, type Registry, type TopologySpec } from '@simlab/kernel';
import type { Variant } from '../item/types.ts';
import { createPortHub, type PortHub } from './session.ts';
import { runSteps } from './steps.ts';

export interface Baseline {
  readonly variant: Variant;
  /** The kernel over the baseline world. Fork it; never run it. */
  readonly kernel: Kernel;
  /** Where the learner's terminal opens and where `run` steps type by default. */
  readonly entry: Entry;
  readonly machines: readonly string[];
}

export class ItemError extends Error {}

export interface BuildOptions {
  /** Used when the item fixes no `startTime`. Default: the fixed headless start (ARCHITECTURE §2.2). */
  startTime?: Millis;
}

/** The start time a build of `variant` uses. */
export function startTimeOf(variant: Variant, options: BuildOptions = {}): Millis {
  return variant.startTime ?? options.startTime ?? DEFAULT_START_TIME;
}

/** Builds the topology and runs the setup. Throws `StepFailure` when a setup step fails. */
export function buildBaseline(variant: Variant, registry: Registry, options: BuildOptions = {}): Baseline {
  const topology = registry.get<TopologySpec>(TOPOLOGY, variant.topology);
  if (!topology) throw new ItemError(`no topology named ${variant.topology}`);
  if (variant.item.world.images && Object.keys(variant.item.world.images).length > 0) {
    // docs/SCENARIO_FORMAT.md §14: declared images arrive with the first item that needs one.
    throw new ItemError('declared images (world.images) are not supported yet');
  }
  const hub = createPortHub();
  const kernel = bootKernel(registry, { seed: variant.seed, startTime: startTimeOf(variant, options), ports: hub.ports });
  const info = kernel.act('topology', (ctx) => topology.build(ctx, variant.topologyParams));
  const entry = variant.entry ?? info.entry;
  runSteps(kernel, variant.setup, { registry, entry, hub }, 'setup');
  return { variant, kernel, entry, machines: info.machines };
}

export interface SessionWorld {
  kernel: Kernel;
  /** The hub the kernel's ports go through: `ports` plus whatever steps run on it listen to. */
  hub: PortHub;
}

/** A session world: a fork of the baseline whose output goes to `ports`. */
export function startSession(baseline: Baseline, ports?: Ports): SessionWorld {
  const hub = createPortHub(ports);
  return { kernel: baseline.kernel.fork({ ports: hub.ports }), hub };
}
