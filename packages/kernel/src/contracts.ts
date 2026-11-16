// Extension contracts that `learn` consumes and plugins implement (docs/ARCHITECTURE.md §2.11,
// D-010). They live in the kernel because `learn` may import nothing else. Argument schemas are
// JSON Schema objects, plain data, so content can be validated without running anything.

import type { Json } from './json.ts';
import type { Ctx, Kernel } from './kernel.ts';
import type { Contribution, Registry } from './registry.ts';

/** A JSON Schema object (draft 2020-12 subset) describing `args`. */
export type ArgsSchema = { [key: string]: Json };

export interface CheckCtx {
  kernel: Kernel;
  registry: Registry;
}

export interface CheckResult {
  pass: boolean;
  /** What was observed, for the debrief: "2 of 3 Pods ready". */
  observed: string;
  /** Set when the check could not be evaluated (a `[sim]` notice, a missing machine). */
  error?: string;
}

export interface CheckSpec extends Contribution {
  args: ArgsSchema;
  /** Runs against a fork. May advance the fork's time. Must not depend on anything else. */
  run(ctx: CheckCtx, args: Json): CheckResult;
}

export interface FaultSpec extends Contribution {
  args: ArgsSchema;
  /** Mutates the world into a state a real system could be in. */
  inject(ctx: Ctx, args: Json): void;
}

/** Phase 09 adds the terminal session a step can type into. */
export interface StepCtx {
  kernel: Kernel;
  registry: Registry;
}

export interface StepSpec extends Contribution {
  args: ArgsSchema;
  /** Executes one setup or solution step. Throws with a message on failure. */
  run(ctx: StepCtx, args: Json): void;
}

/** Registry kinds of the contracts below. */
export const CHECK = 'check';
export const FAULT = 'fault';
export const STEP = 'step';
export const TOPOLOGY = 'topology';

export interface TopologyInfo {
  /** Where a learner's terminal opens by default. */
  entry: { machine: string; user: string };
  machines: string[];
}

export interface TopologySpec extends Contribution {
  params: ArgsSchema;
  /** Builds the machines and domain state into an empty world. */
  build(ctx: Ctx, params: Json): TopologyInfo;
}

/** Registry kind of provenance entries (docs/FIDELITY.md §3). */
export const PROVENANCE = 'provenance';

export type ProvenanceTag = 'golden-verified' | 'source-derived' | 'approximate';

/**
 * One output unit and where its text comes from (docs/FIDELITY.md §3). The contribution's `name`
 * is the unit: a stable dotted id `<program>.<verb>.<what>`, e.g. `kubectl.get.pods.table`.
 * `npm run fidelity:report` prints every entry; `validateProvenance` checks them.
 */
export interface ProvenanceSpec extends Contribution {
  tag: ProvenanceTag;
  /** Fixture paths, upstream paths with symbol, tool and version, or URLs. At least one unless approximate. */
  sources: string[];
  /** Divergence register id (`DIV-NNN`), required when the tag is `approximate`. */
  divergence?: string;
  note?: string;
}

/** Problems with a set of provenance entries: duplicates, missing sources, missing divergence ids. */
export function validateProvenance(entries: readonly ProvenanceSpec[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.name)) problems.push(`${e.name}: registered twice`);
    seen.add(e.name);
    if (!/^[a-z0-9-]+(\.[A-Za-z0-9_-]+)+$/.test(e.name)) problems.push(`${e.name}: not a dotted unit id`);
    if (e.tag === 'approximate') {
      if (!e.divergence || !/^DIV-\d{3}$/.test(e.divergence)) problems.push(`${e.name}: approximate without a divergence id`);
    } else if (e.sources.length === 0) problems.push(`${e.name}: no source`);
  }
  return problems;
}
