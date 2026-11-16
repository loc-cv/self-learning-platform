// Parsing content files: YAML 1.2 into plain data, and pack.yaml.

import { parseDocument } from 'yaml';
import type { Json } from '@simlab/kernel';

/** `pack.yaml`: the pack and the skills it defines (phase 11 adds the rest). */
export interface Pack {
  id: string;
  title: string;
  skills: { id: string; title: string }[];
}

export class ContentSyntaxError extends Error {}

/** Parses one YAML 1.2 document as plain JSON data; duplicate keys and syntax errors throw. */
export function parseYaml(text: string, file: string): Json {
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: true, prettyErrors: true });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new ContentSyntaxError(`${file}: ${problem.message}`);
  return doc.toJSON() as Json;
}

export function parsePack(text: string, file: string): Pack {
  const raw = parseYaml(text, file) as unknown as Pack;
  if (typeof raw?.id !== 'string' || typeof raw.title !== 'string' || !Array.isArray(raw.skills)) throw new ContentSyntaxError(`${file}: a pack needs id, title and skills`);
  for (const s of raw.skills) if (typeof s?.id !== 'string' || typeof s.title !== 'string') throw new ContentSyntaxError(`${file}: every skill needs id and title`);
  return raw;
}
