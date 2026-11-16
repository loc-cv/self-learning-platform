// Runs the golden cases through the differential runner and judges each compared step against the
// KNOWN and PENDING registers (known.ts). Shared by the test (tools/src/golden/kubectl.test.ts)
// and the report (npm run golden:diff).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { casesDir, fixturesDir } from '../../oracle/paths.ts';
import { entryFor, KNOWN, PENDING, type Entry, type KnownEntry } from './known.ts';
import { runCase, type CaseResult, type StepResult } from './runner.ts';

export type Verdict =
  | 'pass'
  | 'fail'
  /** Different, and listed in KNOWN. */
  | 'known'
  /** Different, and listed in PENDING. */
  | 'pending'
  /** Listed in KNOWN but equal now: the register must lose the entry. */
  | 'known-passes'
  /** Listed in PENDING but equal now: the entry can go. */
  | 'pending-passes'
  /** Not compared (notice, shimmed, blocked, skipped). */
  | 'not-compared';

export interface JudgedStep extends StepResult {
  verdict: Verdict;
  entry?: Entry | KnownEntry;
}

export interface JudgedCase extends CaseResult {
  steps: JudgedStep[];
}

/** Every case under fixtures/golden/cases with a fixture, as `<area>/<name>`, sorted. */
export function caseNames(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.yaml') && !n.endsWith('.vi.yaml')) {
        const rel = path.relative(casesDir, p).replace(/\.yaml$/, '');
        if (existsSync(path.join(fixturesDir, `${rel}.yaml`))) out.push(rel);
      }
    }
  };
  walk(casesDir);
  return out;
}

export function judge(r: CaseResult): JudgedCase {
  const steps = r.steps.map((s): JudgedStep => {
    const known = entryFor(KNOWN, r.name, s.index, s.label);
    const pending = entryFor(PENDING, r.name, s.index, s.label);
    const entry = known ?? pending;
    const base = { ...s, ...(entry ? { entry } : {}) };
    if (s.outcome === 'pass') return { ...base, verdict: known ? 'known-passes' : pending ? 'pending-passes' : 'pass' };
    if (s.outcome === 'fail') return { ...base, verdict: known ? 'known' : pending ? 'pending' : 'fail' };
    return { ...base, verdict: 'not-compared' };
  });
  return { ...r, steps };
}

export function runNamed(name: string): JudgedCase {
  const caseText = readFileSync(path.join(casesDir, `${name}.yaml`), 'utf8');
  const fixtureText = readFileSync(path.join(fixturesDir, `${name}.yaml`), 'utf8');
  return judge(runCase(name, caseText, fixtureText));
}

/** Register entries that name no step the runner saw as compared (a typo, or the step changed). */
export function orphanEntries(results: JudgedCase[]): (Entry | KnownEntry)[] {
  const seen = new Set<Entry>();
  for (const r of results) for (const s of r.steps) if (s.entry && s.verdict !== 'not-compared') seen.add(s.entry);
  const ran = new Set(results.map((r) => r.name));
  return [...KNOWN, ...PENDING].filter((e) => ran.has(e.case) && !seen.has(e));
}

export interface Counts {
  compared: number;
  passed: number;
  failed: number;
  known: number;
  pending: number;
  stale: number;
  shimmed: number;
  notice: number;
  blocked: number;
  skipped: number;
}

export function counts(r: JudgedCase): Counts {
  const c: Counts = { compared: 0, passed: 0, failed: 0, known: 0, pending: 0, stale: 0, shimmed: 0, notice: 0, blocked: 0, skipped: 0 };
  for (const s of r.steps) {
    if (s.verdict !== 'not-compared') c.compared++;
    if (s.verdict === 'pass') c.passed++;
    else if (s.verdict === 'fail') c.failed++;
    else if (s.verdict === 'known') c.known++;
    else if (s.verdict === 'pending') c.pending++;
    else if (s.verdict === 'known-passes' || s.verdict === 'pending-passes') {
      c.passed++;
      c.stale++;
    } else if (s.outcome === 'shimmed') c.shimmed++;
    else if (s.outcome === 'notice') c.notice++;
    else if (s.outcome === 'blocked') c.blocked++;
    else if (s.outcome === 'skipped') c.skipped++;
  }
  return c;
}
