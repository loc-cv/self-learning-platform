// k8s.nodeHasTaint: every listed Node carries a taint with the key, and the value and effect when
// given (docs/SCENARIO_FORMAT.md §7.1). A missing Node fails.

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';
import { evalError, firstFew, isError, responseError, str, withClient } from './common.ts';

interface TaintArgs {
  nodes: string[];
  key: string;
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

const SCHEMA: JsonObject = {
  type: 'object',
  description: 'Every listed Node carries a taint with the key (and the value and effect, when given). A missing Node fails.',
  properties: {
    nodes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Node names.' },
    key: { type: 'string', minLength: 1, description: 'The taint key.' },
    value: { type: 'string', description: 'The taint value. Default: any.' },
    effect: { enum: ['NoSchedule', 'PreferNoSchedule', 'NoExecute'], description: 'The taint effect. Default: any.' },
  },
  required: ['nodes', 'key'],
  additionalProperties: false,
};

/** `key=value:Effect`, `key:Effect` without a value (upstream: staging/src/k8s.io/api/core/v1/taint.go Taint.ToString). */
export function taintString(t: JsonObject): string {
  const key = str(t.key);
  const value = str(t.value);
  const effect = str(t.effect);
  if (effect === '') return value === '' ? key : `${key}=${value}:`;
  return value === '' ? `${key}:${effect}` : `${key}=${value}:${effect}`;
}

function wanted(a: TaintArgs): string {
  return `${a.key}${a.value !== undefined ? `=${a.value}` : ''}${a.effect !== undefined ? `:${a.effect}` : ''}`;
}

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as TaintArgs;
  const which = a.nodes.length === 1 ? `Node ${a.nodes[0] as string} carries` : `Nodes ${a.nodes.join(', ')} each carry`;
  const expected = `${which} a taint ${wanted(a)}${a.value === undefined ? ' (any value)' : ''}${a.effect === undefined ? ' (any effect)' : ''}`;
  const got = withClient(ctx.kernel, (client) => {
    const out: { node: string; taints?: JsonObject[]; missing?: string }[] = [];
    for (const node of a.nodes) {
      const r = client.resource('v1/nodes').get(undefined, node);
      if (r.ok) {
        const spec = (r.object as JsonObject).spec;
        out.push({ node, taints: (isObject(spec) && Array.isArray(spec.taints) ? spec.taints.filter(isObject) : []) as JsonObject[] });
      } else if ('status' in r && r.code === 404) out.push({ node, missing: responseError(r) });
      else return { error: responseError(r) };
    }
    return { nodes: out };
  });
  if (isError(got)) return evalError(expected, got.error);
  const failures: string[] = [];
  for (const n of got.nodes) {
    if (n.missing !== undefined) {
      failures.push(n.missing);
      continue;
    }
    const taints = n.taints ?? [];
    const match = taints.some((t) => str(t.key) === a.key && (a.value === undefined || str(t.value) === a.value) && (a.effect === undefined || str(t.effect) === a.effect));
    if (match) continue;
    failures.push(taints.length === 0 ? `${n.node} has no taints` : `${n.node} has no taint ${wanted(a)}; its taints: ${taints.map(taintString).join(', ')}`);
  }
  if (failures.length > 0) return { pass: false, expected, observed: firstFew(failures) };
  return { pass: true, expected, observed: a.nodes.length === 1 ? `${a.nodes[0] as string} carries it` : `all ${a.nodes.length} Nodes carry it` };
}

export const nodeHasTaintCheck: CheckSpec = { name: 'k8s.nodeHasTaint', args: SCHEMA, run };
