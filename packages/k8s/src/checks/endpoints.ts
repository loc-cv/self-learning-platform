// k8s.endpoints: the ready endpoints of a Service, as the EndpointSlice controller publishes them
// (docs/SCENARIO_FORMAT.md §7.1): slices labelled kubernetes.io/service-name=<service>, endpoints
// whose conditions.ready is not false (nil means ready), counted by unique address.
//   upstream: staging/src/k8s.io/api/discovery/v1/types.go EndpointConditions.Ready ("nil should
//             be interpreted as ready"); LabelServiceName in well_known_labels.go

import type { CheckCtx, CheckResult, CheckSpec, Json } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';
import type { Client } from '../client/client.ts';
import { COUNT_PROPERTIES, countError, countHolds, countPhrase, evalError, isError, nameList, responseError, withClient, type ApiResult, type CountArgs } from './common.ts';

interface EndpointsArgs extends CountArgs {
  namespace: string;
  service: string;
}

const SCHEMA: JsonObject = {
  type: 'object',
  description: "The Service's EndpointSlices hold that many ready endpoints (default: at least one), counted by unique address. A missing Service fails.",
  properties: {
    namespace: { type: 'string', minLength: 1, description: 'The namespace of the Service.' },
    service: { type: 'string', minLength: 1, description: 'The name of the Service.' },
    ...COUNT_PROPERTIES,
  },
  required: ['namespace', 'service'],
  additionalProperties: false,
};

interface Observed {
  missing?: string;
  ready: string[];
  notReady: string[];
  /** The Service's selector as a label selector string, if it has one. */
  selector?: string;
  /** Whether the selector matches a Pod. */
  matchesPod?: boolean;
}

/** labels.Set(selector).String(): sorted `k=v` pairs joined with commas. */
function selectorString(sel: JsonObject): string {
  return Object.keys(sel)
    .sort()
    .map((k) => `${k}=${String(sel[k])}`)
    .join(',');
}

function observe(client: Client, a: EndpointsArgs): ApiResult<Observed> {
  const svc = client.resource('v1/services').get(a.namespace, a.service);
  if (!svc.ok) {
    if ('status' in svc && svc.code === 404) return { missing: responseError(svc), ready: [], notReady: [] };
    return { error: responseError(svc) };
  }
  const spec = (svc.object as JsonObject).spec;
  const selMap = isObject(spec) && isObject(spec.selector) && Object.keys(spec.selector).length > 0 ? spec.selector : undefined;
  const slices = client.resource('discovery.k8s.io/v1/endpointslices').list(a.namespace, { labelSelector: `kubernetes.io/service-name=${a.service}` });
  if (!slices.ok) return { error: responseError(slices) };
  const ready = new Set<string>();
  const notReady = new Set<string>();
  for (const slice of ((slices.object as JsonObject).items ?? []) as JsonObject[]) {
    for (const ep of (Array.isArray(slice.endpoints) ? slice.endpoints : []).filter(isObject) as JsonObject[]) {
      const isReady = !(isObject(ep.conditions) && ep.conditions.ready === false);
      for (const addr of Array.isArray(ep.addresses) ? ep.addresses : []) if (typeof addr === 'string') (isReady ? ready : notReady).add(addr);
    }
  }
  for (const r of ready) notReady.delete(r);
  const out: Observed = { ready: [...ready].sort(), notReady: [...notReady].sort() };
  if (selMap) {
    out.selector = selectorString(selMap);
    if (ready.size === 0) {
      const pods = client.resource('v1/pods').list(a.namespace, { labelSelector: out.selector });
      if (!pods.ok) return { error: responseError(pods) };
      out.matchesPod = (((pods.object as JsonObject).items ?? []) as Json[]).length > 0;
    }
  }
  return out;
}

function run(ctx: CheckCtx, raw: Json): CheckResult {
  const a = raw as unknown as EndpointsArgs;
  const expected = `Service ${a.service} in namespace ${a.namespace} has ${countPhrase(a, (n) => (n === 1 ? 'ready endpoint' : 'ready endpoints'))}`;
  const ce = countError(a);
  if (ce) return evalError(expected, ce);
  const o = withClient(ctx.kernel, (client) => observe(client, a));
  if (isError(o)) return evalError(expected, o.error);
  if (o.missing !== undefined) return { pass: false, expected, observed: o.missing };
  const n = o.ready.length;
  const pass = countHolds(a, n);
  const notReady = o.notReady.length > 0 ? `; not ready: ${nameList(o.notReady)}` : '';
  if (n > 0) return { pass, expected, observed: `${n} ready ${n === 1 ? 'endpoint' : 'endpoints'}: ${nameList(o.ready)}${notReady}` };
  let why = '';
  if (o.selector === undefined) why = `; the Service has no selector`;
  else if (o.matchesPod === false) why = `; the Service's selector ${o.selector} matches no Pod in namespace ${a.namespace}`;
  return { pass, expected, observed: `no ready endpoint${notReady}${why}` };
}

export const endpointsCheck: CheckSpec = { name: 'k8s.endpoints', args: SCHEMA, run };
