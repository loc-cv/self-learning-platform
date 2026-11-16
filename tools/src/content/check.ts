// npm run content:check [-- --seeds N] [--verbose] [<item-id> …]
//
// Content validation (docs/SCENARIO_FORMAT.md §11) for every item of every pack, or the named
// ones: the schema and the static rules, then for each seed (1 to N, default 5, plus whatever
// seeds it takes to reach every value a `when` depends on) setup completes without a `[sim]`
// notice, the untouched world fails, and every reference solution passes. Exit status 1 when
// anything is wrong. Part of `npm run check`.

import { performance } from 'node:perf_hooks';
import { competencyIds, loadPacks, skillIds, type ItemFile } from '@simlab/content';
import { runSeed, seedsFor, staticProblems, type GradeReport, type Item, type SeedResult } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

export interface ItemReport {
  id: string;
  file: string;
  problems: string[];
  seeds: SeedResult[];
  ms: number;
}

export function checkItem(f: ItemFile, opts: { seeds: number; skills: ReadonlySet<string>; competencies: ReadonlySet<string> }): ItemReport {
  const start = performance.now();
  const report: ItemReport = { id: f.fileId, file: f.file, problems: [], seeds: [], ms: 0 };
  report.problems.push(...staticProblems(f.raw, { registry: contentRegistry, skills: opts.skills, competencies: opts.competencies, fileId: f.fileId }));
  if (report.problems.length === 0) {
    const item = f.raw as unknown as Item;
    const { seeds, uncovered } = seedsFor(item, opts.seeds);
    for (const u of uncovered) report.problems.push(`no seed up to ${opts.seeds + 50} reaches ${u}`);
    for (const seed of seeds) report.seeds.push(runSeed(item, seed, contentRegistry));
  }
  report.ms = performance.now() - start;
  return report;
}

function line(r: GradeReport): string {
  return r.checks.map((c) => `${c.status === 'pass' ? '+' : c.status === 'fail' ? '-' : '!'}${c.id}`).join(' ');
}

function main(argv: string[]): number {
  let seeds = 5;
  let verbose = false;
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--seeds') seeds = Number(argv[++i]);
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a.startsWith('-')) {
      console.error(`content:check: unknown option ${a}`);
      return 2;
    } else ids.push(a);
  }
  if (!Number.isInteger(seeds) || seeds < 1) {
    console.error('content:check: --seeds takes a positive integer');
    return 2;
  }
  const packs = loadPacks();
  const files = packs.flatMap((p) => p.items).filter((f) => ids.length === 0 || ids.includes(f.fileId));
  for (const id of ids) if (!files.some((f) => f.fileId === id)) console.error(`content:check: no item ${id}`);
  const opts = { seeds, skills: skillIds(packs), competencies: competencyIds() };
  let bad = ids.length > files.length ? 1 : 0;
  for (const f of files) {
    const r = checkItem(f, opts);
    const seedProblems = r.seeds.flatMap((s) => s.problems.map((p) => `seed ${s.seed} ${JSON.stringify(s.params)}: ${p}`));
    const all = [...r.problems, ...seedProblems];
    console.log(`${all.length === 0 ? 'ok  ' : 'FAIL'} ${r.id} (${r.seeds.length} seeds, ${(r.ms / 1000).toFixed(1)} s)`);
    for (const p of all) console.log(`     ${p}`);
    if (verbose) {
      for (const s of r.seeds) {
        console.log(`     seed ${s.seed} ${JSON.stringify(s.params)}`);
        if (s.untouched) console.log(`       untouched: ${line(s.untouched)}`);
        for (const sol of s.solved) console.log(`       ${sol.name}: ${line(sol.report)}`);
      }
    }
    if (all.length > 0) bad = 1;
  }
  if (files.length === 0) {
    console.error('content:check: no items found');
    return 1;
  }
  return bad;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
