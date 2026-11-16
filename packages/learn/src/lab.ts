// A learner's attempt at an item (docs/SCENARIO_FORMAT.md §3, §10): the ticket, a session world
// forked from the baseline, the hint ladder with its use recorded, check, reset and the reference
// solutions. Time is the app's business: it drives `kernel` and tells the lab nothing until the
// learner asks for something. What the learner asked for, and when, is in `events`; phase 11
// turns them into the progress log.

import type { Kernel, Millis, Ports, Registry } from '@simlab/kernel';
import type { Item, Solution, Step, Variant } from './item/types.ts';
import { variantOf } from './item/variant.ts';
import { buildBaseline, startSession, type Baseline, type BuildOptions } from './runner/build.ts';
import { grade, type GradeReport } from './runner/grader.ts';
import { runSteps } from './runner/steps.ts';

export type LabEvent =
  | { kind: 'start'; t: Millis }
  | { kind: 'hint'; t: Millis; index: number }
  | { kind: 'check'; t: Millis; passed: boolean; score: number }
  | { kind: 'reset'; t: Millis }
  | { kind: 'solution'; t: Millis }
  /** The live view of the world (the X-ray) was opened or closed: help, which phase 11 rates. */
  | { kind: 'view'; t: Millis; open: boolean };

export interface Lab {
  readonly variant: Variant;
  readonly baseline: Baseline;
  /** The session world; replaced by `reset`. */
  readonly kernel: Kernel;
  readonly ticket: string;
  /** How many hints exist for this variant, and how many were shown. */
  readonly hintCount: number;
  readonly hintsShown: number;
  /** The next hint on the ladder, recorded as used; undefined when all were shown. */
  nextHint(): { index: number; text: string } | undefined;
  /** The hints shown so far. */
  shownHints(): string[];
  check(): GradeReport;
  /** A new session world from the baseline. The hints already shown stay shown. */
  reset(ports?: Ports): Kernel;
  /** The reference solutions; viewing them is recorded. */
  solutions(): Solution[];
  readonly solutionViewed: boolean;
  /** Records that the live view of the world was opened or closed. */
  view(open: boolean): void;
  /**
   * Runs steps on the session world as setup and solutions run (separate logins, never the
   * learner's terminal). Throws `StepFailure`. For tests and demonstrations.
   */
  run(steps: readonly Step[], label?: string): void;
  readonly debrief: string;
  readonly events: readonly LabEvent[];
}

export interface LabOptions extends BuildOptions {
  seed: number;
  /** Ports of the first session world. */
  ports?: Ports;
}

export function createLab(item: Item, registry: Registry, options: LabOptions): Lab {
  const variant = variantOf(item, options.seed);
  const baseline = buildBaseline(variant, registry, options);
  return openLab(baseline, registry, options.ports);
}

/** A lab over a baseline that is already built (content validation builds one per seed). */
export function openLab(baseline: Baseline, registry: Registry, ports?: Ports): Lab {
  const variant = baseline.variant;
  let world = startSession(baseline, ports);
  let shown = 0;
  let viewed = false;
  const events: LabEvent[] = [{ kind: 'start', t: world.kernel.now }];
  return {
    variant,
    baseline,
    get kernel() {
      return world.kernel;
    },
    ticket: variant.ticket,
    hintCount: variant.hints.length,
    get hintsShown() {
      return shown;
    },
    nextHint() {
      if (shown >= variant.hints.length) return undefined;
      const index = shown++;
      events.push({ kind: 'hint', t: world.kernel.now, index });
      return { index, text: variant.hints[index] as string };
    },
    shownHints: () => variant.hints.slice(0, shown),
    check() {
      const report = grade(world.kernel, variant.checks, { registry, entry: baseline.entry, baseline: baseline.kernel.world });
      events.push({ kind: 'check', t: world.kernel.now, passed: report.passed, score: report.score });
      return report;
    },
    reset(next) {
      events.push({ kind: 'reset', t: world.kernel.now });
      world = startSession(baseline, next);
      return world.kernel;
    },
    solutions() {
      if (!viewed) events.push({ kind: 'solution', t: world.kernel.now });
      viewed = true;
      return variant.solutions;
    },
    get solutionViewed() {
      return viewed;
    },
    view(open) {
      events.push({ kind: 'view', t: world.kernel.now, open });
    },
    run(steps, label = 'steps') {
      runSteps(world.kernel, steps, { registry, entry: baseline.entry, hub: world.hub, baseline: baseline.kernel.world }, label);
    },
    debrief: variant.debrief,
    events,
  };
}
