// item.schema.json from the registry (docs/SCENARIO_FORMAT.md §9): the item layout
// (schema.base.ts) plus the catalogs the plugins register. `$defs.step` is one alternative per
// step kind, `$defs.assertion` names every check and holds each one's argument schema. Raw items
// are validated against it before substitution, so a typed argument (an integer, a boolean, an
// enum) also accepts a placeholder there; after substitution each argument map is validated
// again against the check's or step's own schema (validate.ts).

import { CHECK, FAULT, STEP, TOPOLOGY, type ArgsSchema, type CheckSpec, type FaultSpec, type Json, type Registry, type StepSpec, type TopologySpec } from '@simlab/kernel';
import { ITEM_SCHEMA_BASE } from './schema.base.ts';
import { BUILTIN_STEP_NAMES } from '../runner/builtin.ts';

type Schema = { [key: string]: Json };

/** A whole-string placeholder, which takes the parameter's type after substitution. */
const WHOLE_PLACEHOLDER: Schema = { type: 'string', pattern: '^\\{\\{\\s*[a-z][a-zA-Z0-9]*\\s*\\}\\}$' };
/** A string with a placeholder somewhere, for patterned or enumerated strings. */
const SOME_PLACEHOLDER: Schema = { type: 'string', pattern: '\\{\\{' };

const isSchema = (v: Json | undefined): v is Schema => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Lets every typed or constrained leaf of an argument schema accept a placeholder too. */
export function withPlaceholders(schema: Json): Json {
  if (!isSchema(schema)) return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if ((k === 'properties' || k === '$defs') && isSchema(v)) out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, withPlaceholders(s)]));
    else if ((k === 'items' || k === 'additionalProperties') && isSchema(v)) out[k] = withPlaceholders(v);
    else if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(v)) out[k] = v.map(withPlaceholders);
    else out[k] = v;
  }
  const type = out['type'];
  const scalar = type === 'integer' || type === 'number' || type === 'boolean';
  const constrained = 'enum' in out || 'const' in out || (type === 'string' && 'pattern' in out);
  if (!scalar && !constrained) return out;
  const { description, ...rest } = out;
  return { ...(description !== undefined ? { description } : {}), anyOf: [rest, scalar ? WHOLE_PLACEHOLDER : SOME_PLACEHOLDER] };
}

const WHEN: Schema = { $ref: '#/$defs/when' };
const DURATION: Schema = { $ref: '#/$defs/duration' };

/** A step kind's schema in the item: its own map plus `when`. */
function stepAlternative(name: string, args: ArgsSchema): Schema {
  const s = withPlaceholders(args) as Schema;
  const properties = { ...(isSchema(s['properties']) ? s['properties'] : {}), when: WHEN };
  return { ...s, title: name, properties };
}

/** The `if assert is X then with matches X's arguments` chain. */
function namedArgs(key: string, specs: readonly { name: string; args: ArgsSchema }[]): Schema[] {
  return specs.map((c) => ({
    if: { properties: { [key]: { const: c.name } }, required: [key] },
    then: { properties: { with: withPlaceholders(c.args) } },
  }));
}

export function builtinStepSchemas(): Schema[] {
  return [
    {
      title: 'advance',
      type: 'object',
      description: 'Let virtual time pass.',
      properties: { advance: DURATION, when: WHEN },
      required: ['advance'],
      additionalProperties: false,
    },
    {
      title: 'until',
      type: 'object',
      description: 'Let time pass until the check holds; fails if it does not within `timeout`.',
      properties: {
        until: { allOf: [{ $ref: '#/$defs/assertion' }, { type: 'object', properties: { assert: {}, with: {}, not: {} }, additionalProperties: false }] },
        timeout: DURATION,
        when: WHEN,
      },
      required: ['until', 'timeout'],
      additionalProperties: false,
    },
  ];
}

export function itemSchema(registry: Registry): Schema {
  const checks = registry.list<CheckSpec>(CHECK);
  const steps = registry.list<StepSpec>(STEP).filter((s) => !BUILTIN_STEP_NAMES.includes(s.name));
  const faults = registry.list<FaultSpec>(FAULT);
  const topologies = registry.list<TopologySpec>(TOPOLOGY);
  const base = JSON.parse(JSON.stringify(ITEM_SCHEMA_BASE)) as Schema;
  const defs = base['$defs'] as Schema;
  const stepAlternatives: Schema[] = steps.map((s) => stepAlternative(s.name, s.args));
  if (faults.length > 0) {
    stepAlternatives.push({
      title: 'fault',
      type: 'object',
      properties: { fault: { enum: faults.map((f) => f.name) }, with: { type: 'object' }, when: WHEN },
      required: ['fault', 'with'],
      additionalProperties: false,
      allOf: namedArgs('fault', faults),
    });
  }
  stepAlternatives.push(...builtinStepSchemas());
  defs['step'] = { oneOf: stepAlternatives };
  defs['assertion'] = {
    type: 'object',
    properties: { assert: { enum: checks.map((c) => c.name) }, with: { type: 'object' }, not: { type: 'boolean' } },
    required: ['assert', 'with'],
    allOf: namedArgs('assert', checks),
  };
  const world = ((base['properties'] as Schema)['world'] as Schema)['properties'] as Schema;
  world['topology'] = { enum: topologies.map((t) => t.name) };
  return { ...base, $defs: { ...defs } };
}
