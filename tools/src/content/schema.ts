// npm run content:schema [-- --check]
//
// Writes the JSON Schemas under docs/schema/ from the code that validates with them, so they
// cannot drift: item.schema.json from the registry (docs/SCENARIO_FORMAT.md §9: the layouts of
// packages/learn/src/item/ plus the catalogs the plugins register), sidecar.schema.json and
// pack.schema.json from the learning layer's own schemas. With --check it writes nothing and
// exits 1 when a file is stale; a test runs the same comparison.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { itemSchema, PACK_SCHEMA, SIDECAR_SCHEMA } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

const path = (name: string): string => fileURLToPath(new URL(`../../../docs/schema/${name}`, import.meta.url));
const text = (schema: unknown): string => `${JSON.stringify(schema, null, 2)}\n`;

export const SCHEMA_PATH = path('item.schema.json');

export function schemaText(): string {
  return text(itemSchema(contentRegistry));
}

/** Every generated schema file: where it is and what it must hold. */
export function schemaFiles(): { name: string; path: string; text: string }[] {
  return [
    { name: 'item.schema.json', path: SCHEMA_PATH, text: schemaText() },
    { name: 'sidecar.schema.json', path: path('sidecar.schema.json'), text: text(SIDECAR_SCHEMA) },
    { name: 'pack.schema.json', path: path('pack.schema.json'), text: text(PACK_SCHEMA) },
  ];
}

if (import.meta.main) {
  const read = (p: string): string => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  for (const f of schemaFiles()) {
    if (read(f.path) === f.text) continue;
    if (process.argv.includes('--check')) {
      console.error(`docs/schema/${f.name} is stale: run npm run content:schema`);
      process.exitCode = 1;
    } else {
      writeFileSync(f.path, f.text);
      console.log(`wrote docs/schema/${f.name}`);
    }
  }
}
