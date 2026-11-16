// A JSON Schema (2020-12) validator for the subset the item schema and the registered argument
// schemas use, so the engine needs no dependency (D-093): type, enum, const, properties,
// required, additionalProperties, propertyNames, minProperties, items, minItems, uniqueItems,
// minLength, pattern, minimum, maximum, exclusiveMinimum, allOf, anyOf, oneOf, if/then and local
// `$ref`s. Annotations (title, description, $schema, $id) are ignored. A keyword outside the
// subset is an error, so the validator cannot silently accept what it does not understand.
// tools/src/content/schema.test.ts checks it against Ajv on every item and example.

import type { Json } from '@simlab/kernel';

type Schema = { [key: string]: Json };

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$defs', '$comment']);
const KNOWN = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'propertyNames', 'minProperties',
  'items', 'minItems', 'uniqueItems', 'minLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'allOf', 'anyOf', 'oneOf', 'if', 'then', '$ref',
]);

export interface SchemaError {
  /** JSON pointer-like path into the instance: `checks[2].with.count`. */
  path: string;
  message: string;
}

const isObject = (v: Json | undefined): v is Schema => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function hasType(v: Json, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function equal(a: Json, b: Json): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(v: Json): Json {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k] as Json)]));
  return v;
}

const join = (path: string, key: string | number): string => (typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`);

export function validateSchema(root: Schema, value: Json): SchemaError[] {
  const errors: SchemaError[] = [];
  const resolve = (ref: string): Schema => {
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
    let node: Json | undefined = root;
    for (const part of ref.slice(2).split('/')) node = isObject(node) ? node[part] : undefined;
    if (!isObject(node)) throw new Error(`unresolved $ref ${ref}`);
    return node;
  };

  const check = (schema: Json, v: Json, path: string, out: SchemaError[]): void => {
    if (schema === true || (isObject(schema) && Object.keys(schema).every((k) => ANNOTATIONS.has(k)))) return;
    if (schema === false) {
      out.push({ path, message: 'is not allowed' });
      return;
    }
    if (!isObject(schema)) throw new Error(`not a schema at ${path}`);
    for (const k of Object.keys(schema)) if (!KNOWN.has(k) && !ANNOTATIONS.has(k)) throw new Error(`unsupported schema keyword ${k}`);
    const fail = (message: string): void => {
      out.push({ path, message });
    };
    if (typeof schema['$ref'] === 'string') check(resolve(schema['$ref']), v, path, out);
    const type = schema['type'];
    if (type !== undefined) {
      const types = Array.isArray(type) ? (type as string[]) : [type as string];
      if (!types.some((t) => hasType(v, t))) {
        fail(`must be ${types.join(' or ')}, is ${typeOf(v)}`);
        return;
      }
    }
    if (Array.isArray(schema['enum']) && !schema['enum'].some((e) => equal(e, v))) fail(`must be one of ${schema['enum'].map((e) => JSON.stringify(e)).join(', ')}`);
    if ('const' in schema && !equal(schema['const'] as Json, v)) fail(`must be ${JSON.stringify(schema['const'])}`);
    if (typeof v === 'string') {
      if (typeof schema['minLength'] === 'number' && [...v].length < schema['minLength']) fail(schema['minLength'] === 1 ? 'must not be empty' : `must be at least ${schema['minLength']} characters`);
      if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(v)) fail(`must match ${schema['pattern']}`);
    }
    if (typeof v === 'number') {
      if (typeof schema['minimum'] === 'number' && v < schema['minimum']) fail(`must be at least ${schema['minimum']}`);
      if (typeof schema['maximum'] === 'number' && v > schema['maximum']) fail(`must be at most ${schema['maximum']}`);
      if (typeof schema['exclusiveMinimum'] === 'number' && v <= schema['exclusiveMinimum']) fail(`must be greater than ${schema['exclusiveMinimum']}`);
    }
    if (Array.isArray(v)) {
      if (typeof schema['minItems'] === 'number' && v.length < schema['minItems']) fail(`must have at least ${schema['minItems']} item${schema['minItems'] === 1 ? '' : 's'}`);
      if (schema['uniqueItems'] === true) {
        const seen = new Set<string>();
        for (const item of v) {
          const key = JSON.stringify(canonical(item));
          if (seen.has(key)) fail(`must not repeat ${key}`);
          seen.add(key);
        }
      }
      if (schema['items'] !== undefined) v.forEach((item, i) => check(schema['items'] as Json, item, join(path, i), out));
    }
    if (isObject(v)) {
      const props = isObject(schema['properties']) ? schema['properties'] : {};
      if (Array.isArray(schema['required'])) for (const r of schema['required'] as string[]) if (!Object.hasOwn(v, r)) fail(`needs ${r}`);
      if (typeof schema['minProperties'] === 'number' && Object.keys(v).length < schema['minProperties']) fail(`must have at least ${schema['minProperties']} propert${schema['minProperties'] === 1 ? 'y' : 'ies'}`);
      for (const [k, item] of Object.entries(v)) {
        if (schema['propertyNames'] !== undefined) {
          const sub: SchemaError[] = [];
          check(schema['propertyNames'], k, join(path, k), sub);
          if (sub.length > 0) out.push({ path: join(path, k), message: `name ${sub[0]?.message ?? 'is invalid'}` });
        }
        if (Object.hasOwn(props, k)) check(props[k] as Json, item, join(path, k), out);
        else if (schema['additionalProperties'] === false) out.push({ path: join(path, k), message: 'is not a known field' });
        else if (schema['additionalProperties'] !== undefined) check(schema['additionalProperties'], item, join(path, k), out);
      }
    }
    if (Array.isArray(schema['allOf'])) for (const s of schema['allOf']) check(s, v, path, out);
    if (Array.isArray(schema['anyOf'])) {
      const tries = schema['anyOf'].map((s) => attempt(s, v, path));
      if (!tries.some((t) => t.length === 0)) out.push(...closest(tries, path));
    }
    if (Array.isArray(schema['oneOf'])) {
      const tries = schema['oneOf'].map((s) => attempt(s, v, path));
      const ok = tries.filter((t) => t.length === 0).length;
      if (ok === 0) out.push(...closest(tries, path, schema['oneOf']));
      else if (ok > 1) fail('matches more than one alternative');
    }
    if (schema['if'] !== undefined && attempt(schema['if'], v, path).length === 0 && schema['then'] !== undefined) check(schema['then'], v, path, out);
  };

  const attempt = (schema: Json, v: Json, path: string): SchemaError[] => {
    const sub: SchemaError[] = [];
    check(schema, v, path, sub);
    return sub;
  };

  /**
   * When no alternative fits, report the one that came closest: for steps, the alternative whose
   * kind key the value has (a `run` step with a bad modifier is reported as a `run` step).
   */
  const closest = (tries: SchemaError[][], path: string, alternatives?: Json[]): SchemaError[] => {
    if (alternatives) {
      // A discriminator: the alternative whose `const` property the value has (`kind: scene`).
      const own = at(value, path);
      const named = alternatives.findIndex((a) => {
        const props = isObject(a) && isObject(a['properties']) ? a['properties'] : undefined;
        return props !== undefined && isObject(own) && Object.entries(props).some(([k, p]) => isObject(p) && p['const'] !== undefined && own[k] === p['const']);
      });
      if (named >= 0 && (tries[named]?.length ?? 0) > 0) return tries[named] as SchemaError[];
      const keyed = alternatives.findIndex((a, i) => isObject(a) && Array.isArray(a['required']) && typeof a['required'][0] === 'string' && pathValueHas(path, a['required'][0] as string) && (tries[i]?.length ?? 0) > 0);
      if (keyed >= 0) return tries[keyed] as SchemaError[];
    }
    // Alternatives of the value's own type, whose errors are deeper inside it, come first.
    const deeper = tries.filter((t) => t.length > 0 && t.every((e) => e.path !== path));
    const pool = deeper.length > 0 ? deeper : tries;
    const best = pool.reduce((a, b) => (b.length < a.length ? b : a));
    return best.length === 1 ? best : [{ path, message: 'matches none of the allowed forms' }];
  };

  const pathValueHas = (path: string, key: string): boolean => {
    const v = at(value, path);
    return isObject(v) && Object.hasOwn(v, key);
  };

  check(root, value, '', errors);
  return errors;
}

/** The value at a path written by `join`. */
function at(value: Json, path: string): Json | undefined {
  if (path === '') return value;
  let node: Json | undefined = value;
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (m[2] !== undefined) node = Array.isArray(node) ? node[Number(m[2])] : undefined;
    else node = isObject(node) ? node[m[1] as string] : undefined;
  }
  return node;
}

export function formatSchemaErrors(errors: readonly SchemaError[]): string[] {
  return errors.map((e) => `${e.path === '' ? '(item)' : e.path} ${e.message}`);
}
