// Reading the packs from disk (Node): every directory under packages/content/ with a pack.yaml,
// and in it every `<area>/<id>.yaml`, with its Vietnamese sidecar `<id>.vi.yaml` when there is one.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from '@simlab/kernel';
import { parsePack, parseYaml, type Pack } from './parse.ts';

/** packages/content/. */
export const CONTENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface ItemFile {
  /** Path relative to the content root: `k8s/workloads/k8s.workloads.x-01.yaml`. */
  file: string;
  /** The file name without `.yaml`, which must equal the item id. */
  fileId: string;
  raw: Json;
  /** The sidecar next to the item (docs/SCENARIO_FORMAT.md §13), as parsed and not yet validated. */
  sidecar?: { file: string; raw: Json };
}

export interface LoadedPack {
  dir: string;
  pack: Pack;
  items: ItemFile[];
}

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p));
    else if (name.endsWith('.yaml') && !name.endsWith('.vi.yaml') && name !== 'pack.yaml') out.push(p);
  }
  return out;
}

export function loadPacks(root: string = CONTENT_ROOT): LoadedPack[] {
  const packs: LoadedPack[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    const packFile = join(dir, 'pack.yaml');
    if (!statSync(dir).isDirectory() || !existsSync(packFile)) continue;
    const pack = parsePack(readFileSync(packFile, 'utf8'), relative(root, packFile));
    const items = yamlFiles(dir).map((p): ItemFile => {
      const item: ItemFile = { file: relative(root, p), fileId: basename(p, '.yaml'), raw: parseYaml(readFileSync(p, 'utf8'), relative(root, p)) };
      const vi = `${p.slice(0, -'.yaml'.length)}.vi.yaml`;
      if (existsSync(vi)) item.sidecar = { file: relative(root, vi), raw: parseYaml(readFileSync(vi, 'utf8'), relative(root, vi)) };
      return item;
    });
    packs.push({ dir, pack, items });
  }
  return packs;
}

/** The kind an item file declares, or undefined when it has none. */
export function kindOf(f: ItemFile): string | undefined {
  const kind = (f.raw as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/** A lab, a drill or an incident: what the lab player and the workspace can open today. */
export const isLabLike = (f: ItemFile): boolean => ['lab', 'drill', 'incident'].includes(kindOf(f) ?? '');

/** Sidecars with no item next to them: `<id>.vi.yaml` without `<id>.yaml`. */
export function strandedSidecars(root: string = CONTENT_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.vi.yaml') && !existsSync(`${p.slice(0, -'.vi.yaml'.length)}.yaml`)) out.push(relative(root, p));
    }
  };
  for (const name of readdirSync(root).sort()) if (statSync(join(root, name)).isDirectory() && existsSync(join(root, name, 'pack.yaml'))) walk(join(root, name));
  return out;
}

/** Every skill id the packs define. */
export function skillIds(packs: readonly LoadedPack[]): Set<string> {
  return new Set(packs.flatMap((p) => p.pack.skills.map((s) => s.id)));
}

/** The item file with this id, across all packs. */
export function findItem(id: string, packs: readonly LoadedPack[] = loadPacks()): ItemFile | undefined {
  return packs.flatMap((p) => p.items).find((i) => i.fileId === id);
}

/** Competency ids of docs/curriculum/competencies.yaml (the official curricula, docs/curriculum/README.md). */
export function competencyIds(file: string = join(CONTENT_ROOT, '..', '..', 'docs', 'curriculum', 'competencies.yaml')): Set<string> {
  const doc = parseYaml(readFileSync(file, 'utf8'), 'docs/curriculum/competencies.yaml') as unknown as {
    exams: Record<string, { domains: { competencies: { id: string }[] }[] }>;
  };
  return new Set(Object.values(doc.exams).flatMap((e) => e.domains.flatMap((d) => d.competencies.map((c) => c.id))));
}
