// npm run content:check [-- --seeds N] [--verbose] [<item-id> …]
//
// Content validation (docs/SCENARIO_FORMAT.md §12, docs/LEARNING_MODEL.md §2, §3) for the packs
// and for every item of every pack, or the named ones: the pack manifests (skills, prerequisites,
// tracks), the schema and the static rules, then for each seed (1 to N, default 5, plus whatever
// seeds it takes to reach every value a `when` depends on) setup completes without a `[sim]`
// notice, the untouched world fails, and every reference solution passes; for a lesson, every
// task in order. Exit status 1 when anything is wrong. Part of `npm run check`. Translations are
// not checked here: `npm run content:i18n` reports them and never fails.

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { competencyIds, kindOf, loadPacks, skillIds, type ItemFile, type LoadedPack } from '@simlab/content';
import { catalogProblems, runSeed, seedsFor, staticProblems, type AnyItem, type GradeReport, type ItemKind, type SeedResult } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

export interface ItemReport {
  id: string;
  file: string;
  problems: string[];
  seeds: SeedResult[];
  ms: number;
}

/** The ids of the divergence register: the rows of docs/FIDELITY.md that start with `| DIV-NNN |`. */
export function divergenceIds(): Set<string> {
  const text = readFileSync(new URL('../../../docs/FIDELITY.md', import.meta.url), 'utf8');
  return new Set([...text.matchAll(/^\| (DIV-\d{3}) \|/gm)].map((m) => m[1] as string));
}

export interface CheckOptions {
  seeds: number;
  skills: ReadonlySet<string>;
  competencies: ReadonlySet<string>;
  divergences?: ReadonlySet<string>;
  /** Every item with its kind, for an exam's tasks. */
  items?: ReadonlyMap<string, ItemKind>;
}

/** Every item file's id and declared kind. */
export function itemKinds(packs: readonly LoadedPack[]): Map<string, ItemKind> {
  return new Map(packs.flatMap((p) => p.items.map((f) => [f.fileId, kindOf(f) as ItemKind] as const)));
}

/** What is wrong with the packs as a whole: ids, prerequisites, tracks (docs/LEARNING_MODEL.md §3). */
export function packProblems(packs: readonly LoadedPack[]): string[] {
  // Items are taken as written: one that fails its own schema is reported under its own name.
  const usable = (f: ItemFile): boolean => typeof (f.raw as { id?: unknown } | null)?.id === 'string' && kindOf(f) !== undefined;
  return catalogProblems(packs.map((p) => ({ pack: p.pack, items: p.items.filter(usable).map((f) => f.raw as unknown as AnyItem) })));
}

export function checkItem(f: ItemFile, opts: CheckOptions): ItemReport {
  const start = performance.now();
  const report: ItemReport = { id: f.fileId, file: f.file, problems: [], seeds: [], ms: 0 };
  report.problems.push(...staticProblems(f.raw, { registry: contentRegistry, skills: opts.skills, competencies: opts.competencies, fileId: f.fileId, divergences: opts.divergences ?? divergenceIds(), ...(opts.items ? { items: opts.items } : {}) }));
  const item = f.raw as unknown as AnyItem;
  // An exam is a definition: nothing of its own runs (its tasks are items, checked as such).
  if (report.problems.length === 0 && item.kind !== 'exam') {
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
  let packs: LoadedPack[];
  try {
    packs = loadPacks();
  } catch (e) {
    // A pack.yaml or an item that is not YAML, or a manifest that fails its schema.
    console.error(`content:check: ${(e as Error).message}`);
    return 1;
  }
  const files = packs.flatMap((p) => p.items).filter((f) => ids.length === 0 || ids.includes(f.fileId));
  for (const id of ids) if (!files.some((f) => f.fileId === id)) console.error(`content:check: no item ${id}`);
  const opts: CheckOptions = { seeds, skills: skillIds(packs), competencies: competencyIds(), divergences: divergenceIds(), items: itemKinds(packs) };
  let bad = ids.length > files.length ? 1 : 0;
  const across = packProblems(packs);
  console.log(`${across.length === 0 ? 'ok  ' : 'FAIL'} packs: ${packs.map((p) => `${p.pack.id} (${p.pack.skills.length} skills, ${(p.pack.tracks ?? []).length} tracks, ${p.items.length} items)`).join(', ')}`);
  for (const p of across) console.log(`     ${p}`);
  if (across.length > 0) bad = 1;
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
