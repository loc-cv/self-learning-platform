// The simulated kubectl against the real one: every golden case with at least one step the
// simulator executes is replayed by the differential runner (golden/kubectl/runner.ts), and each
// compared step must equal the captured fixture, or be listed in KNOWN (with its cause) or PENDING
// (work in progress) in golden/kubectl/known.ts. A KNOWN step that passes fails, so the register
// stays honest. `npm run golden:diff` prints the same results as a report.

import { describe, expect, test } from 'vitest';
import { caseNames, orphanEntries, runNamed, type JudgedCase } from './kubectl/suite.ts';

const results: JudgedCase[] = [];

describe('kubectl against the golden fixtures', () => {
  for (const name of caseNames()) {
    test(name, () => {
      const r = runNamed(name);
      results.push(r);
      for (const s of r.steps) {
        const what = `${name} step ${s.index}: ${s.label}`;
        if (s.verdict === 'fail') expect.soft(s.actual, `${what}\n${s.detail ?? ''}`).toEqual(s.expected);
        if (s.verdict === 'known-passes') expect.soft(false, `${what} is listed in KNOWN (${s.entry?.reason ?? ''}) but passes now: remove the entry`).toBe(true);
        if (s.verdict === 'pending') console.info(`pending: ${what} (${s.entry?.reason ?? ''})`);
        if (s.verdict === 'pending-passes') console.info(`stale PENDING entry: ${what} passes now`);
      }
    });
  }

  test('every KNOWN entry names a compared step', () => {
    // A PENDING entry may name a step that is not compared at the moment; a KNOWN one may not.
    const orphans = orphanEntries(results).filter((e) => 'cause' in e);
    expect(orphans.map((e) => `${e.case} step ${String(e.step)}: ${e.reason}`)).toEqual([]);
  });
});
