// The pack manifest and the catalog (docs/LEARNING_MODEL.md §3): what a pack declares besides its
// items (skills with prerequisites, tracks) and the index the learning layer works from. The
// catalog holds metadata only; the scheduler, the queue and the statistics never read an item's
// world, ticket or checks.

import type { Json } from '@simlab/kernel';
import { formatSchemaErrors, validateSchema } from './item/jsonschema.ts';
import type { AnyItem, ItemKind } from './item/types.ts';

export interface SkillDef {
  id: string;
  title: string;
  description?: string;
  /** Skills to have practiced successfully before an item on this skill is offered as new. */
  requires?: string[];
}

/** An ordered path through items: the order new material is offered in. */
export interface TrackDef {
  id: string;
  title: string;
  description?: string;
  items: string[];
}

export interface PackManifest {
  id: string;
  title: string;
  description?: string;
  skills: SkillDef[];
  tracks?: TrackDef[];
}

const ID = '^[a-z0-9]+(\\.[a-z0-9]+(-[a-z0-9]+)*)+$';
const TEXT = { type: 'string', minLength: 1 };

export const PACK_SCHEMA: { [key: string]: Json } = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://simlab.invalid/schema/pack.schema.json',
  title: 'Simlab content pack manifest (pack.yaml)',
  description: 'Specified in docs/LEARNING_MODEL.md §3.',
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    title: TEXT,
    description: TEXT,
    skills: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { id: { type: 'string', pattern: ID }, title: TEXT, description: TEXT, requires: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: ID } } },
        required: ['id', 'title'],
        additionalProperties: false,
      },
    },
    tracks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { id: { type: 'string', pattern: ID }, title: TEXT, description: TEXT, items: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: ID } } },
        required: ['id', 'title', 'items'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'title', 'skills'],
  additionalProperties: false,
};

export function parsePackManifest(raw: Json): { pack?: PackManifest; problems: string[] } {
  const problems = formatSchemaErrors(validateSchema(PACK_SCHEMA, raw), '(pack)');
  return problems.length === 0 ? { pack: raw as unknown as PackManifest, problems } : { problems };
}

/** What the learning layer knows about an item. Exams are not in the catalog: nothing schedules them. */
export interface ItemMeta {
  id: string;
  kind: Exclude<ItemKind, 'exam'>;
  title: string;
  /** The first is the primary skill: the one interleaving looks at. */
  skills: string[];
  curriculum: string[];
  difficulty: number;
  targetMinutes: number;
  pack: string;
}

export interface Catalog {
  items: Record<string, ItemMeta>;
  skills: Record<string, SkillDef & { pack: string }>;
  tracks: Record<string, TrackDef & { pack: string }>;
}

export interface PackContent {
  pack: PackManifest;
  items: readonly AnyItem[];
}

export function itemMeta(item: Exclude<AnyItem, { kind: 'exam' }>, pack: string): ItemMeta {
  return { id: item.id, kind: item.kind, title: item.title, skills: [...item.skills], curriculum: [...item.curriculum], difficulty: item.difficulty, targetMinutes: item.targetMinutes, pack };
}

/** The catalog of some packs. A later definition of the same id replaces an earlier one; `catalogProblems` reports it. */
export function buildCatalog(packs: readonly PackContent[]): Catalog {
  const catalog: Catalog = { items: {}, skills: {}, tracks: {} };
  for (const { pack, items } of packs) {
    for (const s of pack.skills) catalog.skills[s.id] = { ...s, pack: pack.id };
    for (const t of pack.tracks ?? []) catalog.tracks[t.id] = { ...t, pack: pack.id };
    for (const i of items) if (i.kind !== 'exam') catalog.items[i.id] = itemMeta(i, pack.id);
  }
  return catalog;
}

/** A lesson is done once; every other kind in the catalog is scheduled for review (§5). */
export const isScheduled = (kind: ItemMeta['kind']): boolean => kind !== 'lesson';

/** The skills that must be met before `item` is offered as new. */
export function prerequisitesOf(item: ItemMeta, catalog: Catalog): string[] {
  const own = new Set(item.skills);
  const out = new Set<string>();
  // A prerequisite the item itself practices is not a gate: the item is how that skill starts.
  for (const s of item.skills) for (const r of catalog.skills[s]?.requires ?? []) if (!own.has(r)) out.add(r);
  return [...out];
}

/**
 * What is wrong across packs (§3): duplicate ids, prerequisites that name no skill or form a
 * cycle, tracks that name no item or an exam, and track items that could never be offered because
 * a prerequisite of theirs is practiced by no earlier item of the track.
 */
export function catalogProblems(packs: readonly PackContent[]): string[] {
  const out: string[] = [];
  const count = (ids: string[], what: string): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push(`${what} ${id} is defined twice`);
      seen.add(id);
    }
  };
  count(packs.map((p) => p.pack.id), 'pack');
  count(packs.flatMap((p) => p.pack.skills.map((s) => s.id)), 'skill');
  count(packs.flatMap((p) => (p.pack.tracks ?? []).map((t) => t.id)), 'track');
  count(packs.flatMap((p) => p.items.map((i) => i.id)), 'item');
  const catalog = buildCatalog(packs);
  const exams = new Set(packs.flatMap((p) => p.items.filter((i) => i.kind === 'exam').map((i) => i.id)));
  for (const s of Object.values(catalog.skills)) {
    for (const r of s.requires ?? []) {
      if (r === s.id) out.push(`skill ${s.id} requires itself`);
      else if (!catalog.skills[r]) out.push(`skill ${s.id} requires ${r}, which no pack defines`);
    }
  }
  // Cycles: a depth-first walk in id order; each cycle is reported once, from its smallest member.
  const state = new Map<string, 'open' | 'done'>();
  const walk = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      const cycle = path.slice(path.indexOf(id));
      if (id === [...cycle].sort()[0]) out.push(`skills require each other: ${[...cycle, id].join(' → ')}`);
      return;
    }
    state.set(id, 'open');
    for (const r of catalog.skills[id]?.requires ?? []) if (r !== id && catalog.skills[r]) walk(r, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of Object.keys(catalog.skills).sort()) {
    state.clear();
    walk(id, []);
  }
  for (const t of Object.values(catalog.tracks)) {
    const practiced = new Set<string>();
    for (const id of t.items) {
      const item = catalog.items[id];
      if (!item) {
        out.push(exams.has(id) ? `track ${t.id}: ${id} is an exam; a track holds what is practiced and scheduled` : `track ${t.id}: no item ${id}`);
        continue;
      }
      for (const r of prerequisitesOf(item, catalog)) if (!practiced.has(r)) out.push(`track ${t.id}: ${id} needs skill ${r}, which no earlier item of the track practices; it would never be offered`);
      for (const s of item.skills) practiced.add(s);
    }
  }
  return out;
}
