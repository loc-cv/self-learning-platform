// Reading the packs from disk (Node): every directory under packages/content/ with a pack.yaml,
// and in it every `<area>/<id>.yaml` that is not a sidecar (`.vi.yaml`).

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
    const items = yamlFiles(dir).map((p) => ({ file: relative(root, p), fileId: basename(p, '.yaml'), raw: parseYaml(readFileSync(p, 'utf8'), relative(root, p)) }));
    packs.push({ dir, pack, items });
  }
  return packs;
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
