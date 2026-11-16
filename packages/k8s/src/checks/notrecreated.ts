// k8s.notRecreated: the object exists now with the uid it had when setup ended. Deleting and
// creating an object again (instead of changing it in place) is a shortcut some tickets forbid.

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { argScope, baselineKernel, evalError, isError, select, uidOf, withClient, type Selection } from './common.ts';
import { SELECTION_PROPERTIES } from './object.ts';

interface NotRecreatedArgs extends Selection {
  name: string;
}

const { selector: _selector, ...properties } = SELECTION_PROPERTIES;

const SCHEMA: JsonObject = {
  type: 'object',
  description: 'The object exists now with the metadata.uid it had after setup: it was not deleted, nor deleted and created again. An object absent after setup is an error in the item.',
  properties: { ...properties, name: { type: 'string', minLength: 1, description: 'The name of the object.' } },
  required: ['kind', 'name'],
  additionalProperties: false,
};

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as NotRecreatedArgs;
  const what = `${a.kind} ${a.name}${argScope(a)}`;
  const expected = `${what} is the object setup left (same uid)`;
  const before = withClient(baselineKernel(ctx.baseline, ctx.registry), (client) => select(client, a));
  if (isError(before)) return evalError(expected, `after setup: ${before.error}`);
  const old = before.objects[0];
  if (!old) return evalError(expected, `${what} did not exist after setup`);
  const now = withClient(ctx.kernel, (client) => select(client, a));
  if (isError(now)) return evalError(expected, now.error);
  const cur = now.objects[0] as JsonObject | undefined;
  if (!cur) return { pass: false, expected, observed: `${a.name} was deleted` };
  if (uidOf(cur) !== uidOf(old)) return { pass: false, expected, observed: `${a.name} was deleted and created again (uid ${uidOf(old)}, now ${uidOf(cur)})` };
  return { pass: true, expected, observed: `${a.name} still has uid ${uidOf(cur)}` };
}

export const notRecreatedCheck: CheckSpec = { name: 'k8s.notRecreated', args: SCHEMA, run };
