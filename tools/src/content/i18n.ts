// npm run content:i18n [-- -v] [<item-id> …]
//
// The state of the Vietnamese translation (docs/SCENARIO_FORMAT.md §13): for every item, how many
// text units are current, outdated and missing, the sidecar entries that match no unit, and the
// translations that changed a code span or a placeholder. A report, never a gate: the exit
// status is 0 whatever it finds, and English is shown wherever Vietnamese is not current.

import { loadPacks, strandedSidecars, type ItemFile } from '@simlab/content';
import { parseAnyItem, parseSidecar, resolveSidecar, type SidecarResolution } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

export interface I18nReport {
  id: string;
  /** Present when the item is valid; an invalid item is content:check's business. */
  resolution?: SidecarResolution;
  /** A sidecar that is not one: its schema problems, or an id that is not the item's. */
  invalid: string[];
  hasSidecar: boolean;
}

export function reportItem(f: ItemFile): I18nReport {
  const report: I18nReport = { id: f.fileId, invalid: [], hasSidecar: f.sidecar !== undefined };
  const { item } = parseAnyItem(f.raw, contentRegistry);
  if (!item) return report;
  if (!f.sidecar) return { ...report, resolution: resolveSidecar(item) };
  const { sidecar, problems } = parseSidecar(f.sidecar.raw);
  if (!sidecar) return { ...report, invalid: problems, resolution: resolveSidecar(item) };
  if (sidecar.id !== item.id) return { ...report, invalid: [`id is ${sidecar.id}, the item is ${item.id}`], resolution: resolveSidecar(item) };
  return { ...report, resolution: resolveSidecar(item, sidecar) };
}

export interface I18nTotals {
  items: number;
  sidecars: number;
  current: number;
  outdated: number;
  missing: number;
}

export function totals(reports: readonly I18nReport[]): I18nTotals {
  const t: I18nTotals = { items: reports.length, sidecars: reports.filter((r) => r.hasSidecar).length, current: 0, outdated: 0, missing: 0 };
  for (const r of reports) {
    t.current += r.resolution?.counts.current ?? 0;
    t.outdated += r.resolution?.counts.outdated ?? 0;
    t.missing += r.resolution?.counts.missing ?? 0;
  }
  return t;
}

/** The report as lines of text. */
export function formatReport(reports: readonly I18nReport[], stranded: readonly string[], verbose: boolean): string[] {
  const out: string[] = [];
  for (const r of reports) {
    const c = r.resolution?.counts;
    const units = c ? c.current + c.outdated + c.missing : 0;
    const state = !c ? 'invalid item (npm run content:check)' : !r.hasSidecar ? `no sidecar, ${units} units` : `${c.current}/${units} current, ${c.outdated} outdated, ${c.missing} missing`;
    out.push(`${r.id}: ${state}`);
    for (const p of r.invalid) out.push(`  sidecar is not valid: ${p}`);
    for (const k of r.resolution?.orphaned ?? []) out.push(`  orphaned: ${k} matches no text unit of the item`);
    for (const v of r.resolution?.violations ?? []) out.push(`  ${v}`);
    if (verbose) for (const u of r.resolution?.units ?? []) if (u.state !== 'current') out.push(`  ${u.state}: ${u.key}  (source: ${u.hash})`);
  }
  for (const s of stranded) out.push(`${s}: a sidecar with no item next to it`);
  const t = totals(reports);
  const all = t.current + t.outdated + t.missing;
  out.push(`${t.items} items, ${t.sidecars} with a sidecar; ${all} text units: ${t.current} current, ${t.outdated} outdated, ${t.missing} missing`);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verbose = args.includes('-v') || args.includes('--verbose');
  const ids = args.filter((a) => !a.startsWith('-'));
  try {
    const files = loadPacks().flatMap((p) => p.items).filter((f) => ids.length === 0 || ids.includes(f.fileId));
    for (const line of formatReport(files.map(reportItem), ids.length === 0 ? strandedSidecars() : [], verbose)) console.log(line);
  } catch (e) {
    // Never a gate: a file that does not parse is said, and the exit status stays 0.
    console.log(`content:i18n: ${(e as Error).message}`);
  }
}
