// Running a list of steps (docs/SCENARIO_FORMAT.md §6): a setup, a solution, a check's `after`.
// Each step is dispatched by its kind key: `advance` and `until` here, every other kind through
// the registry. A step that throws, or during which the engine reports a gap (a `[sim]` notice, a
// behavior the models do not cover), fails the list.

import { CHECK, FAULT, STEP, type CheckSpec, type FaultSpec, type Entry, type GapEvent, type Json, type Kernel, type Registry, type StepSpec, type World } from '@simlab/kernel';
import { parseDuration, formatDuration } from '../item/duration.ts';
import type { JsonObject, Step } from '../item/types.ts';
import { BUILTIN_STEP_NAMES } from './builtin.ts';
import { evaluate, poll, type Assertion, type Evaluation } from './evaluate.ts';
import { createStepSession, type PortHub } from './session.ts';

export interface StepEnv {
  registry: Registry;
  entry: Entry;
  /** The hub whose ports the kernel was created with. */
  hub: PortHub;
  /** What `until` checks compare against; during setup, the world as it is. */
  baseline?: World;
}

export class StepFailure extends Error {
  /** Which list: `setup`, `solution 1`, `check replicas-ready, after`. */
  readonly list: string;
  readonly index: number;
  readonly kind: string;
  readonly reason: string;
  /** The step reached something the simulator does not support. */
  readonly gap: boolean;
  constructor(list: string, index: number, kind: string, reason: string, gap: boolean) {
    super(`${list}, step ${index + 1} (${kind}): ${reason}`);
    this.list = list;
    this.index = index;
    this.kind = kind;
    this.reason = reason;
    this.gap = gap;
  }
}

/** The step's kind key: the one key that names a step kind. */
export function stepKind(step: Step, registry: Registry): string {
  const kinds = Object.keys(step).filter((k) => k !== 'when' && (BUILTIN_STEP_NAMES.includes(k) || registry.get<StepSpec>(STEP, k) !== undefined || k === 'fault'));
  if (kinds.length !== 1) throw new Error(kinds.length === 0 ? `no step kind among ${Object.keys(step).join(', ')}` : `several step kinds: ${kinds.join(', ')}`);
  return kinds[0] as string;
}

export function runSteps(kernel: Kernel, steps: readonly Step[], env: StepEnv, list: string): void {
  const session = createStepSession(env.hub, env.entry);
  const gaps: GapEvent[] = [];
  const stop = env.hub.add({ gap: (g) => gaps.push(g) });
  try {
    steps.forEach((step, i) => {
      let kind = '?';
      gaps.length = 0;
      try {
        kind = stepKind(step, env.registry);
        runStep(kernel, kind, step, env, session);
      } catch (e) {
        if (e instanceof StepFailure) throw e;
        const gap = gaps[0];
        throw new StepFailure(list, i, kind, gap ? notice(gap) : (e as Error).message, gap !== undefined);
      }
      const gap = gaps[0];
      if (gap) throw new StepFailure(list, i, kind, notice(gap), true);
    });
  } finally {
    stop();
    session.end();
  }
}

function notice(g: GapEvent): string {
  return `the simulator does not support this: ${g.program}: ${g.what}${g.commandLine ? ` (in \`${g.commandLine}\`)` : ''}`;
}

function runStep(kernel: Kernel, kind: string, step: Step, env: StepEnv, session: ReturnType<typeof createStepSession>): void {
  const { when: _w, ...args } = step;
  if (kind === 'advance') {
    kernel.advance(parseDuration(String(args['advance'])));
    return;
  }
  if (kind === 'until') {
    const a = args['until'] as unknown as Assertion;
    const timeout = parseDuration(String(args['timeout']));
    let last: Evaluation = { status: 'fail', expected: a.assert, observed: '' };
    const held = poll(kernel, timeout, () => {
      last = evaluate(kernel, a, { registry: env.registry, entry: env.entry, baseline: env.baseline ?? kernel.world });
      return last.status !== 'fail';
    });
    if (last.status === 'error') throw new Error(`${a.assert}: ${last.error ?? 'could not be evaluated'}`);
    if (!held) throw new Error(`${a.assert} did not hold within ${formatDuration(timeout)}: wanted ${last.expected}; ${last.observed}`);
    return;
  }
  if (kind === 'fault') {
    const name = String(args['fault']);
    const spec = env.registry.get<FaultSpec>(FAULT, name);
    if (!spec) throw new Error(`no fault named ${name}`);
    kernel.act(`fault:${name}`, (ctx) => spec.inject(ctx, (args['with'] ?? {}) as Json));
    return;
  }
  const spec = env.registry.get<StepSpec>(STEP, kind);
  if (!spec) throw new Error(`no step kind ${kind}`);
  spec.run({ kernel, registry: env.registry, session }, args as JsonObject);
}

/** True when the registry has the check; the schema refuses unknown names before this. */
export function hasCheck(registry: Registry, name: string): boolean {
  return registry.get<CheckSpec>(CHECK, name) !== undefined;
}
