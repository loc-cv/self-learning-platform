// npm run golden:diff -- [-v] [<area>/<name> ...]
//
// Replays the golden cases in the simulator (runner.ts) and prints, per case, how many recorded
// steps were compared and how they came out, what was shimmed or not simulated, and what blocked
// the rest of a case; then the cases the simulator does not support at all. -v prints every step
// and the differences. Reads committed fixtures only; no oracle is started.

import { caseNames, counts, orphanEntries, runNamed, type JudgedCase } from './suite.ts';

const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const names = args.filter((a) => !a.startsWith('-'));
const all = caseNames();
for (const n of names) if (!all.includes(n)) throw new Error(`no case ${n} (cases are <area>/<name> under fixtures/golden/cases)`);
const results: JudgedCase[] = (names.length > 0 ? names : all).map(runNamed);

const COLS = ['compared', 'passed', 'failed', 'known', 'pending', 'shimmed', 'notice', 'blocked'] as const;
const width = Math.max(...results.map((r) => r.name.length), 4);
console.log(`${'case'.padEnd(width)}  ${COLS.map((c) => c.padStart(8)).join(' ')}`);
const total = Object.fromEntries(COLS.map((c) => [c, 0])) as Record<(typeof COLS)[number], number>;
for (const r of results) {
  const c = counts(r);
  for (const k of COLS) total[k] += c[k];
  console.log(`${r.name.padEnd(width)}  ${COLS.map((k) => String(c[k]).padStart(8)).join(' ')}${c.stale > 0 ? `  (${c.stale} register entr${c.stale === 1 ? 'y' : 'ies'} pass now)` : ''}`);
}
console.log(`${'total'.padEnd(width)}  ${COLS.map((k) => String(total[k]).padStart(8)).join(' ')}`);
console.log('\ncompared = passed + failed + known + pending; shimmed: replayed through the shim, not compared;');
console.log('notice: not simulated yet and only reads, skipped; blocked: after a command neither can run.');

const unsupported = results.filter((r) => counts(r).compared === 0);
if (unsupported.length > 0) {
  console.log('\nCases with no compared step:');
  for (const r of unsupported) {
    const why = r.blockedBy ? `blocked by ${r.blockedBy}` : r.steps.every((s) => s.outcome === 'skipped') ? 'request steps only (tools/src/golden/api.test.ts)' : 'no step is simulated yet';
    console.log(`  ${r.name}: ${why}`);
  }
}
const blocked = results.filter((r) => r.blockedBy && counts(r).compared > 0);
if (blocked.length > 0) {
  console.log('\nCases blocked part-way:');
  for (const r of blocked) console.log(`  ${r.name}: ${r.blockedBy as string}`);
}

for (const r of results) {
  const shown = r.steps.filter((s) => verbose || s.verdict === 'fail' || s.verdict === 'known-passes' || s.verdict === 'pending-passes' || (verbose && s.verdict !== 'pass'));
  if (shown.length === 0 && !(verbose && r.notes.length > 0)) continue;
  console.log(`\n== ${r.name}`);
  if (verbose) for (const n of r.notes) console.log(`  note: ${n}`);
  for (const s of shown) {
    const tag = s.verdict === 'not-compared' ? s.outcome : s.verdict;
    console.log(`  [${s.index}] ${tag}: ${s.label}`);
    if (s.entry) console.log(`      ${'cause' in s.entry ? `KNOWN (${s.entry.cause})` : 'PENDING'}: ${s.entry.reason}`);
    if (s.masked && verbose) console.log(`      masked: ${s.masked.join('; ')}`);
    if (s.detail && (verbose || s.verdict === 'fail')) console.log(s.detail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

const orphans = orphanEntries(results);
if (orphans.length > 0) {
  console.log('\nRegister entries that match no compared step:');
  for (const e of orphans) console.log(`  ${e.case} step ${String(e.step)}: ${e.reason}`);
}
