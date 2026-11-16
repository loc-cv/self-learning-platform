// k8s.podsReady: how many Pods matching a selector have condition Ready=True and are not
// terminating (docs/SCENARIO_FORMAT.md §7.1). `observed` says why up to three Pods are not
// ready, quoting their status fields.

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';
import { COUNT_PROPERTIES, countError, countHolds, countPhrase, evalError, firstFew, isError, kindNoun, metaOf, nameOf, select, str, withClient, type CountArgs } from './common.ts';

interface PodsReadyArgs extends CountArgs {
  namespace: string;
  selector: string;
}

const SCHEMA: JsonObject = {
  type: 'object',
  description: 'The number of Pods matching the selector that have condition Ready=True and no deletionTimestamp (default: at least one).',
  properties: {
    namespace: { type: 'string', minLength: 1, description: 'The namespace of the Pods.' },
    selector: { type: 'string', minLength: 1, description: 'A label selector (app=web), parsed by the API server.' },
    ...COUNT_PROPERTIES,
  },
  required: ['namespace', 'selector'],
  additionalProperties: false,
};

const conditions = (pod: JsonObject): JsonObject[] => {
  const st = pod.status;
  return isObject(st) && Array.isArray(st.conditions) ? (st.conditions.filter(isObject) as JsonObject[]) : [];
};
const condition = (pod: JsonObject, type: string): JsonObject | undefined => conditions(pod).find((c) => c.type === type);

export function isTerminating(o: JsonObject): boolean {
  return metaOf(o).deletionTimestamp !== undefined;
}

/** Ready=True and not terminating. */
export function isPodReady(pod: JsonObject): boolean {
  return !isTerminating(pod) && condition(pod, 'Ready')?.status === 'True';
}

/** A waiting or failed container's reason, init containers first: `container nginx: ImagePullBackOff`. */
function containerReason(pod: JsonObject): string | undefined {
  const st = isObject(pod.status) ? pod.status : {};
  for (const field of ['initContainerStatuses', 'containerStatuses']) {
    const list = Array.isArray(st[field]) ? (st[field] as Json[]).filter(isObject) : [];
    for (const c of list as JsonObject[]) {
      const state = isObject(c.state) ? c.state : {};
      const waiting = state.waiting;
      if (isObject(waiting) && str(waiting.reason) !== '') return `container ${str(c.name)}: ${str(waiting.reason)}`;
      const terminated = state.terminated;
      if (field === 'containerStatuses' && isObject(terminated) && str(terminated.reason) !== '') return `container ${str(c.name)}: ${str(terminated.reason)}`;
    }
  }
  return undefined;
}

/** Why a Pod is not ready, from its status: `web-abc is Pending (PodScheduled False: Unschedulable)`. */
export function notReadyReason(pod: JsonObject): string {
  const phase = str(isObject(pod.status) ? pod.status.phase : undefined) || 'without a phase';
  const name = nameOf(pod);
  if (isTerminating(pod)) return `${name} is terminating`;
  const scheduled = condition(pod, 'PodScheduled');
  if (scheduled?.status === 'False') return `${name} is ${phase} (PodScheduled False: ${str(scheduled.reason) || str(scheduled.message)})`;
  const container = containerReason(pod);
  if (container) return `${name} is ${phase} (${container})`;
  const ready = condition(pod, 'Ready');
  if (ready && ready.status !== 'True') {
    const why = [str(ready.reason), str(ready.message)].filter((s) => s !== '').join(': ');
    return `${name} is ${phase} (Ready ${str(ready.status)}${why ? `: ${why}` : ''})`;
  }
  if (!scheduled) return `${name} is ${phase} (not scheduled yet)`;
  return `${name} is ${phase} (no Ready condition yet)`;
}

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as PodsReadyArgs;
  const expected = `${countPhrase(a, kindNoun('Pod', 'ready '))} matching ${a.selector} in namespace ${a.namespace}`;
  const ce = countError(a);
  if (ce) return evalError(expected, ce);
  const sel = withClient(ctx.kernel, (client) => select(client, { kind: 'Pod', apiVersion: 'v1', namespace: a.namespace, selector: a.selector }));
  if (isError(sel)) return evalError(expected, sel.error);
  const pods = sel.objects;
  const ready = pods.filter(isPodReady).length;
  const pass = countHolds(a, ready);
  if (pods.length === 0) return { pass, expected, observed: `no Pod matches ${a.selector} in namespace ${a.namespace}` };
  const notReady = pods.filter((p) => !isPodReady(p)).map(notReadyReason);
  const observed = `${ready} of ${pods.length} ${kindNoun('Pod')(pods.length)} ready${notReady.length > 0 ? `; ${firstFew(notReady)}` : ''}`;
  return { pass, expected, observed };
}

export const podsReadyCheck: CheckSpec = { name: 'k8s.podsReady', args: SCHEMA, run };
