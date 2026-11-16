// What kubectl's completion functions read: the kubeconfig (contexts, clusters, users, the
// namespace) and the API server (resource types, object names, containers, ports), queried
// synchronously as the process's user would, with the config flags already on the command line
// (--kubeconfig, --context, --cluster, --user, -n, -s). Any failure gives no candidates: the real
// functions send get's errors to io.Discard.
//   upstream: staging/src/k8s.io/kubectl/pkg/util/completion/completion.go CompGetFromTemplate
//             (a `get` with a go-template; Namespace() of the raw config loader, explicit when
//             given), compGetResourceList (`api-resources -o name --cached --verbs=get`),
//             ListContextsInConfig, ListClustersInConfig, ListUsersInConfig
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/apiresources/apiresources.go RunAPIResources
//             (the preferred version of each group, resources whose verbs include get, sorted
//             stably by group then name); client-go discovery ServerPreferredResources (no
//             subresources)

import type { Ctx, Json } from '@simlab/kernel';
import { FsError, type Fs } from '@simlab/host';
import type { ApiServerConfig } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import { registry } from '../../discovery/registry.ts';
import { clientConfig, loadKubeconfig, type ClientConfig, type KubeconfigFile, type ReadFile } from '../client/kubeconfig.ts';
import { expandCategory, mappingFor, type Mapping } from '../client/restmapper.ts';
import { overridesOf } from '../client/session.ts';
import { connect } from '../client/transport.ts';
import { parseYaml } from '../cmd/printing.ts';

/** Where the lookups run: the world, the machine, the file system as the user, the environment. */
export interface ClientEnv {
  ctx: Ctx;
  machine: string;
  fs: Fs;
  env: Readonly<Record<string, string>>;
  /** Where klog's lines go (standard error of `kubectl __complete`); absent when discarded. */
  klog?: (file: string, text: string) => void;
}

export interface Client {
  /** CompGetFromTemplate's `get <args>`: the objects, or [] on any error. */
  get(args: readonly string[], namespace?: string): Json[];
  /** compGetResourceList's lines: `resource` or `resource.group`. */
  resourceTypes(): string[];
  contexts(): string[];
  clusters(): string[];
  users(): string[];
  /** Names in the working directory, for cp. */
  cwdEntries(): { name: string; dir: boolean }[];
}

function reader(fs: Fs): ReadFile {
  return (path) => {
    try {
      return fs.readFile(path);
    } catch (e) {
      if (e instanceof FsError) {
        // os.IsNotExist; ENOTDIR is an error, as in client/session.ts
        if (e.code === 'ENOENT') return { missing: true };
        return { error: e.code };
      }
      throw e;
    }
  };
}

const isObject = (v: Json | undefined): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function newClient(e: ClientEnv, values: Record<string, unknown>): Client {
  const overrides = overridesOf(values);
  let raw: KubeconfigFile | undefined | null;
  const rawConfig = (): KubeconfigFile | undefined => {
    if (raw === undefined) {
      const cfg = loadKubeconfig(reader(e.fs), parseYaml, e.env, e.env['HOME'] ?? '', overrides.kubeconfig);
      raw = 'type' in cfg ? null : cfg;
    }
    return raw ?? undefined;
  };
  let config: ClientConfig | undefined | null;
  const resolved = (): ClientConfig | undefined => {
    if (config === undefined) {
      const cfg = rawConfig();
      const c = cfg ? clientConfig(cfg, overrides) : undefined;
      config = c && !('type' in c) ? c : null;
    }
    return config ?? undefined;
  };
  /**
   * The API server, or undefined. A refused connection logs what discovery logs: memcache.go's
   * line once per attempt (5 for a get's first resource type, 1 more for each further type, 1 for
   * api-resources; counted on the real binary, fixtures/golden/v1.37.2/completion/flags.yaml).
   */
  const server = (attempts: number) => {
    const c = resolved();
    if (!c) return undefined;
    const conn = connect(e.ctx, e.machine, c.server);
    if (conn.ok) return conn.server;
    if ('refused' in conn && e.klog) {
      // upstream: client-go discovery/cached/memory/memcache.go:381
      const err = `Get \\"${conn.url.base}/api?timeout=32s\\": dial tcp ${conn.url.dialAddress}: connect: connection refused`;
      for (let i = 0; i < attempts; i++) e.klog('memcache.go:381', `"Couldn't get current server API group list" err="${err}"`);
    }
    return undefined;
  };
  const list = (s: ApiServerConfig, m: Mapping, namespace: string): Json[] => {
    const r = handle(e.ctx, s, { verb: 'list', group: m.group, version: m.version, resource: m.resource, ...(m.namespaced ? { namespace } : {}) });
    if (!r.ok || !isObject(r.object)) return [];
    const items = r.object['items'];
    return Array.isArray(items) ? items : [];
  };
  return {
    get(args, namespace) {
      const c = resolved();
      if (!c) return [];
      const ns = namespace ?? c.namespace;
      const [types, name] = args as [string, string | undefined];
      if (types === undefined) return [];
      const s = server(5 + types.split(',').length - 1);
      if (!s) return [];
      // Builder: comma-separated types, categories expanded; any unknown type fails the get.
      const mappings: Mapping[] = [];
      for (const t of types.split(',')) {
        for (const one of expandCategory(t) ?? [t]) {
          const m = mappingFor(one);
          if ('type' in m) return [];
          mappings.push(m);
        }
      }
      if (name !== undefined) {
        if (name === '' || mappings.length !== 1) return [];
        const m = mappings[0] as Mapping;
        const r = handle(e.ctx, s, { verb: 'get', group: m.group, version: m.version, resource: m.resource, name, ...(m.namespaced ? { namespace: ns } : {}) });
        return r.ok ? [r.object] : [];
      }
      return mappings.flatMap((m) => list(s, m, ns));
    },
    resourceTypes() {
      if (!server(1)) return [];
      const reg = registry();
      const out: { group: string; name: string }[] = [];
      for (const g of reg.groups) {
        for (const r of reg.all) {
          if (r.group !== g.name || r.version !== g.preferred || r.subresource !== undefined) continue;
          if (!r.verbs.includes('get')) continue;
          out.push({ group: r.group, name: r.resource });
        }
      }
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      // sort.Stable by group, then name (sortableResource.Less).
      const sorted = out.map((r, i) => ({ r, i })).sort((a, b) => cmp(a.r.group, b.r.group) || cmp(a.r.name, b.r.name) || a.i - b.i);
      return sorted.map(({ r }) => (r.group === '' ? r.name : `${r.name}.${r.group}`));
    },
    contexts: () => Object.keys(rawConfig()?.contexts ?? {}),
    clusters: () => Object.keys(rawConfig()?.clusters ?? {}),
    users: () => Object.keys(rawConfig()?.users ?? {}),
    cwdEntries() {
      try {
        // os.ReadDir: sorted by file name.
        return e.fs
          .readdir('.')
          .sort()
          .map((name) => {
            let dir: boolean;
            try {
              dir = e.fs.stat(name).type === 'dir';
            } catch {
              dir = false;
            }
            return { name, dir };
          });
      } catch {
        return [];
      }
    },
  };
}

/** The names of objects (`.metadata.name`), as the names template prints them. */
export function namesOf(objects: readonly Json[]): string[] {
  const out: string[] = [];
  for (const o of objects) {
    const md = isObject(o) ? o['metadata'] : undefined;
    const n = isObject(md) ? md['name'] : undefined;
    if (typeof n === 'string' && n !== '') out.push(n);
  }
  return out;
}
