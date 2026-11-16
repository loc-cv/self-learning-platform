// npm run content:schema [-- --check]
//
// Writes docs/schema/item.schema.json from the registry (docs/SCENARIO_FORMAT.md §9): the item
// layout of packages/learn/src/item/schema.base.ts plus the catalogs the plugins register. With
// --check it writes nothing and exits 1 when the file is stale; a test runs the same comparison.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { itemSchema } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

export const SCHEMA_PATH = fileURLToPath(new URL('../../../docs/schema/item.schema.json', import.meta.url));

export function schemaText(): string {
  return `${JSON.stringify(itemSchema(contentRegistry), null, 2)}\n`;
}

if (import.meta.main) {
  const next = schemaText();
  const now = readFileSync(SCHEMA_PATH, 'utf8');
  if (process.argv.includes('--check')) {
    if (next !== now) {
      console.error('docs/schema/item.schema.json is stale: run npm run content:schema');
      process.exitCode = 1;
    }
  } else if (next !== now) {
    writeFileSync(SCHEMA_PATH, next);
    console.log('wrote docs/schema/item.schema.json');
  }
}
