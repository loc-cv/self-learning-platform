// Evaluating one assertion (docs/SCENARIO_FORMAT.md §7): always on a fresh fork, so a check can
// type commands, advance time or delete things without touching the world it was asked about.

import { CHECK, SECOND, type CheckResult, type CheckSpec, type Entry, type Json, type Kernel, type Millis, type Registry, type World } from '@simlab/kernel';
import type { JsonObject } from '../item/types.ts';
import { createPortHub, createStepSession } from './session.ts';

export interface Assertion {
  assert: string;
  with: JsonObject;
  not?: boolean;
}

export interface Evaluation {
  status: 'pass' | 'fail' | 'error';
  expected: string;
  observed: string;
  error?: string;
}

export interface EvalEnv {
  registry: Registry;
  entry: Entry;
  baseline: World;
}

/** Evaluates `a` once, now, on a fork of `kernel`'s world. `not` inverts pass and fail, never an error. */
export function evaluate(kernel: Kernel, a: Assertion, env: EvalEnv): Evaluation {
  const spec = env.registry.get<CheckSpec>(CHECK, a.assert);
  if (!spec) return { status: 'error', expected: a.assert, observed: '', error: `no check named ${a.assert}` };
  const hub = createPortHub();
  const fork = kernel.fork({ ports: hub.ports, traceCapacity: 1000 });
  const session = createStepSession(hub, env.entry);
  let r: CheckResult;
  try {
    r = spec.run({ kernel: fork, registry: env.registry, session, baseline: env.baseline }, a.with as Json);
  } catch (e) {
    r = { pass: false, expected: a.assert, observed: '', error: (e as Error).message };
  } finally {
    try {
      session.end();
    } catch {
      // The fork is discarded; a logout that fails there changes nothing.
    }
  }
  const expected = a.not ? `not: ${r.expected}` : r.expected;
  if (r.error !== undefined) return { status: 'error', expected, observed: r.observed, error: r.error };
  return { status: r.pass !== (a.not ?? false) ? 'pass' : 'fail', expected, observed: r.observed };
}

/**
 * How often a waiting check looks again: every second, or a sixtieth of the time it may wait,
 * whichever is longer, so a check costs at most about sixty evaluations however long it waits.
 */
export function pollInterval(timeout: Millis): Millis {
  return Math.max(SECOND, Math.ceil(timeout / 60 / SECOND) * SECOND);
}

/** Calls `probe` now and after each poll interval until it returns true or `timeout` has passed on `kernel`. */
export function poll(kernel: Kernel, timeout: Millis, probe: () => boolean): boolean {
  const deadline = kernel.now + timeout;
  const step = pollInterval(timeout);
  for (;;) {
    if (probe()) return true;
    if (kernel.now >= deadline) return false;
    kernel.runUntil(Math.min(deadline, kernel.now + step));
  }
}
