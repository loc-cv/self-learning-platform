import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { CHECK, createRegistry, FAULT } from '@simlab/kernel';
import { itemSchema } from '@simlab/learn';
import { contentRegistry, CONTENT_PLUGINS } from '../content/registry.ts';
import { codeSpans, extractBlocks, placeholders, sourceHash, strings, textUnit, whens } from './examples.ts';
import { PLANNED_CHECKS, PLANNED_FAULTS, plannedPlugin } from './planned.ts';

type Obj = Record<string, unknown>;
const read = (rel: string): string => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

const blocks = extractBlocks(read('docs/SCENARIO_FORMAT.md'));
const items = blocks.filter((b) => b.kind === 'item').map((b) => parse(b.source) as Obj);
const sidecars = blocks.filter((b) => b.kind === 'sidecar').map((b) => parse(b.source) as Obj);

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
// The examples use checks of later phases: validate them with those stand-ins added (planned.ts).
const validateItem = ajv.compile(itemSchema(createRegistry([...CONTENT_PLUGINS, plannedPlugin])) as Obj);
const validateSidecar = ajv.compile(JSON.parse(read('docs/schema/sidecar.schema.json')) as Obj);

interface Curriculum {
  exams: Record<string, { domains: { weight: number; competencies: { id: string }[] }[] }>;
}
const curriculum = parse(read('docs/curriculum/competencies.yaml')) as Curriculum;
const competencyIds = new Set(
  Object.values(curriculum.exams).flatMap((e) => e.domains.flatMap((d) => d.competencies.map((c) => c.id))),
);

const paramsOf = (item: Obj): Record<string, { pick?: unknown[] }> =>
  ((item['world'] as Obj)['params'] ?? {}) as Record<string, { pick?: unknown[] }>;

test('no planned check or fault is registered for real yet (its phase removes it from planned.ts)', () => {
  for (const c of PLANNED_CHECKS) expect(contentRegistry.get(CHECK, c.name), `${c.name} (phase ${c.phase})`).toBeUndefined();
  for (const f of PLANNED_FAULTS) expect(contentRegistry.get(FAULT, f.name), `${f.name} (phase ${f.phase})`).toBeUndefined();
});

test('the spec contains the three worked examples and a sidecar', () => {
  expect(items.map((i) => i['kind'])).toEqual(['lab', 'lab', 'incident']);
  expect(sidecars).toHaveLength(1);
});

describe.each(items.map((i) => [i['id'] as string, i] as const))('%s', (_id, item) => {
  test('satisfies item.schema.json', () => {
    validateItem(item);
    expect(validateItem.errors ?? []).toEqual([]);
  });

  test('every placeholder names a declared parameter', () => {
    const declared = Object.keys(paramsOf(item));
    const used = strings(item).flatMap((s) => placeholders(s.text).map((name) => `${name} (${s.path})`));
    expect(used.filter((u) => !declared.includes(u.split(' ')[0] as string))).toEqual([]);
  });

  test('every declared parameter is used', () => {
    const used = new Set(strings(item).flatMap((s) => placeholders(s.text)));
    const inWhen = new Set(whens(item).flatMap((w) => Object.keys(w)));
    expect(Object.keys(paramsOf(item)).filter((p) => !used.has(p) && !inWhen.has(p))).toEqual([]);
  });

  test('every `when` names a pick parameter and one of its options', () => {
    const params = paramsOf(item);
    for (const when of whens(item)) {
      for (const [name, value] of Object.entries(when)) {
        const options = params[name]?.pick;
        expect(options, `when.${name}`).toBeDefined();
        for (const v of Array.isArray(value) ? value : [value]) expect(options).toContain(v);
      }
    }
  });

  test('curriculum ids exist in docs/curriculum/competencies.yaml', () => {
    expect((item['curriculum'] as string[]).filter((c) => !competencyIds.has(c))).toEqual([]);
  });

  test('check ids are unique', () => {
    const ids = (item['checks'] as Obj[]).map((c) => c['id']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('embedded manifests are valid YAML for every parameter value', () => {
    const params = paramsOf(item);
    const sample = (text: string): string =>
      text.replace(/(?<!\\)\{\{([^}]*)\}\}/g, (_m, name: string) => String(params[name.trim()]?.pick?.[0] ?? 3));
    const bodies = strings(item).filter((s) => /(\.apply|write\.content)$/.test(s.path));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      for (const doc of parseAllDocuments(sample(body.text))) {
        expect(doc.errors.map((e) => `${body.path}: ${e.message}`)).toEqual([]);
        const manifest = doc.toJS() as Obj;
        expect(typeof manifest['apiVersion'], body.path).toBe('string');
        expect(typeof manifest['kind'], body.path).toBe('string');
      }
    }
  });

  test('every fault variant has a solution and a full hint ladder', () => {
    const variants = [...new Set(whens(item).flatMap((w) => Object.entries(w).map(([k, v]) => [k, v] as const)))];
    const applies = (block: unknown, name: string, value: unknown): boolean => {
      const when = typeof block === 'object' && block !== null ? (block as Obj)['when'] : undefined;
      if (when === undefined) return true;
      const cond = (when as Obj)[name];
      return cond === undefined || (Array.isArray(cond) ? cond.includes(value) : cond === value);
    };
    for (const [name, raw] of variants) {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        expect((item['solutions'] as unknown[]).some((s) => applies(s, name, value)), `${name}=${String(value)}`).toBe(true);
        const hints = (item['hints'] as unknown[]).filter((h) => applies(h, name, value));
        expect(hints.length, `hints for ${name}=${String(value)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe.each(sidecars.map((s) => [s['id'] as string, s] as const))('sidecar %s', (id, sidecar) => {
  const item = items.find((i) => i['id'] === id);
  const units = sidecar['units'] as Record<string, { source: string; text: string }>;

  test('satisfies sidecar.schema.json and belongs to an example', () => {
    validateSidecar(sidecar);
    expect(validateSidecar.errors ?? []).toEqual([]);
    expect(item).toBeDefined();
  });

  test.each(Object.keys(units))('%s is current, keeps placeholders and code spans', (key) => {
    const english = textUnit(item as Obj, key);
    expect(english, `no such unit: ${key}`).toBeDefined();
    const unit = units[key] as { source: string; text: string };
    expect(unit.source).toBe(sourceHash(english as string));
    expect(placeholders(unit.text).sort()).toEqual(placeholders(english as string).sort());
    expect(codeSpans(unit.text).sort()).toEqual(codeSpans(english as string).sort());
  });
});

test('curriculum weights add up to 100 per exam', () => {
  for (const exam of Object.values(curriculum.exams)) {
    expect(exam.domains.reduce((sum, d) => sum + d.weight, 0)).toBe(100);
  }
});
