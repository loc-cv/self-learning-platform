// What the k8s.* checks share: reading objects through the API server as a superuser, mapping a
// kind to its resource, selecting objects by name, selector or all, counting, and the plain-words
// phrases of `expected` and `observed` (the simulator's own voice in the debrief, not tool output).

import type { CheckResult, Ctx, Kernel, Registry, World } from '@simlab/kernel';
import { createKernel, forkWorld } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { k8sSlice } from '../apiserver/store.ts';
import type { ApiResponse, UserInfo } from '../apiserver/types.ts';
import { createClient, type Client } from '../client/client.ts';
import { registry } from '../discovery/registry.ts';
import { mappingForKind, type Mapping } from '../kubectl/client/restmapper.ts';

/**
 * The identity checks read with: kubeadm's admin user in system:masters, the superuser group the
 * API server authorizes for every request (docs: reference/access-authn-authz/rbac "User-facing
 * roles"), so a learner's RBAC changes never hide an object from a check. No authorization is
 * simulated yet; the identity matters once it is.
 */
export const CHECK_USER: UserInfo = { username: 'kubernetes-admin', groups: ['system:masters', 'system:authenticated'] };

/** A check that could not be evaluated. */
export function evalError(expected: string, error: string): CheckResult {
  return { pass: false, expected, observed: `not evaluated: ${error}`, error };
}

export type ApiResult<T> = T | { error: string };

export function isError<T>(r: ApiResult<T>): r is { error: string } {
  return typeof r === 'object' && r !== null && 'error' in r;
}

/** The API server checks talk to: the first serving one in key order. */
export function apiServerOf(ctx: Ctx): ApiServerConfig | undefined {
  const servers = k8sSlice(ctx).apiServers;
  const key = Object.keys(servers).sort()[0];
  return key === undefined ? undefined : servers[key];
}

/** Runs `fn` with a client of the kernel's API server; an error when no API server serves. */
export function withClient<T>(kernel: Kernel, fn: (client: Client) => ApiResult<T>): ApiResult<T> {
  return kernel.act('check', (ctx) => {
    const server = apiServerOf(ctx);
    if (!server) return { error: 'no Kubernetes API server is serving' };
    return fn(createClient(ctx, server, CHECK_USER));
  });
}

/** A kernel over a fork of the baseline world: reading it never touches the baseline. */
export function baselineKernel(baseline: World, reg: Registry): Kernel {
  return createKernel(forkWorld(baseline), reg);
}

/** The text of a failed response: the Status message, or what the simulator does not model. */
export function responseError(r: ApiResponse): string {
  if (r.ok) return '';
  if ('notSimulated' in r) return `[sim] not simulated: ${r.notSimulated}`;
  return r.status.message ?? `request failed with code ${r.code}`;
}

/**
 * The resource of a kind. With `apiVersion`, kubectl's RESTMapping for that group version;
 * without it, the first group version serving the kind in discovery priority (the core group
 * first, each group's preferred version first): `Event` is core v1, not events.k8s.io.
 *   upstream: staging/src/k8s.io/client-go/restmapper/discovery.go NewDiscoveryRESTMapper
 */
export function resolveKind(kind: string, apiVersion?: string): ApiResult<Mapping> {
  if (apiVersion !== undefined) {
    const parts = apiVersion.split('/');
    if (parts.length > 2 || parts.some((p) => p === '')) return { error: `invalid apiVersion ${JSON.stringify(apiVersion)}` };
    const [group, version] = parts.length === 2 ? (parts as [string, string]) : ['', parts[0] as string];
    const m = mappingForKind(group, version, kind);
    if ('noMatch' in m) return { error: m.noMatch };
    if (m.list) return { error: `${kind} is a list kind; name the kind of its items` };
    return m.mapping;
  }
  const reg = registry();
  for (const exact of [true, false]) {
    for (const g of reg.groups) {
      for (const v of [g.preferred, ...g.versions.filter((x) => x !== g.preferred)]) {
        const a = reg.all.find((r) => r.group === g.name && r.version === v && r.subresource === undefined && (exact ? r.kind === kind : r.kind.toLowerCase() === kind.toLowerCase()));
        if (a) return { group: a.group, version: a.version, resource: a.resource, kind: a.kind, namespaced: a.namespaced, singular: a.singularName };
      }
    }
  }
  return { error: `no matches for kind ${JSON.stringify(kind)}: no API group serves it` };
}

export interface Selection {
  kind: string;
  apiVersion?: string;
  namespace?: string;
  name?: string;
  selector?: string;
}

/** The scope a selection reads: the namespace of a namespaced kind (`default` when none is given). */
export function scopeOf(m: Mapping, sel: Selection): ApiResult<string | undefined> {
  if (!m.namespaced) {
    if (sel.namespace !== undefined) return { error: `${m.kind} is cluster-scoped; remove namespace` };
    return undefined;
  }
  return sel.namespace ?? 'default';
}

export interface Selected {
  mapping: Mapping;
  namespace: string | undefined;
  objects: JsonObject[];
}

/** The objects a selection names, as `kubectl get` lists them (terminating ones included). */
export function select(client: Client, sel: Selection): ApiResult<Selected> {
  if (sel.name !== undefined && sel.selector !== undefined) return { error: 'name and selector are mutually exclusive' };
  const mapping = resolveKind(sel.kind, sel.apiVersion);
  if (isError(mapping)) return mapping;
  const namespace = scopeOf(mapping, sel);
  if (namespace !== undefined && isError(namespace)) return namespace;
  const rc = client.resource({ group: mapping.group, version: mapping.version, resource: mapping.resource });
  if (sel.name !== undefined) {
    const r = rc.get(namespace, sel.name);
    if (r.ok) return { mapping, namespace, objects: [r.object as JsonObject] };
    if ('status' in r && r.code === 404) return { mapping, namespace, objects: [] };
    return { error: responseError(r) };
  }
  const r = rc.list(namespace, sel.selector !== undefined ? { labelSelector: sel.selector } : {});
  if (!r.ok) return { error: responseError(r) };
  const items = ((r.object as JsonObject).items ?? []) as JsonObject[];
  // The store lists in key order: by name within a namespace.
  return { mapping, namespace, objects: items };
}

export const metaOf = (o: JsonObject): JsonObject => (isObject(o.metadata) ? o.metadata : {});
export const nameOf = (o: JsonObject): string => str(metaOf(o).name);
export const uidOf = (o: JsonObject): string => str(metaOf(o).uid);
export const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

// ---- counting

export interface CountArgs {
  count?: number;
  min?: number;
  max?: number;
}

/** The count arguments' schema properties. */
export const COUNT_PROPERTIES: JsonObject = {
  count: { type: 'integer', minimum: 0, description: 'Exactly this many. Excludes min and max.' },
  min: { type: 'integer', minimum: 0, description: 'At least this many.' },
  max: { type: 'integer', minimum: 0, description: 'At most this many.' },
};

/** An error when the count arguments contradict each other. */
export function countError(c: CountArgs): string | undefined {
  if (c.count !== undefined && (c.min !== undefined || c.max !== undefined)) return 'count excludes min and max';
  if (c.min !== undefined && c.max !== undefined && c.min > c.max) return `min (${c.min}) is greater than max (${c.max})`;
  return undefined;
}

/** Whether `n` satisfies the count; with none given, at least one. */
export function countHolds(c: CountArgs, n: number): boolean {
  if (c.count !== undefined) return n === c.count;
  if (c.min === undefined && c.max === undefined) return n >= 1;
  return (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
}

/** "3 ready Pods", "at least 1 ready Pod", "between 2 and 4 Pods", "no Pod". */
export function countPhrase(c: CountArgs, noun: (n: number) => string): string {
  if (c.count !== undefined) return c.count === 0 ? `no ${noun(1)}` : `${c.count} ${noun(c.count)}`;
  if (c.min !== undefined && c.max !== undefined) return c.min === c.max ? `${c.min} ${noun(c.min)}` : `between ${c.min} and ${c.max} ${noun(2)}`;
  if (c.max !== undefined) return `at most ${c.max} ${noun(c.max)}`;
  const min = c.min ?? 1;
  return `at least ${min} ${noun(min)}`;
}

// ---- phrases

/** The plural of a kind: Pods, NetworkPolicies, Ingresses, Endpoints. */
export function pluralKind(kind: string): string {
  if (kind.endsWith('s') && !/(ss|us)$/.test(kind)) return kind;
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(kind)) return `${kind}es`;
  return `${kind}s`;
}

export const kindNoun =
  (kind: string, adjective = '') =>
  (n: number): string =>
    `${adjective}${n === 1 ? kind : pluralKind(kind)}`;

/** "in namespace shop", or "cluster-wide". */
export const scopePhrase = (namespace: string | undefined): string => (namespace === undefined ? 'cluster-wide' : `in namespace ${namespace}`);

/** "named web", "matching app=web", or nothing. */
export function selectionPhrase(sel: Selection): string {
  if (sel.name !== undefined) return ` named ${sel.name}`;
  if (sel.selector !== undefined) return ` matching ${sel.selector}`;
  return '';
}

/** The scope phrase from the arguments alone (before the kind is resolved): `default` for a namespaced kind. */
export function argScope(sel: Selection): string {
  const m = resolveKind(sel.kind, sel.apiVersion);
  if (isError(m)) return sel.namespace === undefined ? '' : ` in namespace ${sel.namespace}`;
  const ns = scopeOf(m, sel);
  if (ns !== undefined && isError(ns)) return '';
  return ` ${scopePhrase(ns)}`;
}

/** Up to `n` items, then "and K more". */
export function firstFew(items: string[], n = 3): string {
  if (items.length <= n) return items.join('; ');
  return `${items.slice(0, n).join('; ')}; and ${items.length - n} more`;
}

/** Names, comma-separated: up to `n`, then "and K more". */
export function nameList(names: string[], n = 5): string {
  if (names.length <= n) return names.join(', ');
  return `${names.slice(0, n).join(', ')} and ${names.length - n} more`;
}

/** Short JSON for an observed value: at most `max` characters. */
export function shortJson(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
