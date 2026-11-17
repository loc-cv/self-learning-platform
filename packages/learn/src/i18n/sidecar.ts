// Translation sidecars (docs/SCENARIO_FORMAT.md §13): `<id>.vi.yaml` holds Vietnamese text per
// unit with the hash of the English it was translated from. Resolution gives every unit a state
// (current, outdated, missing) and falls back to English; nothing here ever blocks an item.

import type { Json } from '@simlab/kernel';
import { formatSchemaErrors, validateSchema } from '../item/jsonschema.ts';
import type { AnyItem } from '../item/types.ts';
import { sourceHash, textUnits, type TextUnit } from './units.ts';

export type Lang = 'vi';

export interface Sidecar {
  id: string;
  lang: Lang;
  units: Record<string, { source: string; text: string }>;
}

const FIGURE = '(caption|alt|notes\\.[0-9]+|frames\\.[0-9]+\\.(caption|notes\\.[0-9]+)|(left|right)\\.title|entities\\.[a-z][a-z0-9-]*\\.label)';
const CHECK = 'checks\\.[a-z0-9-]+\\.title';
/** Every key `textUnits` can produce, for any kind of item. */
const UNIT_KEY = `^(title|ticket|debrief|prompt|answer|(ticket|debrief)\\.[0-9]+(\\.${FIGURE})?|hints\\.[0-9]+|${CHECK}|solutions\\.[0-9]+\\.name|steps\\.[0-9]+(\\.(${FIGURE}|prompt|explain|text|choices\\.[0-9]+|hints\\.[0-9]+|${CHECK}))?|figure\\.${FIGURE}|choices\\.[0-9]+)$`;

export const SIDECAR_SCHEMA: { [key: string]: Json } = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://simlab.invalid/schema/sidecar.schema.json',
  title: 'Simlab translation sidecar (<id>.<lang>.yaml)',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    lang: { enum: ['vi'] },
    units: {
      type: 'object',
      minProperties: 1,
      propertyNames: { pattern: UNIT_KEY },
      additionalProperties: {
        type: 'object',
        properties: { source: { type: 'string', pattern: '^sha256:[0-9a-f]{16}$' }, text: { type: 'string', minLength: 1 } },
        required: ['source', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'lang', 'units'],
  additionalProperties: false,
};

export function parseSidecar(raw: Json): { sidecar?: Sidecar; problems: string[] } {
  const problems = formatSchemaErrors(validateSchema(SIDECAR_SCHEMA, raw), '(sidecar)');
  return problems.length === 0 ? { sidecar: raw as unknown as Sidecar, problems } : { problems };
}

/** current: translated from this English; outdated: from an earlier English; missing: no entry. */
export type UnitState = 'current' | 'outdated' | 'missing';

export interface ResolvedUnit extends TextUnit {
  state: UnitState;
  /** The hash a translation of the English as it is now records. */
  hash: string;
  /** The Vietnamese text, when the sidecar has the unit (also when it is outdated). */
  translation?: string;
}

export interface SidecarResolution {
  units: ResolvedUnit[];
  /** Keys of the sidecar that match no unit of the item. */
  orphaned: string[];
  /** Translations that broke a mechanical rule: a code span or a placeholder of the source is gone. */
  violations: string[];
  counts: Record<UnitState, number>;
}

const PLACEHOLDER = /(?<!\\)\{\{\s*([^}]*?)\s*\}\}/g;

/** The code of a Markdown text: fenced blocks whole, then inline spans. */
export function codeSpans(markdown: string): string[] {
  const out: string[] = [];
  const rest = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (block) => {
    out.push(block);
    return '';
  });
  for (const m of rest.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) out.push(m[0]);
  return out;
}

/** What a translation must keep from its source (§13): every code span and block, and the same placeholders. */
export function translationViolations(source: string, translation: string): string[] {
  const out: string[] = [];
  for (const code of codeSpans(source)) if (!translation.includes(code)) out.push(`code changed or missing: ${code.length > 60 ? `${code.slice(0, 57)}…` : code}`);
  const names = (t: string): string[] => [...new Set([...t.matchAll(PLACEHOLDER)].map((m) => m[1] as string))].sort();
  const [a, b] = [names(source), names(translation)];
  for (const n of a) if (!b.includes(n)) out.push(`placeholder {{${n}}} is missing`);
  for (const n of b) if (!a.includes(n)) out.push(`placeholder {{${n}}} is not in the source`);
  return out;
}

/** The state of every text unit of `item` against a sidecar, or against none. */
export function resolveSidecar(item: AnyItem, sidecar?: Sidecar): SidecarResolution {
  const units = textUnits(item);
  const entries = sidecar?.units ?? {};
  const keys = new Set(units.map((u) => u.key));
  const counts: Record<UnitState, number> = { current: 0, outdated: 0, missing: 0 };
  const violations: string[] = [];
  const resolved = units.map((u): ResolvedUnit => {
    const hash = sourceHash(u.text);
    const entry = Object.hasOwn(entries, u.key) ? entries[u.key] : undefined;
    const state: UnitState = !entry ? 'missing' : entry.source === hash ? 'current' : 'outdated';
    counts[state]++;
    if (entry && state === 'current') violations.push(...translationViolations(u.text, entry.text).map((v) => `${u.key}: ${v}`));
    return entry ? { ...u, state, hash, translation: entry.text } : { ...u, state, hash };
  });
  return { units: resolved, orphaned: Object.keys(entries).filter((k) => !keys.has(k)), violations, counts };
}

/**
 * The item with every current translation in place of its English; outdated and missing units
 * stay English. The result has the item's shape, so variants, labs and figures work on it as on
 * the original.
 */
export function localize<T extends AnyItem>(item: T, resolution: SidecarResolution): T {
  const copy = JSON.parse(JSON.stringify(item)) as T;
  for (const u of resolution.units) {
    if (u.state !== 'current' || u.translation === undefined) continue;
    let node = copy as unknown as Record<string | number, unknown>;
    for (const part of u.path.slice(0, -1)) node = node[part] as Record<string | number, unknown>;
    node[u.path[u.path.length - 1] as string | number] = u.translation;
  }
  return copy;
}

/** A sidecar entry for a translation of `english` as it is now. */
export function sidecarEntry(english: string, translation: string): { source: string; text: string } {
  return { source: sourceHash(english), text: translation };
}
