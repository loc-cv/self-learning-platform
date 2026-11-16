// What the garbage collector and the namespace controller learn from discovery: the preferred
// version of every resource with a set of verbs, and the REST mapping of an ownerReference's
// apiVersion and kind.
//
// upstream: client-go discovery ServerPreferredResources / ServerPreferredNamespacedResources (for
// each group, the resources of its preferred version, plus those only served by another version),
// discovery.FilteredBy(SupportsAllVerbs{...}); the GC's restMapper.RESTMapping.
//
// Resources without a strategy are left out: the simulated API server stores no object of them,
// so a list of them is empty and a get of one is NotFound. Watching or deleting them would only
// reach the API server's [sim] notice for a resource it does not serve.

import { registry, type ApiResource } from '../../discovery/registry.ts';
import { strategyFor } from '../../apiserver/strategies.ts';

/** `apps/v1/deployments`, `v1/pods`: the resource string of the client and the store reader. */
export function resourcePath(r: { group: string; version: string; resource: string }): string {
  return r.group === '' ? `${r.version}/${r.resource}` : `${r.group}/${r.version}/${r.resource}`;
}

/** `apps/v1`, `v1`. */
export function apiVersionOf(r: { group: string; version: string }): string {
  return r.group === '' ? r.version : `${r.group}/${r.version}`;
}

/**
 * Preferred resources (no subresources) supporting every verb in `verbs`, in discovery order,
 * that the simulator stores.
 */
export function preferredResources(verbs: readonly string[], namespacedOnly: boolean): ApiResource[] {
  const reg = registry();
  const out: ApiResource[] = [];
  for (const g of reg.groups) {
    const versions = [g.preferred, ...g.versions.filter((v) => v !== g.preferred)];
    const seen = new Set<string>();
    for (const v of versions) {
      for (const r of reg.all) {
        if (r.group !== g.name || r.version !== v || r.subresource !== undefined) continue;
        if (seen.has(r.resource)) continue;
        seen.add(r.resource);
        if (namespacedOnly && !r.namespaced) continue;
        if (!verbs.every((verb) => r.verbs.includes(verb))) continue;
        if (!strategyFor(r.group, r.resource)) continue;
        out.push(r);
      }
    }
  }
  return out;
}

export interface RestMapping {
  resource: ApiResource;
  namespaced: boolean;
  /** False when the simulator has no strategy for it: nothing of it can exist. */
  stored: boolean;
}

/**
 * The GC's apiResource: apiVersion and kind to a resource. Undefined is upstream's
 * restMappingError (`unable to get REST mapping for <kind>.<apiVersion>.`).
 */
export function restMapping(apiVersion: string, kind: string): RestMapping | undefined {
  const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/', 2) as [string, string]) : ['', apiVersion];
  const r = registry().forKind(group, version, kind);
  if (!r) return undefined;
  return { resource: r, namespaced: r.namespaced, stored: strategyFor(r.group, r.resource) !== undefined };
}
