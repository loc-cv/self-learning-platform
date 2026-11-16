// `where` clauses of k8s.object: a JSONPath and one operator, held by every value the path yields
// (docs/SCENARIO_FORMAT.md §7.1). Scalars compare by the text kubectl's jsonpath prints for them,
// so `equals: 3` matches 3 and "3"; objects and lists compare as JSON with sorted keys.

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { evaluate, parsePath, textOf, type Step } from './jsonpath.ts';
import { shortJson } from './common.ts';

export interface WhereClause {
  path: string;
  equals?: Json;
  notEquals?: Json;
  in?: Json[];
  contains?: Json;
  matches?: string;
  exists?: boolean;
  gte?: number;
  lte?: number;
}

export const OPERATORS = ['equals', 'notEquals', 'in', 'contains', 'matches', 'exists', 'gte', 'lte'] as const;
type Operator = (typeof OPERATORS)[number];

export const WHERE_SCHEMA: JsonObject = {
  type: 'object',
  description: 'A JSONPath and exactly one operator. A path that yields several values holds when every value satisfies the operator; one that yields nothing fails every operator except exists: false and notEquals.',
  properties: {
    path: { type: 'string', minLength: 1, description: "JSONPath in kubectl -o jsonpath syntax: {.a.b}, {.a[0]}, {.a[*].b}, {.a['x.y']}, {.metadata.labels.app\\.kubernetes\\.io/name}." },
    equals: { description: 'The value, compared as the text kubectl -o jsonpath prints (3 matches 3 and "3"); objects and lists compare as JSON.' },
    notEquals: { description: 'Not this value (compared like equals). Holds when the path yields nothing.' },
    in: { type: 'array', minItems: 1, description: 'One of these values (compared like equals).' },
    contains: { description: 'A substring of a string value, or an element of a list value.' },
    matches: { type: 'string', minLength: 1, description: 'A JavaScript regular expression the text of the value matches (unanchored).' },
    exists: { type: 'boolean', description: 'true: the path yields at least one value; false: it yields none.' },
    gte: { type: 'number', description: 'A number (or numeric string) greater than or equal to this.' },
    lte: { type: 'number', description: 'A number (or numeric string) less than or equal to this.' },
  },
  required: ['path'],
  additionalProperties: false,
  minProperties: 2,
};

export interface CompiledWhere {
  clause: WhereClause;
  op: Operator;
  steps: Step[];
  regex?: RegExp;
}

/** Parses the path and the operator; an error names what cannot be evaluated. */
export function compileWhere(clause: WhereClause): CompiledWhere | { error: string } {
  const ops = OPERATORS.filter((o) => clause[o] !== undefined);
  if (ops.length !== 1) return { error: `where clause ${JSON.stringify(clause.path)} needs exactly one operator (${OPERATORS.join(', ')}), got ${ops.length}` };
  const op = ops[0] as Operator;
  const parsed = parsePath(clause.path);
  if ('error' in parsed) return parsed;
  if (op === 'matches') {
    try {
      return { clause, op, steps: parsed.steps, regex: new RegExp(clause.matches as string) };
    } catch (e) {
      return { error: `invalid regular expression ${JSON.stringify(clause.matches)}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { clause, op, steps: parsed.steps };
}

const same = (a: Json, b: Json): boolean => textOf(a) === textOf(b);

function numberOf(v: Json): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return Number(v);
  return undefined;
}

function holdsFor(w: CompiledWhere, v: Json): boolean {
  const c = w.clause;
  switch (w.op) {
    case 'equals':
      return same(v, c.equals as Json);
    case 'notEquals':
      return !same(v, c.notEquals as Json);
    case 'in':
      return (c.in as Json[]).some((x) => same(v, x));
    case 'contains':
      if (typeof v === 'string') return v.includes(textOf(c.contains as Json));
      if (Array.isArray(v)) return v.some((x) => same(x, c.contains as Json));
      return false;
    case 'matches':
      return (w.regex as RegExp).test(textOf(v));
    case 'exists':
      return true;
    case 'gte': {
      const n = numberOf(v);
      return n !== undefined && n >= (c.gte as number);
    }
    case 'lte': {
      const n = numberOf(v);
      return n !== undefined && n <= (c.lte as number);
    }
  }
}

/** Whether the clause holds for the object. */
export function whereHolds(w: CompiledWhere, obj: JsonObject): { holds: boolean; values: Json[] } {
  const values = evaluate(obj, w.steps);
  if (w.op === 'exists') return { holds: (values.length > 0) === w.clause.exists, values };
  if (values.length === 0) return { holds: w.op === 'notEquals', values };
  return { holds: values.every((v) => holdsFor(w, v)), values };
}

const quote = (v: Json): string => (typeof v === 'string' ? JSON.stringify(v) : textOf(v));

/** The requirement in words: `{.spec.replicas} equals 3`. */
export function wherePhrase(w: WhereClause): string {
  const p = w.path;
  if (w.equals !== undefined) return `${p} equals ${quote(w.equals)}`;
  if (w.notEquals !== undefined) return `${p} is not ${quote(w.notEquals)}`;
  if (w.in !== undefined) return `${p} is one of ${w.in.map(quote).join(', ')}`;
  if (w.contains !== undefined) return `${p} contains ${quote(w.contains)}`;
  if (w.matches !== undefined) return `${p} matches /${w.matches}/`;
  if (w.exists !== undefined) return w.exists ? `${p} is set` : `${p} is not set`;
  if (w.gte !== undefined) return `${p} >= ${w.gte}`;
  if (w.lte !== undefined) return `${p} <= ${w.lte}`;
  return p;
}

/** What the path yielded, for `observed`: `{.spec.replicas} is 2`, `{.spec.x} is not set`. */
export function valuesPhrase(path: string, values: Json[]): string {
  if (values.length === 0) return `${path} is not set`;
  if (values.length === 1) return `${path} is ${shortJson(quote(values[0] as Json))}`;
  return `${path} is ${shortJson(values.map(quote).join(' '))}`;
}
