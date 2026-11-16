// The process a container starts: argv and environment, as the kubelet prepares them and
// containerd merges them with the image config.
//
// upstream: pkg/kubelet/kubelet_pods.go makeEnvironmentVariables (container env with $(VAR)
// expansion, then service variables not already defined), getServiceEnvVarMap (the `kubernetes`
// Service of `default` always, the namespace's Services when enableServiceLinks),
// pkg/kubelet/envvars/envvars.go FromServices, third_party/forked/golang/expansion (the $(VAR)
// syntax); containerd pkg/cri/opts/spec_opts.go WithProcessArgs (command replaces Entrypoint and
// drops Cmd; args alone replace Cmd), pkg/cri/server/container_create_linux.go and oci/spec_opts.go
// replaceOrAppendEnvValues (default PATH, HOSTNAME, image env, then the kubelet's), runc
// libcontainer/env.go prepareEnv (the last occurrence of a key wins; HOME from /etc/passwd when
// absent).
// Both upstream lists are built by iterating Go maps, so their order varies between runs; here the
// container's own variables keep spec order and service variables are sorted (a modeled choice).

import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';
import type { CapturedImage } from '../runtime/images/catalog.data.ts';

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const arr = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObject) as JsonObject[]) : []);

/** containerd's default PATH (oci/spec.go defaultUnixEnv). */
export const DEFAULT_PATH = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const envName = (s: string): string => s.replace(/-/g, '_').toUpperCase();

/** envvars.FromServices for one Service. */
function serviceVars(svc: ApiObject): [string, string][] {
  const spec = obj(svc.spec as Json);
  const ip = str(spec.clusterIP);
  if (ip === '' || ip === 'None') return [];
  const ports = arr(spec.ports);
  if (ports.length === 0) return [];
  const prefix = envName(str(obj(svc.metadata as Json).name));
  const out: [string, string][] = [[`${prefix}_SERVICE_HOST`, ip], [`${prefix}_SERVICE_PORT`, String(ports[0]?.port ?? '')]];
  for (const p of ports) if (str(p.name)) out.push([`${prefix}_SERVICE_PORT_${envName(str(p.name))}`, String(p.port)]);
  const hostPort = ip.includes(':') ? `[${ip}]` : ip;
  ports.forEach((p, i) => {
    const proto = (str(p.protocol) || 'TCP').toLowerCase();
    const url = `${proto}://${hostPort}:${String(p.port)}`;
    if (i === 0) out.push([`${prefix}_PORT`, url]);
    const pp = `${prefix}_PORT_${String(p.port)}_${proto.toUpperCase()}`;
    out.push([pp, url], [`${pp}_PROTO`, proto], [`${pp}_PORT`, String(p.port)], [`${pp}_ADDR`, ip]);
  });
  return out;
}

/** getServiceEnvVarMap: name → value. */
export function serviceEnv(services: ApiObject[], namespace: string, enableServiceLinks: boolean): Record<string, string> {
  const chosen: Record<string, ApiObject> = {};
  for (const s of services) {
    const m = obj(s.metadata as Json);
    const name = str(m.name);
    if (str(m.namespace) === 'default' && name === 'kubernetes') {
      if (!chosen[name]) chosen[name] = s;
    } else if (str(m.namespace) === namespace && enableServiceLinks) chosen[name] = s;
  }
  const out: Record<string, string> = {};
  for (const name of Object.keys(chosen).sort()) for (const [k, v] of serviceVars(chosen[name] as ApiObject)) out[k] = v;
  return out;
}

/** expansion.Expand: $(VAR) from the mapping, `$$` escapes, unknown references kept as written. */
export function expand(input: string, lookup: (name: string) => string | undefined): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c !== '$' || i + 1 >= input.length) {
      out += c;
      continue;
    }
    const n = input[i + 1];
    if (n === '$') {
      out += '$';
      i++;
      continue;
    }
    if (n === '(') {
      const end = input.indexOf(')', i + 2);
      if (end < 0) {
        out += input.slice(i);
        break;
      }
      const name = input.slice(i + 2, end);
      const v = lookup(name);
      out += v ?? `$(${name})`;
      i = end;
      continue;
    }
    out += c;
  }
  return out;
}

export interface ContainerProcess {
  argv: string[];
  env: [string, string][];
  /** Variables the simulator cannot resolve yet (valueFrom, envFrom: phase 16a). */
  unsupported: string[];
}

/** The kubelet's env list for a container, then containerd's merge with the image, then runc's dedup. */
export function containerProcess(pod: ApiObject, container: JsonObject, image: CapturedImage, services: ApiObject[], hostname: string): ContainerProcess {
  const spec = obj(pod.spec as Json);
  const unsupported: string[] = [];
  const svcEnv = serviceEnv(services, str(obj(pod.metadata as Json).namespace), spec.enableServiceLinks !== false);
  if (arr(container.envFrom).length > 0) unsupported.push('envFrom');
  const own: [string, string][] = [];
  const lookup = (name: string): string | undefined => {
    for (let i = own.length - 1; i >= 0; i--) if ((own[i] as [string, string])[0] === name) return (own[i] as [string, string])[1];
    return svcEnv[name];
  };
  for (const e of arr(container.env)) {
    if (e.valueFrom !== undefined) {
      unsupported.push(`env ${str(e.name)} valueFrom`);
      continue;
    }
    const v = expand(str(e.value), lookup);
    const i = own.findIndex(([k]) => k === str(e.name));
    if (i >= 0) own.splice(i, 1);
    own.push([str(e.name), v]);
  }
  const kubeletEnv: [string, string][] = [...own];
  for (const k of Object.keys(svcEnv).sort()) if (!own.some(([n]) => n === k)) kubeletEnv.push([k, svcEnv[k] as string]);

  // containerd: PATH, HOSTNAME, then the image's and the kubelet's variables.
  const spec2: string[] = [DEFAULT_PATH, `HOSTNAME=${hostname}`];
  const defaults = new Map<string, number>([['PATH', 0], ['HOSTNAME', 1]]);
  for (const kv of [...image.config.env, ...kubeletEnv.map(([k, v]) => `${k}=${v}`)]) {
    const eq = kv.indexOf('=');
    const k = eq < 0 ? kv : kv.slice(0, eq);
    const at = defaults.get(k);
    if (at !== undefined) spec2[at] = kv;
    else spec2.push(kv);
  }
  // runc: the last occurrence of a key wins, at its position; HOME from /etc/passwd when absent.
  const seen = new Set<string>();
  const env: [string, string][] = [];
  for (let i = spec2.length - 1; i >= 0; i--) {
    const kv = spec2[i] as string;
    const eq = kv.indexOf('=');
    const k = kv.slice(0, eq);
    if (seen.has(k)) continue;
    seen.add(k);
    env.unshift([k, kv.slice(eq + 1)]);
  }
  if (!env.some(([k, v]) => k === 'HOME' && v !== '')) {
    // The image's user: root's home is /root; other users of the captured images have no entry here.
    const user = image.config.user ?? '';
    env.push(['HOME', user === '' || user === '0' || user === 'root' || user.startsWith('0:') ? '/root' : '/']);
  }

  const envLookup = (name: string): string | undefined => lookup(name);
  const command = (Array.isArray(container.command) ? container.command : []).map((x) => expand(str(x), envLookup));
  const args = (Array.isArray(container.args) ? container.args : []).map((x) => expand(str(x), envLookup));
  let cmd = command;
  let a = args;
  if (cmd.length === 0) {
    if (a.length === 0) a = [...(image.config.cmd ?? [])];
    const ep = image.config.entrypoint ?? [];
    if (!(ep.length === 1 && ep[0] === '')) cmd = [...ep];
  }
  return { argv: [...cmd, ...a], env, unsupported };
}
