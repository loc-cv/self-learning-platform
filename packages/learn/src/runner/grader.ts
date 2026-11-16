// The grader (docs/SCENARIO_FORMAT.md §7): every check on its own fork of the session world, then
// one report with a result and an explanation per check, weights and a score. The session world
// is never touched: forks share its values and copy only what they change (D-008).

import type { Entry, Kernel, Millis, Registry, World } from '@simlab/kernel';
import type { Check } from '../item/types.ts';
import { formatDuration } from '../item/duration.ts';
import { evaluate, poll, type Evaluation } from './evaluate.ts';
import { createPortHub } from './session.ts';
import { runSteps, StepFailure } from './steps.ts';

export interface CheckReport {
  id: string;
  title: string;
  weight: number;
  status: 'pass' | 'fail' | 'error';
  /** What the check wants, in words from its arguments. */
  expected: string;
  /** What it found. */
  observed: string;
  /** Why it could not be evaluated, for status `error`. */
  error?: string;
  /** With `within`: the virtual time the fork needed before it held. */
  waited?: Millis;
}

export interface GradeReport {
  /** Every check passed. */
  passed: boolean;
  /** Weight of the passed checks over the total weight, 0 to 1. */
  score: number;
  earned: number;
  total: number;
  /** Virtual time of the session world when graded. */
  at: Millis;
  checks: CheckReport[];
}

export interface GradeEnv {
  registry: Registry;
  entry: Entry;
  baseline: World;
}

export function gradeCheck(session: Kernel, check: Check, env: GradeEnv): CheckReport {
  const base = { id: check.id, title: check.title, weight: check.weight };
  const hub = createPortHub();
  const fork = session.fork({ ports: hub.ports, traceCapacity: 1000 });
  const start = fork.now;
  if (check.after.length > 0) {
    try {
      runSteps(fork, check.after, { registry: env.registry, entry: env.entry, hub, baseline: env.baseline }, `check ${check.id}, after`);
    } catch (e) {
      if (!(e instanceof StepFailure)) throw e;
      // A step that fails is the check failing; one the simulator cannot run makes it unevaluable.
      const observed = `step ${e.index + 1} of the check's preparation failed: ${e.reason}`;
      // The assertion never ran, so it could not say what it wants: the title says it for it.
      return e.gap ? { ...base, status: 'error', expected: check.title, observed, error: e.reason } : { ...base, status: 'fail', expected: check.title, observed };
    }
  }
  const assertion = { assert: check.assert, with: check.with, not: check.not };
  let last: Evaluation | undefined;
  if (check.within === undefined) last = evaluate(fork, assertion, env);
  else {
    poll(fork, check.within, () => {
      last = evaluate(fork, assertion, env);
      return last.status !== 'fail';
    });
  }
  const r = last as Evaluation;
  const report: CheckReport = { ...base, status: r.status, expected: r.expected, observed: r.observed };
  if (r.error !== undefined) report.error = r.error;
  if (check.within !== undefined && r.status === 'pass' && fork.now > start) report.waited = fork.now - start;
  if (check.within !== undefined && r.status === 'fail') report.observed = `${r.observed} (still so after ${formatDuration(check.within)})`;
  return report;
}

export function grade(session: Kernel, checks: readonly Check[], env: GradeEnv): GradeReport {
  const reports = checks.map((c) => gradeCheck(session, c, env));
  const total = reports.reduce((a, r) => a + r.weight, 0);
  const earned = reports.reduce((a, r) => a + (r.status === 'pass' ? r.weight : 0), 0);
  return {
    passed: reports.every((r) => r.status === 'pass'),
    score: total === 0 ? 0 : earned / total,
    earned,
    total,
    at: session.now,
    checks: reports,
  };
}
