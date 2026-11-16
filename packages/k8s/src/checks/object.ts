// k8s.object: the selected objects exist in the expected number and every `where` clause holds
// for each (docs/SCENARIO_FORMAT.md §7.1).

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { argScope, COUNT_PROPERTIES, countError, countHolds, countPhrase, evalError, firstFew, isError, kindNoun, nameList, nameOf, scopePhrase, select, selectionPhrase, withClient, type CountArgs, type Selection } from './common.ts';
import { compileWhere, valuesPhrase, WHERE_SCHEMA, whereHolds, wherePhrase, type CompiledWhere, type WhereClause } from './where.ts';

/** The selection properties k8s.object, k8s.unchanged and k8s.notRecreated share. */
export const SELECTION_PROPERTIES: JsonObject = {
  kind: { type: 'string', minLength: 1, description: 'The kind, as in a manifest: Deployment, ConfigMap, Node.' },
  apiVersion: { type: 'string', minLength: 1, description: 'The group version (apps/v1, v1). Default: the first group version serving the kind, core first.' },
  namespace: { type: 'string', minLength: 1, description: 'The namespace of a namespaced kind (default: default). Not allowed for a cluster-scoped kind.' },
  name: { type: 'string', minLength: 1, description: 'One object by name. Excludes selector.' },
  selector: { type: 'string', minLength: 1, description: 'A label selector (app=web,tier!=db), parsed by the API server. Excludes name.' },
};

interface ObjectArgs extends Selection, CountArgs {
  exists?: boolean;
  where?: WhereClause[];
}

const SCHEMA: JsonObject = {
  type: 'object',
  description:
    'The objects of a kind selected by name, by selector, or all in the namespace (cluster-wide for a cluster-scoped kind), terminating ones included, exist in the expected number (default: at least one; with exists: false, none) and every where clause holds for each.',
  properties: {
    ...SELECTION_PROPERTIES,
    exists: { type: 'boolean', description: 'false: no selected object exists (then count, min, max and where are not allowed). Default true.' },
    ...COUNT_PROPERTIES,
    where: { type: 'array', minItems: 1, items: WHERE_SCHEMA, description: 'Clauses every selected object must satisfy.' },
  },
  required: ['kind'],
  additionalProperties: false,
};

function expectedOf(a: ObjectArgs): string {
  const what = `${a.kind}${selectionPhrase(a)}${argScope(a)}`;
  if (a.exists === false) return `no ${what}`;
  const counted = `${countPhrase(a, kindNoun(a.kind))}${selectionPhrase(a)}${argScope(a)}`;
  const where = a.where?.length ? `, each with ${a.where.map(wherePhrase).join(' and ')}` : '';
  return `${counted}${where}`;
}

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as ObjectArgs;
  const expected = expectedOf(a);
  if (a.exists === false && (a.where !== undefined || a.count !== undefined || a.min !== undefined || a.max !== undefined)) return evalError(expected, 'exists: false excludes count, min, max and where');
  const ce = countError(a);
  if (ce) return evalError(expected, ce);
  const compiled: CompiledWhere[] = [];
  for (const w of a.where ?? []) {
    const c = compileWhere(w);
    if ('error' in c) return evalError(expected, c.error);
    compiled.push(c);
  }
  const sel = withClient(ctx.kernel, (client) => select(client, a));
  if (isError(sel)) return evalError(expected, sel.error);
  const names = sel.objects.map(nameOf);
  const n = names.length;
  const found = n === 0 ? `no ${a.kind}${selectionPhrase(a)} ${scopePhrase(sel.namespace)}` : `found ${n} ${kindNoun(a.kind)(n)}: ${nameList(names)}`;
  if (a.exists === false) return { pass: n === 0, expected, observed: n === 0 ? `${found} exists` : found };
  if (!countHolds(a, n)) return { pass: false, expected, observed: found };
  const failures: string[] = [];
  for (const obj of sel.objects) {
    for (const w of compiled) {
      const r = whereHolds(w, obj);
      if (!r.holds) failures.push(`${nameOf(obj)}: ${valuesPhrase(w.clause.path, r.values)}`);
    }
  }
  if (failures.length > 0) return { pass: false, expected, observed: firstFew(failures) };
  return { pass: true, expected, observed: compiled.length > 0 ? `${found}; every clause holds` : found };
}

export const objectCheck: CheckSpec = { name: 'k8s.object', args: SCHEMA, run };
