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
