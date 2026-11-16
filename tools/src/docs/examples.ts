// Reads the worked examples out of docs/SCENARIO_FORMAT.md and checks them against the format.
// The examples are fenced blocks whose info string is `yaml item` or `yaml sidecar`.
// Items in packages/content go through the real validator (`npm run content:check`). The
// examples need features of later phases, so they cannot run yet; the test checks them against
// the generated schema with the planned checks and faults added (planned.ts), and by the static
// rules, so the spec uses only constructs it defines.

import { createHash } from 'node:crypto';

export interface Block {
  kind: 'item' | 'sidecar';
  source: string;
}

export function extractBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const re = /^```yaml (item|sidecar)\n([\s\S]*?)^```$/gm;
  for (const m of markdown.matchAll(re)) {
    blocks.push({ kind: m[1] as Block['kind'], source: m[2] as string });
  }
  return blocks;
}

/** docs/SCENARIO_FORMAT.md §12: normalization and hash of an English text unit. */
export function sourceHash(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Every `{{name}}` in the text, ignoring the escaped form `\{{`. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/(?<!\\)\{\{([^}]*)\}\}/g)].map((m) => (m[1] as string).trim());
}

/** Code spans of a Markdown text, for the "code stays in English" rule. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The English text unit a sidecar key addresses, or undefined. */
export function textUnit(item: Obj, key: string): string | undefined {
  const parts = key.split('.');
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : isObj(v) && typeof v['text'] === 'string' ? v['text'] : undefined;
  const at = (list: unknown, index: string): unknown =>
    Array.isArray(list) ? (list as unknown[])[Number(index)] : undefined;
  switch (parts[0]) {
    case 'title':
    case 'ticket':
      return parts.length === 1 ? pick(item[parts[0]]) : undefined;
    case 'debrief':
      return parts.length === 1 ? pick(item['debrief']) : pick(at(item['debrief'], parts[1] ?? ''));
    case 'hints':
      return pick(at(item['hints'], parts[1] ?? ''));
    case 'checks': {
      const checks = Array.isArray(item['checks']) ? (item['checks'] as unknown[]) : [];
      const check = checks.find((c) => isObj(c) && c['id'] === parts[1]);
      return isObj(check) && parts[2] === 'title' ? pick(check['title']) : undefined;
    }
    case 'solutions': {
      const solution = at(item['solutions'], parts[1] ?? '');
      return isObj(solution) && parts[2] === 'name' ? pick(solution['name']) : undefined;
    }
    default:
      return undefined;
  }
}

/** Every string anywhere in a value, with the path to it. */
export function strings(value: unknown, path = ''): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (isObj(value)) return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

/** Every `when` map anywhere in a value. */
export function whens(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.flatMap((v) => whens(v));
  if (!isObj(value)) return [];
  const own = isObj(value['when']) ? [value['when']] : [];
  return [...own, ...Object.entries(value).filter(([k]) => k !== 'when').flatMap(([, v]) => whens(v))];
}
