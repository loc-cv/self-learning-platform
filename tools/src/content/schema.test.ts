// docs/schema/item.schema.json is generated from the registry and must be current; the engine's
// own schema validator (packages/learn/src/item/jsonschema.ts) must agree with Ajv on every item
// and on broken variants of them.

import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { createRegistry, type Json } from '@simlab/kernel';
import { loadPacks } from '@simlab/content';
import { itemSchema, validateSchema } from '@simlab/learn';
import { CONTENT_PLUGINS } from './registry.ts';
import { schemaText, SCHEMA_PATH } from './schema.ts';
import { extractBlocks } from '../docs/examples.ts';
import { plannedPlugin } from '../docs/planned.ts';

test('docs/schema/item.schema.json is current (npm run content:schema)', () => {
  expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(schemaText());
});

const schema = itemSchema(createRegistry([...CONTENT_PLUGINS, plannedPlugin]));
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
const ajvValidate = ajv.compile(schema);

const labs = loadPacks().flatMap((p) => p.items.map((i) => [i.fileId, i.raw] as const));
const examples = extractBlocks(readFileSync(new URL('../../../docs/SCENARIO_FORMAT.md', import.meta.url), 'utf8'))
  .filter((b) => b.kind === 'item')
  .map((b) => parse(b.source) as Json)
  .map((raw) => [String((raw as { id: string }).id), raw] as const);

type Obj = Record<string, unknown>;
const breakages: [string, (i: Obj) => void][] = [
  ['an unknown top-level field', (i) => (i['colour'] = 'blue')],
  ['an unknown check', (i) => ((i['checks'] as Obj[])[0] as Obj)['assert'] = 'k8s.nope'],
  ['a check argument of the wrong type', (i) => (((i['checks'] as Obj[])[0] as Obj)['with'] = { kind: 3 })],
  ['an unknown step modifier', (i) => (((i['solutions'] as Obj[])[0] as Obj)['steps'] = [{ run: 'true', on: 'x', colour: 'y' }])],
  ['a step with two kinds', (i) => (((i['solutions'] as Obj[])[0] as Obj)['steps'] = [{ run: 'true', advance: '1s' }])],
  ['a bad duration', (i) => (((i['checks'] as Obj[])[0] as Obj)['within'] = 'soon')],
  ['a zero weight', (i) => (((i['checks'] as Obj[])[0] as Obj)['weight'] = 0)],
  ['an unknown topology', (i) => ((i['world'] as Obj)['topology'] = 'kind-3')],
];

describe.each([...labs, ...examples])('%s', (_id, raw) => {
  test('Ajv and the engine agree that it is valid', () => {
    expect(ajvValidate(raw), JSON.stringify(ajvValidate.errors)).toBe(true);
    expect(validateSchema(schema, raw)).toEqual([]);
  });

  test.each(breakages)('both refuse it with %s', (_what, breakIt) => {
    const broken = JSON.parse(JSON.stringify(raw)) as Obj;
    breakIt(broken);
    expect(ajvValidate(broken)).toBe(false);
    expect(validateSchema(schema, broken as Json).length).toBeGreaterThan(0);
  });
});
