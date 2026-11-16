// k8s.unchanged: the objects selected in the baseline (the world as setup left it) are the objects
// selected now, with the same uids, and every path yields the same values now as then. It encodes
// a ticket's constraint ("do not remove the taint", "leave the ConfigMap alone").

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { argScope, baselineKernel, evalError, firstFew, isError, nameOf, select, selectionPhrase, shortJson, uidOf, withClient, type Selection } from './common.ts';
import { canonicalJson, evaluate, parsePath, type Step } from './jsonpath.ts';
import { SELECTION_PROPERTIES } from './object.ts';

interface UnchangedArgs extends Selection {
  paths: string[];
}

const SCHEMA: JsonObject = {
  type: 'object',
  description:
    'The objects selected after setup (by name, selector, or all of the kind in the namespace) are the objects selected now, with the same metadata.uid, and every path yields the same values. Nothing selected after setup is an error in the item.',
  properties: {
    ...SELECTION_PROPERTIES,
    paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'JSONPaths in kubectl -o jsonpath syntax ({.spec.taints}) whose values must not change.' },
  },
  required: ['kind', 'paths'],
  additionalProperties: false,
};

/** The values a path yields, as short JSON: one value as itself, several as a list, none as "unset". */
function shown(values: Json[]): string {
  if (values.length === 0) return 'unset';
  return shortJson(values.length === 1 ? canonicalJson(values[0] as Json) : canonicalJson(values), 60);
}

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as UnchangedArgs;
  const what = `${a.name !== undefined ? `${a.kind} ${a.name}` : `every ${a.kind}${selectionPhrase(a)}`}${argScope(a)}`;
  const expected = `${what} is the object setup left, with ${a.paths.join(', ')} unchanged`;
  const steps: Step[][] = [];
  for (const p of a.paths) {
    const parsed = parsePath(p);
    if ('error' in parsed) return evalError(expected, parsed.error);
    steps.push(parsed.steps);
  }
  const before = withClient(baselineKernel(ctx.baseline, ctx.registry), (client) => select(client, a));
  if (isError(before)) return evalError(expected, `after setup: ${before.error}`);
  if (before.objects.length === 0) return evalError(expected, `no ${a.kind}${selectionPhrase(a)}${argScope(a)} existed after setup`);
  const now = withClient(ctx.kernel, (client) => select(client, a));
  if (isError(now)) return evalError(expected, now.error);
  const nowByName = new Map(now.objects.map((o) => [nameOf(o), o] as const));
  const beforeNames = new Set(before.objects.map(nameOf));
  const diffs: string[] = [];
  for (const old of before.objects) {
    const name = nameOf(old);
    const cur = nowByName.get(name);
    if (!cur) {
      diffs.push(`${name} was deleted`);
      continue;
    }
    if (uidOf(cur) !== uidOf(old)) {
      diffs.push(`${name} was deleted and created again`);
      continue;
    }
    a.paths.forEach((p, i) => {
      const was = evaluate(old, steps[i] as Step[]);
      const is = evaluate(cur, steps[i] as Step[]);
      if (canonicalJson(was) !== canonicalJson(is)) diffs.push(`${p} of ${name} was ${shown(was)}, is now ${shown(is)}`);
    });
  }
  for (const o of now.objects) if (!beforeNames.has(nameOf(o))) diffs.push(`${nameOf(o)} was added`);
  if (diffs.length > 0) return { pass: false, expected, observed: firstFew(diffs) };
  const n = before.objects.length;
  return { pass: true, expected, observed: `${n === 1 ? nameOf(before.objects[0] as JsonObject) : `all ${n} objects`} unchanged` };
}

export const unchangedCheck: CheckSpec = { name: 'k8s.unchanged', args: SCHEMA, run };
