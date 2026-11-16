// Resource names to resources, as kubectl maps them through discovery: short names, singular and
// plural names, `resource.group` and `resource.version.group`, the group priority of discovery,
// and categories (`all`).
//   upstream: staging/src/k8s.io/client-go/restmapper/shortcut.go expandResourceShortcut
//   upstream: staging/src/k8s.io/client-go/restmapper/discovery.go NewDiscoveryRESTMapper (group
//             priority in discovery order, the preferred version first)
//   upstream: staging/src/k8s.io/apimachinery/pkg/api/meta/restmapper.go ResourcesFor,
//             coerceResourceForMatching; priority.go PriorityRESTMapper.KindFor
//   upstream: staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go ParseResourceArg,
//             ParseGroupResource
//   upstream: staging/src/k8s.io/client-go/restmapper/category_expansion.go discoveryCategoryExpander
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go mappingFor
// The discovery documents are the real server's at the pin (discovery/registry.ts): what the
// simulated API server announces, including resources whose storage it does not simulate.

import { registry, type ApiResource } from '../../discovery/registry.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';

export interface Mapping {
  group: string;
  version: string;
  resource: string;
  kind: string;
  namespaced: boolean;
  singular: string;
}

interface GVR {
  group: string;
  version: string;
  resource: string;
}

/** Served resources (no subresources) in discovery order: groups in order, preferred version first. */
function prioritized(): ApiResource[] {
  const reg = registry();
  const out: ApiResource[] = [];
  for (const g of reg.groups) {
    const versions = [g.preferred, ...g.versions.filter((v) => v !== g.preferred)];
    for (const v of versions) for (const r of reg.all) if (r.group === g.name && r.version === v && r.subresource === undefined) out.push(r);
  }
  return out;
}

let cache: ApiResource[] | undefined;
function resources(): ApiResource[] {
  return (cache ??= prioritized());
}

/** Discovery order (the order of ServerGroupsAndResources): groups, then each group's versions as listed. */
function discoveryOrder(): ApiResource[] {
  return registry().all.filter((r) => r.subresource === undefined);
}

/** shortcutExpander.expandResourceShortcut */
function expandShortcut(r: GVR): GVR {
  const all = discoveryOrder();
  for (const a of all) {
    if (r.group !== '' && r.group !== a.group) continue;
    if (r.resource === a.resource || r.resource === a.singularName) return r;
  }
  let found: GVR | undefined;
  for (const a of all) {
    for (const short of a.shortNames) {
      if (r.group !== '' && r.group !== a.group) continue;
      if (r.resource !== short) continue;
      // A lower-priority resource with the same short name only draws a warning (at -v), first wins.
      if (!found) found = { group: a.group, version: r.version, resource: a.resource };
    }
  }
  if (found) return found;
  if (r.group === '') return r;
  for (const a of all) {
    for (const short of a.shortNames) {
      if (!a.group.startsWith(r.group)) continue;
      if (r.resource === short) return { group: a.group, version: r.version, resource: a.resource };
    }
  }
  return r;
}

/** DefaultRESTMapper.ResourcesFor over every group version, then the highest priority (KindFor). */
function resourceFor(input: GVR): ApiResource | undefined {
  const r = { ...input, resource: input.resource.toLowerCase() };
  const hasGroup = r.group !== '';
  const hasVersion = r.version !== '';
  const matches = (a: ApiResource) => a.resource === r.resource || a.singularName === r.resource;
  const all = resources();
  let ret: ApiResource[];
  if (hasGroup && hasVersion) ret = all.filter((a) => a.group === r.group && a.version === r.version && matches(a));
  else if (hasGroup) {
    ret = all.filter((a) => a.group === r.group && matches(a));
    // No exact group: a prefix of the group (storageclass.storage).
    if (ret.length === 0) ret = all.filter((a) => a.group.startsWith(r.group) && matches(a));
  } else if (hasVersion) ret = all.filter((a) => a.version === r.version && matches(a));
  else ret = all.filter(matches);
  return ret[0];
}

/** schema.ParseResourceArg */
function parseResourceArg(arg: string): { full?: GVR; partial: GVR } {
  let full: GVR | undefined;
  if (arg.split('.').length - 1 >= 2) {
    const [resource, version, ...rest] = arg.split('.');
    full = { resource: resource as string, version: version as string, group: rest.join('.') };
  }
  const i = arg.indexOf('.');
  const partial = i >= 0 ? { resource: arg.slice(0, i), group: arg.slice(i + 1), version: '' } : { resource: arg, group: '', version: '' };
  return full ? { full, partial } : { partial };
}

function toMapping(a: ApiResource): Mapping {
  return { group: a.group, version: a.version, resource: a.resource, kind: a.kind, namespaced: a.namespaced, singular: a.singularName };
}

/** Builder.mappingFor: the mapping of a resource argument, or the error it announces. */
export function mappingFor(arg: string): Mapping | KubectlError {
  const { full, partial } = parseResourceArg(arg);
  if (full) {
    const a = resourceFor(expandShortcut(full));
    if (a) return toMapping(a);
  }
  const expanded = expandShortcut(partial);
  const a = resourceFor(expanded);
  if (a) return toMapping(a);
  // builder.go mappingFor announces the type as given (ParseGroupResource), as a plain error.
  const what = `the server doesn't have a resource type "${partial.resource}"`;
  if (partial.group !== '') return messageError(`${what} in group "${partial.group}"`);
  return messageError(what);
}

/** discoveryCategoryExpander.Expand: `resource` or `resource.group` of each member, in discovery order. */
export function expandCategory(name: string): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of discoveryOrder()) {
    if (!a.categories.includes(name)) continue;
    const key = a.group === '' ? a.resource : `${a.resource}.${a.group}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length > 0 ? out : undefined;
}

/** A kind's mapping, or the NoKindMatchError text (`no matches for kind "X" in version "g/v"`). */
export type KindMapping = { mapping: Mapping; list: boolean } | { noMatch: string };

/**
 * RESTMapping(groupKind, version) over the discovery mapper: each group version maps its kinds,
 * their lower-case forms, `<Kind>List` (a guessed resource, only usable as a list to flatten) and
 * `List`. An empty version is not resolved here (the caller reports it).
 *   upstream: staging/src/k8s.io/client-go/restmapper/discovery.go NewDiscoveryRESTMapper
 *             (AddSpecific for the kind and strings.ToLower(kind), Add for kind+"List" and "List")
 *   upstream: staging/src/k8s.io/apimachinery/pkg/api/meta/errors.go NoKindMatchError.Error
 */
export function mappingForKind(group: string, version: string, kind: string): KindMapping {
  const gv = group === '' ? version : `${group}/${version}`;
  const noMatch = { noMatch: `no matches for kind ${JSON.stringify(kind)} in version ${JSON.stringify(gv)}` };
  const inGv = discoveryOrder().filter((a) => a.group === group && a.version === version);
  if (inGv.length === 0) return noMatch;
  const exact = inGv.find((a) => a.kind === kind) ?? inGv.find((a) => a.kind.toLowerCase() === kind);
  if (exact) return { mapping: toMapping(exact), list: false };
  const listOf = kind.endsWith('List') ? inGv.find((a) => `${a.kind}List` === kind) : undefined;
  if (kind === 'List' || listOf) {
    // meta.UnsafeGuessKindToResource of the list kind; only a list's items are ever sent.
    const resource = `${kind.toLowerCase()}s`;
    return { mapping: { group, version, resource, kind, namespaced: kind === 'List' ? false : (listOf as ApiResource).namespaced, singular: kind.toLowerCase() }, list: true };
  }
  return noMatch;
}
