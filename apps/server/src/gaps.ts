// The gap log's sink (docs/FIDELITY.md §4.4): records the web app sends are completed with the
// wall-clock time, which the engine cannot know, and appended to data/gaps.jsonl, one per line.

import { join } from 'node:path';
import { appendLines } from './store.ts';

/** What the web app sends: a `GapEvent` with the item in its context and the engine's versions. */
export interface GapPost {
  v: 1;
  kind: string;
  program: string;
  what: string;
  commandLine: string;
  key: string;
  context: { machine: string; virtualTime: number; seed?: number; item?: string };
  engine: { version: string; kubernetes: string };
  error?: { message: string; stack?: string };
}

/** Why a posted record is refused, or undefined when it has the fields of a gap record. */
export function gapProblem(r: unknown): string | undefined {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return 'a gap record is a JSON object';
  const o = r as Record<string, unknown>;
  if (o['v'] !== 1) return 'v must be 1';
  for (const f of ['kind', 'program', 'what', 'commandLine', 'key']) if (typeof o[f] !== 'string') return `${f} must be a string`;
  const c = o['context'] as Record<string, unknown> | undefined;
  if (typeof c !== 'object' || c === null || typeof c['machine'] !== 'string' || typeof c['virtualTime'] !== 'number') return 'context needs machine and virtualTime';
  const e = o['engine'] as Record<string, unknown> | undefined;
  if (typeof e !== 'object' || e === null || typeof e['version'] !== 'string' || typeof e['kubernetes'] !== 'string') return 'engine needs version and kubernetes';
  return undefined;
}

/** Appends the records, each with `at` (ISO 8601) set to `now`. */
export function appendGaps(dataDir: string, records: readonly GapPost[], now: Date = new Date()): void {
  const at = now.toISOString();
  appendLines(join(dataDir, 'gaps.jsonl'), records.map((r) => JSON.stringify({ ...r, at })));
}
