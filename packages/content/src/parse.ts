// Parsing content files: YAML 1.2 into plain data, and pack.yaml.

import { parseDocument } from 'yaml';
import type { Json } from '@simlab/kernel';
import { parsePackManifest, type PackManifest } from '@simlab/learn';

/** `pack.yaml` (docs/LEARNING_MODEL.md §3): the pack, its skills with prerequisites and its tracks. */
export type Pack = PackManifest;

export class ContentSyntaxError extends Error {}

/** Parses one YAML 1.2 document as plain JSON data; duplicate keys and syntax errors throw. */
export function parseYaml(text: string, file: string): Json {
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: true, prettyErrors: true });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new ContentSyntaxError(`${file}: ${problem.message}`);
  return doc.toJSON() as Json;
}

/** A pack manifest that satisfies its schema; anything else throws with every problem. */
export function parsePack(text: string, file: string): Pack {
  const { pack, problems } = parsePackManifest(parseYaml(text, file));
  if (!pack) throw new ContentSyntaxError(`${file}: ${problems.join('; ')}`);
  return pack;
}
