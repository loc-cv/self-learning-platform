// kubectl api-resources and api-versions: the server's discovery documents, filtered, sorted and
// printed.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/apiresources/apiresources.go Complete (arguments,
//             then the discovery client, then the printer), Validate (--sort-by), RunAPIResources
//             (filters, the flattened list, sort.Stable of sortableResource), printContextHeaders
//   upstream: apiresources/print_flags.go PrintFlags.ToPrinter (JSON/YAML, human, name),
//             HumanReadablePrinter.PrintObj, NamePrinter.PrintObj
//   upstream: apiresources/apiversions.go RunAPIVersions (metav1.ExtractGroupVersions, sorted)
//   upstream: staging/src/k8s.io/client-go/discovery/discovery_client.go
//             ServerPreferredResourcesWithContext (a group's preferred version wins for a resource
//             name; subresources skipped), ServerGroups
//   upstream: staging/src/k8s.io/cli-runtime/pkg/printers/json.go JSONPrinter (MarshalIndent,
//             four spaces), yaml.go YAMLPrinter; genericclioptions json_yaml_flags.go (the format
//             is lowercased)
//   fixtures/golden/v1.37.2/info/api-resources.yaml, info/no-server.yaml, api/discovery.yaml
// The real client reads aggregated discovery, which has no storageVersionHash: the printed
// resources carry none.

import type { ProcApi } from '@simlab/host';
import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { printJson } from '../../../apimachinery/yaml/jsonprint.ts';
import type { Invocation, Op, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { fail, getNonResourcePath, klogLine, overridesOf, resolveConfig, type Session } from '../../client/session.ts';
import { GET_TABWRITER, render, type Cells } from '../../printers/tabwriter.ts';
import { openServer, type ServerState } from '../../resource/server.ts';
import { goStrings, usageError } from '../helpers.ts';
import { parseYaml, toYaml } from '../printing.ts';

interface DiscoveredResource {
  name: string;
  singularName: string;
  namespaced: boolean;
  group: string;
  version: string;
  kind: string;
  verbs: string[];
  shortNames: string[];
  categories: string[];
}

interface GroupVersionList {
  groupVersion: string;
  group: string;
  version: string;
  resources: DiscoveredResource[];
}

type Discovery = { groups: { name: string; versions: string[]; preferred: string }[]; lists: Map<string, GroupVersionList> };

function strs(v: Json | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

type Got = { doc: JsonObject } | { notSimulated: string };

function get(s: Session, path: string): Got {
  const r = getNonResourcePath(s, path);
  if (r.ok) return { doc: r.object as JsonObject };
  return { notSimulated: 'notSimulated' in r ? r.notSimulated : `the response ${r.code} to GET ${path}` };
}

/** GET /api, /apis and each group version's resource list (what aggregated discovery returns at once). */
function discover(s: Session): Discovery | { notSimulated: string } {
  const gotApi = get(s, '/api');
  if ('notSimulated' in gotApi) return gotApi;
  const gotApis = get(s, '/apis');
  if ('notSimulated' in gotApis) return gotApis;
  const [api, apis] = [gotApi.doc, gotApis.doc];
  const groups: Discovery['groups'] = [{ name: '', versions: strs(api.versions), preferred: strs(api.versions)[0] ?? '' }];
  for (const g of (apis.groups as JsonObject[] | undefined) ?? []) {
    const versions = ((g.versions as JsonObject[] | undefined) ?? []).map((v) => v.version as string);
    groups.push({ name: g.name as string, versions, preferred: (g.preferredVersion as JsonObject).version as string });
  }
  const lists = new Map<string, GroupVersionList>();
  for (const g of groups) {
    for (const version of g.versions) {
      const gv = g.name === '' ? version : `${g.name}/${version}`;
      const got = get(s, g.name === '' ? `/api/${version}` : `/apis/${gv}`);
      if ('notSimulated' in got) return got;
      const doc = got.doc;
      const resources = ((doc.resources as JsonObject[] | undefined) ?? []).map((r) => ({
        name: r.name as string,
        singularName: (r.singularName as string | undefined) ?? '',
        namespaced: r.namespaced === true,
        group: g.name,
        version,
        kind: r.kind as string,
        verbs: strs(r.verbs),
        shortNames: strs(r.shortNames),
        categories: strs(r.categories),
      }));
      lists.set(gv, { groupVersion: gv, group: g.name, version, resources });
    }
  }
  return { groups, lists };
}

/** ServerPreferredResourcesWithContext: one list per group version, a resource in its preferred version. */
function preferredResources(d: Discovery): GroupVersionList[] {
  const result: GroupVersionList[] = [];
  const chosen = new Map<string, { version: string; resource: DiscoveredResource }>();
  const out = new Map<string, GroupVersionList>();
  for (const g of d.groups) {
    for (const version of g.versions) {
      const gv = g.name === '' ? version : `${g.name}/${version}`;
      const list = d.lists.get(gv);
      if (!list) continue;
      const empty: GroupVersionList = { groupVersion: gv, group: g.name, version, resources: [] };
      out.set(gv, empty);
      result.push(empty);
      for (const r of list.resources) {
        if (r.name.includes('/')) continue;
        const key = `${g.name}/${r.name}`;
        if (chosen.has(key) && version !== g.preferred) continue;
        chosen.set(key, { version, resource: r });
      }
    }
  }
  // Fill each group version's list with the resources selected in it, in discovery order.
  for (const g of d.groups) {
    for (const version of g.versions) {
      const gv = g.name === '' ? version : `${g.name}/${version}`;
      for (const r of d.lists.get(gv)?.resources ?? []) {
        const c = chosen.get(`${g.name}/${r.name}`);
        if (c && c.version === version && c.resource === r) out.get(gv)?.resources.push(r);
      }
    }
  }
  return result.filter((l) => l.resources.length > 0);
}

function hasAll(have: readonly string[], want: readonly string[]): boolean {
  return want.every((w) => have.includes(w));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The JSON of a metav1.APIResource, in its field order. */
function resourceJson(r: DiscoveredResource): JsonObject {
  const o: JsonObject = { name: r.name, singularName: r.singularName, namespaced: r.namespaced };
  if (r.group !== '') o.group = r.group;
  if (r.version !== '') o.version = r.version;
  o.kind = r.kind;
  o.verbs = [...r.verbs];
  if (r.shortNames.length > 0) o.shortNames = [...r.shortNames];
  if (r.categories.length > 0) o.categories = [...r.categories];
  return o;
}

const ALLOWED_FORMATS = ['json', 'kyaml', 'name', 'wide', 'yaml'];

type Printer = 'json' | 'yaml' | 'human' | 'wide' | 'name';

function printerFor(output: string): Printer | KubectlError {
  const lower = output.toLowerCase();
  if (lower === 'json') return 'json';
  if (lower === 'yaml') return 'yaml';
  if (lower === 'kyaml') return { type: 'notSimulated', what: 'the output format "kyaml"' };
  if (output === '') return 'human';
  if (output === 'wide') return 'wide';
  if (output === 'name') return 'name';
  return messageError(`unable to match a printer suitable for the output format "${output}", allowed formats are: ${ALLOWED_FORMATS.join(',')}`);
}

/** The url error of a refused discovery request, after the klog line memcache.go logs. */
function* refusedDiscovery(p: ProcApi, s: Extract<ServerState, { refused: unknown }>): Op<{ url: string; err: string }> {
  const url = `${s.refused.base}/api?timeout=32s`;
  const err = `dial tcp ${s.refused.dialAddress}: connect: connection refused`;
  const text = `Get "${url}": ${err}`;
  yield* p.write(2, klogLine(p, 'E', 'memcache.go:381', `"Couldn't get current server API group list" err="${text.replace(/"/g, '\\"')}"`));
  return { url, err };
}

function* runApiResources({ p, path, flags, args }: Invocation): Op<number> {
  const v = flags.values;
  if (args.length !== 0) return yield* fail(p, usageError(path, `unexpected arguments: ${goStrings(args)}`));
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const printer = printerFor(v.output as string);
  if (typeof printer !== 'string') return yield* fail(p, printer);
  const sortBy = v['sort-by'] as string;
  if (sortBy !== '' && sortBy !== 'name' && sortBy !== 'kind') return yield* fail(p, messageError('--sort-by accepts only name or kind'));
  const state = yield* openServer(p, config);
  if (typeof state === 'number') return state;
  if ('refused' in state) {
    const e = yield* refusedDiscovery(p, state);
    return yield* fail(p, { type: 'url', op: 'Get', url: e.url, err: e.err });
  }
  const d = discover(state.session);
  if ('notSimulated' in d) return yield* p.unsupported({ kind: 'behavior', what: d.notSimulated });

  const groupChanged = flags.changed.includes('api-group');
  const nsChanged = flags.changed.includes('namespaced');
  const apiGroup = v['api-group'] as string;
  const namespaced = v.namespaced === true;
  const verbs = v.verbs as string[];
  const categories = v.categories as string[];
  const flat: DiscoveredResource[] = [];
  let lists = 0;
  for (const list of preferredResources(d)) {
    lists++;
    for (const r of list.resources) {
      if (r.verbs.length === 0) continue;
      if (groupChanged && apiGroup !== list.group) continue;
      if (nsChanged && namespaced !== r.namespaced) continue;
      if (verbs.length > 0 && !hasAll(r.verbs, verbs)) continue;
      if (categories.length > 0 && !hasAll(r.categories, categories)) continue;
      flat.push(r);
    }
  }
  if (lists === 0) return 0;
  const key = (r: DiscoveredResource) => (sortBy === 'name' ? r.name : sortBy === 'kind' ? r.kind : r.group);
  flat.sort((a, b) => compare(key(a), key(b)) || compare(a.name, b.name));

  let out: string;
  if (printer === 'json' || printer === 'yaml') {
    const obj: JsonObject = { kind: 'APIResourceList', apiVersion: 'v1', groupVersion: '', resources: flat.length > 0 ? flat.map(resourceJson) : null };
    out = printer === 'json' ? printJson(obj) : toYaml(obj);
  } else if (printer === 'name') {
    out = flat.map((r) => `${r.name}${r.group !== '' ? `.${r.group}` : ''}\n`).join('');
  } else {
    const wide = printer === 'wide';
    const lines: Cells[] = [];
    if (v['no-headers'] !== true) lines.push(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', ...(wide ? ['VERBS', 'CATEGORIES'] : [])]);
    for (const r of flat) {
      const gv = r.group === '' ? r.version : `${r.group}/${r.version}`;
      const row = [r.name, r.shortNames.join(','), gv, String(r.namespaced), r.kind];
      if (wide) row.push(r.verbs.join(','), r.categories.join(','));
      lines.push(row);
    }
    out = render(lines, { ...GET_TABWRITER, rememberWidths: false });
  }
  yield* p.write(1, out);
  return 0;
}

function* runApiVersions({ p, path, flags, args }: Invocation): Op<number> {
  if (args.length !== 0) return yield* fail(p, usageError(path, `unexpected arguments: ${goStrings(args)}`));
  const config = resolveConfig(p, overridesOf(flags.values), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const state = yield* openServer(p, config);
  if (typeof state === 'number') return state;
  if ('refused' in state) {
    const e = yield* refusedDiscovery(p, state);
    return yield* fail(p, messageError(`couldn't get available api versions from server: Get "${e.url}": ${e.err}`));
  }
  const gotApi = get(state.session, '/api');
  if ('notSimulated' in gotApi) return yield* p.unsupported({ kind: 'behavior', what: gotApi.notSimulated });
  const gotApis = get(state.session, '/apis');
  if ('notSimulated' in gotApis) return yield* p.unsupported({ kind: 'behavior', what: gotApis.notSimulated });
  const [api, apis] = [gotApi.doc, gotApis.doc];
  // ExtractGroupVersions: every version of every group, the core group's as "v1".
  const versions = [...strs(api.versions)];
  for (const g of (apis.groups as JsonObject[] | undefined) ?? []) {
    for (const gv of (g.versions as JsonObject[] | undefined) ?? []) versions.push(gv.groupVersion as string);
  }
  versions.sort(compare);
  yield* p.write(1, versions.map((x) => `${x}\n`).join(''));
  return 0;
}

export const apiResourcesVerb: Verb = {
  path: 'api-resources',
  flags: [
    { name: 'api-group', kind: 'string', default: '' },
    { name: 'namespaced', kind: 'bool', default: true },
    { name: 'verbs', kind: 'stringSlice', default: [] },
    { name: 'sort-by', kind: 'string', default: '' },
    { name: 'categories', kind: 'stringSlice', default: [] },
    { name: 'output', shorthand: 'o', kind: 'string', default: '' },
    { name: 'no-headers', kind: 'bool', default: false },
  ],
  noEffect: {
    cached: 'the discovery cache is not modeled: discovery is answered by the server each time, with the same result',
    'show-managed-fields': 'an APIResourceList has no managed fields to show or strip',
  },
  partial: { output: 'kyaml prints a notice' },
  outputFormats: { allowed: ALLOWED_FORMATS, simulated: ['json', 'name', 'wide', 'yaml'] },
  run: runApiResources,
};

export const apiVersionsVerb: Verb = {
  path: 'api-versions',
  flags: [],
  run: runApiVersions,
};
