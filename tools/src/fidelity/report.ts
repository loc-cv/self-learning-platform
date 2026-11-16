// npm run fidelity:report
//
// Every registered output unit with its provenance tag and sources (docs/FIDELITY.md §3), then the
// counts per tag. Exits 1 when the registry is invalid (a unit registered twice, without a
// source, or approximate without a divergence id).

import { createRegistry, PROVENANCE, validateProvenance, type ProvenanceSpec } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '@simlab/k8s';

export function provenanceEntries(): ProvenanceSpec[] {
  return createRegistry([hostPlugin, k8sPlugin]).list<ProvenanceSpec>(PROVENANCE);
}

export function formatReport(entries: readonly ProvenanceSpec[]): string {
  const rows = entries.map((e) => [e.name, e.tag, e.divergence ?? '', e.sources.join('; ')]);
  const head = ['UNIT', 'TAG', 'DIVERGENCE', 'SOURCES'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.slice().map((r) => (r[i] as string).length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number)))
      .join('  ')
      .trimEnd();
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  const summary = ['golden-verified', 'source-derived', 'approximate'].map((t) => `${t}: ${counts.get(t) ?? 0}`).join(', ');
  return [line(head), ...rows.map(line), '', `${entries.length} units — ${summary}`].join('\n') + '\n';
}

if (import.meta.main) {
  const entries = provenanceEntries();
  process.stdout.write(formatReport(entries));
  const problems = validateProvenance(entries);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exitCode = 1;
  }
}
