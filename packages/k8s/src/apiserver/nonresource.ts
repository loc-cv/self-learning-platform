// The API server's version and legacy discovery endpoints: `/version`, `/api`, `/apis`, `/api/v1`
// and `/apis/<group>/<version>`. These are non-resource requests: they do not pass through the
// resource pipeline (pipeline.ts). The discovery documents are built from the resource registry
// (discovery/registry.ts), which was generated from the real server's documents; nonresource.test.ts
// compares them with fixtures/golden/v1.37.2/api/discovery.yaml.
//   upstream: staging/src/k8s.io/apiserver/pkg/endpoints/discovery/legacy.go (APIVersions with
//             serverAddressByClientCIDRs), root.go (APIGroupList), group.go, version.go
//             (APIResourceList); pkg/endpoints/handlers/responsewriters
//   upstream: staging/src/k8s.io/apiserver/pkg/server/routes/version.go (GET /version, the
//             component's version.Info)
// The real client asks for aggregated discovery (apidiscovery.k8s.io/v2); the simulator's clients
// read these legacy documents, which carry the same groups, versions and resources.

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { registry, type ApiResource } from '../discovery/registry.ts';
import type { ApiServerConfig } from './config.ts';
import type { ApiResponse } from './types.ts';

/**
 * The kube-apiserver binary's version.Info at the pin, as GET /version answers it.
 * Captured: fixtures/golden/v1.37.2/info/version.yaml (buildDate is normalized there; the value is
 * the oracle's raw `kubectl get --raw /version`, 2026-11-16, and also the string in the binary).
 */
export const SERVER_VERSION_INFO: JsonObject = {
  major: '1',
  minor: '37',
  emulationMajor: '1',
  emulationMinor: '37',
  minCompatibilityMajor: '1',
  minCompatibilityMinor: '36',
  gitVersion: 'v1.37.2',
  gitCommit: 'c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32',
  gitTreeState: 'clean',
  buildDate: '2026-10-27T12:01:06Z',
  goVersion: 'go1.26.10',
  compiler: 'gc',
  platform: 'linux/amd64',
};

function ok(object: Json): ApiResponse {
  return { ok: true, code: 200, object, warnings: [] };
}

/** One APIResource as discovery lists it (metav1.APIResource field order). */
function apiResource(r: ApiResource): JsonObject {
  const name = r.subresource !== undefined ? `${r.resource}/${r.subresource}` : r.resource;
  const out: JsonObject = { name, singularName: r.singularName, namespaced: r.namespaced };
  if (r.kindGroup !== r.group || r.kindVersion !== r.version) {
    out.group = r.kindGroup;
    out.version = r.kindVersion;
  }
  out.kind = r.kind;
  out.verbs = [...r.verbs];
  if (r.shortNames.length > 0) out.shortNames = [...r.shortNames];
  if (r.categories.length > 0) out.categories = [...r.categories];
  if (r.storageVersionHash !== undefined) out.storageVersionHash = r.storageVersionHash;
  return out;
}

function resourceList(group: string, version: string): JsonObject | undefined {
  const reg = registry();
  if (group !== '' && !reg.groups.some((g) => g.name === group && g.versions.includes(version))) return undefined;
  if (group === '' && version !== 'v1') return undefined;
  const resources = reg.all.filter((r) => r.group === group && r.version === version).map(apiResource);
  // The core group's list has no apiVersion (legacy.go writes it without one).
  const gv = group === '' ? version : `${group}/${version}`;
  return group === '' ? { kind: 'APIResourceList', groupVersion: gv, resources } : { kind: 'APIResourceList', apiVersion: 'v1', groupVersion: gv, resources };
}

/** A GET of a version or discovery path (a query string is ignored), or a notice for another path. */
export function getNonResource(server: ApiServerConfig, url: string): ApiResponse {
  const path = url.replace(/\?.*$/, '').replace(/\/$/, '');
  const reg = registry();
  if (path === '/version') return ok({ ...SERVER_VERSION_INFO });
  if (path === '/api') {
    return ok({
      kind: 'APIVersions',
      versions: ['v1'],
      serverAddressByClientCIDRs: [{ clientCIDR: '0.0.0.0/0', serverAddress: `${server.advertiseAddress}:${server.securePort}` }],
    });
  }
  if (path === '/apis') {
    const groups = reg.groups
      .filter((g) => g.name !== '')
      .map((g) => ({
        name: g.name,
        versions: g.versions.map((v) => ({ groupVersion: `${g.name}/${v}`, version: v })),
        preferredVersion: { groupVersion: `${g.name}/${g.preferred}`, version: g.preferred },
      }));
    return ok({ kind: 'APIGroupList', apiVersion: 'v1', groups });
  }
  const core = /^\/api\/([^/]+)$/.exec(path);
  const named = /^\/apis\/([^/]+)\/([^/]+)$/.exec(path);
  const list = core ? resourceList('', core[1] as string) : named ? resourceList(named[1] as string, named[2] as string) : undefined;
  if (list) return ok(list);
  return { ok: false, code: 0, notSimulated: `the request GET ${path}`, warnings: [] };
}
