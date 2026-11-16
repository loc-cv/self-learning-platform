// The kubectl verbs the simulator does not have yet, as the API requests the real kubectl sends,
// so that a golden case's setup and state-changing steps can be replayed before their verbs are
// simulated. Tools code only: what the shim prints is never compared (a shimmed `run` step is
// reported, not judged), and `kubectl get` is never shimmed for a compared step — it is what the
// differential runner tests. The shim's `get` serves only polling (`until`) and `$(...)`.
//
// Sources for what each verb sends (fieldManager values from each command's
// cmdutil.AddFieldManagerFlagVar; managedFields are not simulated, DIV-015, so they have no effect):
//   generated objects: fixtures/golden/v1.37.2/client/generators.yaml (create deployment, service,
//   configmap, namespace), staging/src/k8s.io/kubectl/pkg/cmd/run/run.go createPod (run), and
//   cmd/expose/expose.go createService (expose).
//
// Two simulator limits shape some requests, each noted where it applies: the API server applies
// only JSON merge patches (apiserver/pipeline.ts patch), and the scale subresource is read-only.
// A strategic merge patch whose body holds no list that meets an existing list, and no `$`
// directive, has the same result as the JSON merge patch of the same body
// (staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go: maps merge key by key, null
// deletes, lists without a patch strategy are replaced) and is sent as one; others are refused.

import { parseAllDocuments } from 'yaml';
import type { Kernel } from '@simlab/kernel';
import { createClient, DEFAULT_APISERVER, registry, type ApiRequest, type ApiResponse, type RequestOptions } from '@simlab/k8s';
import { splitWords, type Substitute } from './argv.ts';
import { jsonpath } from './jsonpath.ts';

type Obj = Record<string, unknown>;

export interface ShimEnv {
  kernel: Kernel;
  /** Reads a file relative to the home directory; undefined when missing. */
  readFile(path: string): string | undefined;
  /** The files directly in a directory, sorted, or undefined when it is not one. */
  listDir(path: string): string[] | undefined;
  /** Output of a `$(...)` substitution. */
  substitute: Substitute;
}

export interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The command cannot be shimmed faithfully: the case is blocked here. */
export interface Unsupported {
  unsupported: string;
}

/** Virtual time kubectl's watches are approximated with: a poll every 100 ms. */
const POLL = 100;

// ---- arguments ----

const VALUE_FLAGS = new Set([
  'n', 'namespace', 'l', 'selector', 'f', 'filename', 'o', 'output', 'p', 'patch', 'type', 'image', 'replicas', 'port', 'target-port',
  'tcp', 'node-port', 'from-literal', 'from-file', 'labels', 'overrides', 'for', 'timeout', 'cascade', 'grace-period', 'to-revision',
  'revision', 'field-selector', 'subresource', 'restart', 'env', 'validate', 'dry-run', 'name', 'protocol',
]);
const SHORT: Record<string, string> = { n: 'namespace', l: 'selector', f: 'filename', o: 'output', p: 'patch', A: 'all-namespaces' };

interface Args {
  pos: string[];
  flags: Record<string, string[]>;
  /** After `--`. */
  rest: string[];
}

function parseArgs(words: string[]): Args {
  const a: Args = { pos: [], flags: {}, rest: [] };
  const set = (k: string, v: string) => (a.flags[SHORT[k] ?? k] ??= []).push(v);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === '--') {
      a.rest = words.slice(i + 1);
      break;
    }
    if (/^-[A-Za-z]./s.test(w)) {
      // -oyaml, -lapp=x, -n=x: a short flag with its value attached (pflag).
      const k = w[1] as string;
      if (VALUE_FLAGS.has(k)) set(k, w.slice(w[2] === '=' ? 3 : 2));
      else a.pos.push(w);
      continue;
    }
    const m = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/s.exec(w);
    if (!m) {
      a.pos.push(w);
      continue;
    }
    const k = m[1] as string;
    if (m[2] !== undefined) set(k, m[2]);
    else if (VALUE_FLAGS.has(k)) set(k, words[++i] ?? '');
    else set(k, 'true');
  }
  return a;
}

const flag = (a: Args, k: string): string | undefined => a.flags[k]?.[a.flags[k].length - 1];
const bool = (a: Args, k: string, def = false): boolean => (flag(a, k) === undefined ? def : flag(a, k) !== 'false');

// ---- requests ----

interface Mapping {
  group: string;
  version: string;
  resource: string;
  kind: string;
  namespaced: boolean;
}

/** A resource argument (`deploy`, `pods`, `events.events.k8s.io`) as kubectl's RESTMapper resolves it: first match in discovery order, preferred version. */
function mappingFor(arg: string): Mapping | undefined {
  const reg = registry();
  const preferred = new Map(reg.groups.map((g) => [g.name, g.preferred]));
  const lower = arg.toLowerCase();
  const dot = lower.indexOf('.');
  const [name, group] = dot >= 0 ? [lower.slice(0, dot), lower.slice(dot + 1)] : [lower, undefined];
  for (const r of reg.all) {
    if (r.subresource !== undefined || preferred.get(r.group) !== r.version) continue;
    if (group !== undefined && r.group !== group) continue;
    if (r.resource === name || r.singularName === name || r.shortNames.includes(name)) return { group: r.group, version: r.version, resource: r.resource, kind: r.kind, namespaced: r.namespaced };
  }
  return undefined;
}

function mappingForKind(apiVersion: string, kind: string): Mapping | undefined {
  const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/') as [string, string]) : ['', apiVersion];
  const r = registry().forKind(group, version, kind);
  return r ? { group: r.group, version: r.version, resource: r.resource, kind: r.kind, namespaced: r.namespaced } : undefined;
}

/** `deployment.apps/web`, `pod/x`: how kubectl names an object in its messages. */
const qualified = (m: Mapping, name: string): string => `${m.kind.toLowerCase()}${m.group ? `.${m.group}` : ''}/${name}`;

class NotSimulated extends Error {}

function send(env: ShimEnv, r: ApiRequest): ApiResponse {
  const res = env.kernel.act('kubectl', (ctx) => createClient(ctx, DEFAULT_APISERVER).request(r));
  if (!res.ok && 'notSimulated' in res) throw new NotSimulated(res.notSimulated);
  return res;
}

const req = (m: Mapping, verb: ApiRequest['verb'], ns: string | undefined, extra: Partial<ApiRequest> = {}): ApiRequest => ({
  verb,
  group: m.group,
  version: m.version,
  resource: m.resource,
  ...(m.namespaced && ns !== undefined ? { namespace: ns } : {}),
  ...extra,
});

/** Error from server text as kubectl prints it for a failed request (enough for the shim's own reporting). */
function serverError(res: ApiResponse): string {
  if (res.ok) return '';
  const st = 'status' in res ? (res.status as unknown as Obj) : {};
  return `Error from server (${String(st.reason ?? '')}): ${String(st.message ?? '')}\n`;
}

const out = (stdout: string, status = 0, stderr = ''): ShimResult => ({ status, stdout, stderr });
const err = (text: string, status = 1): ShimResult => ({ status, stdout: '', stderr: text.endsWith('\n') ? text : `${text}\n` });

function get(env: ShimEnv, m: Mapping, ns: string, name: string): Obj | undefined {
  const r = send(env, req(m, 'get', ns, { name }));
  return r.ok ? (r.object as Obj) : undefined;
}

function list(env: ShimEnv, m: Mapping, ns: string | undefined, options: RequestOptions = {}): Obj[] {
  const r = send(env, req(m, 'list', ns, { options }));
  if (!r.ok) throw new Error(serverError(r));
  return ((r.object as Obj).items ?? []) as Obj[];
}

const meta = (o: Obj): Obj => (o.metadata ?? {}) as Obj;

/** Advances virtual time until `done` holds, at most `timeoutMs`; returns whether it held. */
function waitUntil(env: ShimEnv, done: () => boolean, timeoutMs: number): boolean {
  for (let t = 0; ; t += POLL) {
    if (done()) return true;
    if (t >= timeoutMs) return false;
    env.kernel.advance(POLL);
  }
}

/** kubectl's --timeout: a Go duration; 0 or absent is the command's default. */
function duration(s: string | undefined, def: number): number {
  if (s === undefined || s === '0' || s === '0s') return def;
  let ms = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) ms += Number(n) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[u as string] as number);
  return ms;
}

// ---- object references ----

interface Ref {
  m: Mapping;
  name?: string;
}

/** `TYPE NAME…`, `TYPE/NAME…` or `TYPE[,TYPE]` (with a selector). undefined: a type kubectl would not know. */
function refs(pos: string[]): Ref[] | undefined {
  const out: Ref[] = [];
  if (pos.length === 0) return out;
  if (pos.every((p) => p.includes('/'))) {
    for (const p of pos) {
      const [t, n] = p.split('/') as [string, string];
      const m = mappingFor(t);
      if (!m) return undefined;
      out.push({ m, name: n });
    }
    return out;
  }
  const types = (pos[0] as string).split(',').map(mappingFor);
  if (types.some((t) => !t)) return undefined;
  if (pos.length === 1) return types.map((m) => ({ m: m as Mapping }));
  for (const n of pos.slice(1)) out.push({ m: types[0] as Mapping, name: n });
  return out;
}

/** The objects a reference with optional selectors names, as [mapping, object]. */
function resolve(env: ShimEnv, rs: Ref[], ns: string, a: Args): [Mapping, Obj][] {
  const out: [Mapping, Obj][] = [];
  for (const r of rs) {
    if (r.name !== undefined) {
      const o = get(env, r.m, ns, r.name);
      if (o) out.push([r.m, o]);
      continue;
    }
    const options: RequestOptions = {};
    if (flag(a, 'selector')) options.labelSelector = flag(a, 'selector') as string;
    if (flag(a, 'field-selector')) options.fieldSelector = flag(a, 'field-selector') as string;
    for (const o of list(env, r.m, bool(a, 'all-namespaces') ? undefined : ns, options)) out.push([r.m, o]);
  }
  return out;
}

// ---- manifests ----

/** The documents of `-f` (a file, a directory's .yaml/.yml/.json files in name order, or `-`). */
function manifests(env: ShimEnv, f: string, stdin: string | undefined): { source: string; doc: Obj }[] | string {
  const files: string[] = [];
  if (f === '-') files.push('-');
  else {
    const dir = env.listDir(f);
    if (dir) files.push(...dir.filter((n) => /\.(ya?ml|json)$/.test(n)).map((n) => `${f.replace(/\/$/, '')}/${n}`));
    else files.push(f);
  }
  const docs: { source: string; doc: Obj }[] = [];
  for (const file of files) {
    const text = file === '-' ? (stdin ?? '') : env.readFile(file);
    if (text === undefined) return `error: the path "${file}" does not exist`;
    // kubectl decodes with sigs.k8s.io/yaml (go-yaml v2: YAML 1.1, where `on` and `yes` are booleans).
    for (const d of parseAllDocuments(text, { version: '1.1' })) {
      if (d.errors.length > 0) return `error: error parsing ${file}: ${d.errors[0]?.message ?? ''}`;
      const v = d.toJSON() as unknown;
      if (v !== null && typeof v === 'object') docs.push({ source: file === '-' ? 'STDIN' : file, doc: v as Obj });
    }
  }
  return docs;
}

/**
 * The oracle's stand-in for a failing readiness probe (docs/FIDELITY.md §6.5): KWOK keeps a Pod so
 * annotated not ready. A real kubelet, and the simulator's, ignore it; the simulator has no probes
 * yet (DIV-023, phase 16b), so a case that relies on it cannot be replayed.
 */
function oracleDevice(v: unknown): string | undefined {
  return JSON.stringify(v ?? null).includes('simlab.dev/kwok-not-ready')
    ? 'the oracle\'s simlab.dev/kwok-not-ready annotation (KWOK\'s stand-in for a failing readiness probe, FIDELITY §6.5; probes arrive in phase 16b, DIV-023)'
    : undefined;
}

// ---- patches ----

/** Whether a strategic merge patch has the effect of the JSON merge patch with the same body (see the header). */
function mergeEquivalent(current: unknown, patch: unknown): boolean {
  if (patch === null || typeof patch !== 'object') return true;
  if (Array.isArray(patch)) return !(Array.isArray(current) && current.length > 0);
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('$')) return false;
    const c = current !== null && typeof current === 'object' && !Array.isArray(current) ? (current as Obj)[k] : undefined;
    if (!mergeEquivalent(c, v)) return false;
  }
  return true;
}

function patch(env: ShimEnv, m: Mapping, ns: string, name: string, body: unknown, type: string, opts: { subresource?: string; fieldManager: string }): ApiResponse | Unsupported {
  const why = oracleDevice(body);
  if (why) return { unsupported: why };
  if (type === 'strategic') {
    const cur = get(env, m, ns, name);
    if (cur && !mergeEquivalent(cur, body)) return { unsupported: 'a strategic merge patch that merges lists (the simulator applies JSON merge patches only)' };
  } else if (type !== 'merge') return { unsupported: `${type} patches (the simulator applies JSON merge patches only)` };
  return send(env, req(m, 'patch', ns, { name, body: body as never, ...(opts.subresource ? { subresource: opts.subresource } : {}), options: { patchType: 'merge', fieldManager: opts.fieldManager } }));
}

// ---- verbs ----

type Verb = (env: ShimEnv, a: Args, ns: string, stdin: string | undefined) => ShimResult | Unsupported;

/** kubectl create -f: each document POSTed, Strict field validation. upstream: cmd/create/create.go RunCreate. */
function createFromFiles(env: ShimEnv, a: Args, ns: string, stdin: string | undefined, apply = false): ShimResult | Unsupported {
  const docs = manifests(env, flag(a, 'filename') as string, stdin);
  if (typeof docs === 'string') return err(docs);
  // The builder decodes and maps every document before anything is sent (cmd/create/create.go
  // RunCreate: r.Err()); a document without a known kind fails the command client-side.
  for (const { source, doc } of docs) {
    if (!mappingForKind(String(doc.apiVersion ?? ''), String(doc.kind ?? ''))) return err(`error: unable to recognize "${source}": no matches for kind "${String(doc.kind)}" in version "${String(doc.apiVersion)}"`);
    const why = oracleDevice(doc);
    if (why) return { unsupported: why };
  }
  let stdout = '';
  let stderr = '';
  for (const { source, doc } of docs) {
    const m = mappingForKind(String(doc.apiVersion ?? ''), String(doc.kind ?? '')) as Mapping;
    const md = (doc.metadata ?? {}) as Obj;
    const objNs = m.namespaced ? (typeof md.namespace === 'string' ? md.namespace : ns) : undefined;
    let body = doc;
    if (apply) {
      // upstream: cmd/apply/apply.go applyOneObject: an object not found is created with the
      // last-applied annotation, the JSON of the manifest (namespace set, annotations without the
      // annotation itself), keys sorted, newline-terminated
      // (staging/src/k8s.io/kubectl/pkg/util/apply.go GetModifiedConfiguration); the format is
      // fixtures/golden/v1.37.2/apply/created-configured-unchanged.yaml's.
      const name = String(md.name ?? '');
      if (get(env, m, objNs ?? '', name)) return { unsupported: 'kubectl apply to an existing object (three-way strategic merge)' };
      const annotations = { ...((md.annotations ?? {}) as Obj) };
      const applied = { ...doc, metadata: { ...md, annotations, ...(objNs !== undefined ? { namespace: objNs } : {}) } };
      annotations['kubectl.kubernetes.io/last-applied-configuration'] = `${sortedJson(applied)}\n`;
      body = { ...doc, metadata: { ...md, annotations } };
    }
    const fieldValidation = flag(a, 'validate') === 'false' ? 'Ignore' : 'Strict';
    const res = send(env, req(m, 'create', objNs, { body: body as never, options: { fieldManager: apply ? 'kubectl-client-side-apply' : 'kubectl-create', fieldValidation } }));
    if (res.ok) stdout += `${qualified(m, String(md.name))} created\n`;
    else stderr += serverError(res).replace(/^(Error from server \([^)]*\): )/, `$1error when creating "${source}": `);
  }
  return out(stdout, stderr === '' ? 0 : 1, stderr);
}

function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((v as Obj)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function createGenerated(env: ShimEnv, m: Mapping, ns: string, body: Obj, fieldManager: string): ShimResult {
  const res = send(env, req(m, 'create', ns, { body: body as never, options: { fieldManager, fieldValidation: 'Strict' } }));
  const name = String(meta(body).name);
  if (res.ok) return out(`${qualified(m, name)} created\n`);
  return err(`error: failed to create ${m.kind.toLowerCase()}: ${serverError(res).replace(/^Error from server \([^)]*\): /, '')}`);
}

const create: Verb = (env, a, ns, stdin) => {
  if (flag(a, 'filename')) return createFromFiles(env, a, ns, stdin);
  const [what, name] = a.pos;
  // upstream: cmd/create/create.go RunCreate, before any request.
  if (what === undefined) return err('error: must specify one of -f and -k');
  if (what === 'deployment' || what === 'deploy') {
    // fixtures/golden/v1.37.2/client/generators.yaml (create deployment … -o yaml / -o json)
    const image = flag(a, 'image');
    if (!image || !name) return err('error: required flag(s) "image" not set');
    const container: Obj = { name: image.replace(/[:@].*$/, '').replace(/^.*\//, ''), image, resources: {} };
    if (flag(a, 'port')) container.ports = [{ containerPort: Number(flag(a, 'port')) }];
    const labels = { app: name };
    const d = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, labels },
      spec: { replicas: Number(flag(a, 'replicas') ?? 1), selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [container] } }, strategy: {} },
      status: {},
    };
    return createGenerated(env, mappingFor('deployments') as Mapping, ns, d, 'kubectl-create');
  }
  if (what === 'namespace' || what === 'ns') {
    // generators.yaml: create namespace dev --dry-run=client -o yaml
    const res = send(env, req(mappingFor('namespaces') as Mapping, 'create', undefined, { body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name }, spec: {}, status: {} } as never, options: { fieldManager: 'kubectl-create', fieldValidation: 'Strict' } }));
    return res.ok ? out(`namespace/${String(name)} created\n`) : err(serverError(res));
  }
  if (what === 'configmap' || what === 'cm') {
    // generators.yaml (create configmap --from-literal); --from-file: the key is the file's base name
    // (cmd/create/create_configmap.go handleConfigMapFromFileSources); keys are checked client-side
    // with validation.IsConfigMapKey before anything is sent.
    const data: Record<string, string> = {};
    for (const lit of a.flags['from-literal'] ?? []) {
      const i = lit.indexOf('=');
      data[lit.slice(0, i)] = lit.slice(i + 1);
    }
    for (const f of a.flags['from-file'] ?? []) {
      const [k, p] = f.includes('=') ? (f.split('=', 2) as [string, string]) : [f.replace(/^.*\//, ''), f];
      const text = env.readFile(p);
      if (text === undefined) return err(`error: stat ${p}: no such file or directory`);
      data[k] = text;
    }
    for (const k of Object.keys(data)) if (!/^[-._a-zA-Z0-9]+$/.test(k)) return err(`error: "${k}" is not a valid key name for a ConfigMap`);
    const body: Obj = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name } };
    if (Object.keys(data).length > 0) body.data = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
    return createGenerated(env, mappingFor('configmaps') as Mapping, ns, body, 'kubectl-create');
  }
  if (what === 'service' || what === 'svc') {
    // generators.yaml (create service clusterip|nodeport --tcp=80:8080 [--node-port])
    const [, type, svcName] = a.pos;
    if (type !== 'clusterip' && type !== 'nodeport') return { unsupported: `kubectl create service ${String(type)}` };
    const ports = (a.flags.tcp ?? []).map((t) => {
      const [port, target] = t.split(':') as [string, string | undefined];
      const p: Obj = { name: `${port}-${target ?? port}`, port: Number(port), protocol: 'TCP', targetPort: Number(target ?? port) };
      if (type === 'nodeport' && flag(a, 'node-port') && flag(a, 'node-port') !== '0') p.nodePort = Number(flag(a, 'node-port'));
      return p;
    });
    const labels = { app: svcName };
    const body = { apiVersion: 'v1', kind: 'Service', metadata: { name: svcName, labels }, spec: { ports, selector: labels, type: type === 'nodeport' ? 'NodePort' : 'ClusterIP' }, status: { loadBalancer: {} } };
    const res = send(env, req(mappingFor('services') as Mapping, 'create', ns, { body: body as never, options: { fieldManager: 'kubectl-create', fieldValidation: 'Strict' } }));
    return res.ok ? out(`service/${String(svcName)} created\n`) : err(serverError(res));
  }
  return { unsupported: `kubectl create ${String(what)}` };
};

/** kubectl run: run.go createPod, then the --overrides JSON merge patch (override_options.go, DefaultOverrideType merge). */
const run: Verb = (env, a, ns) => {
  const name = a.pos[0];
  const image = flag(a, 'image');
  if (!image) return err('error: required flag(s) "image" not set');
  if (!name) return err('error: NAME is required for run');
  const labels: Record<string, string> = {};
  for (const kv of (flag(a, 'labels') ?? '').split(',').filter((s) => s !== '')) {
    const [k, v] = kv.split('=') as [string, string];
    labels[k] = v;
  }
  const container: Obj = { name, image, resources: {} };
  if (a.flags.env) container.env = a.flags.env.map((e) => ({ name: e.slice(0, e.indexOf('=')), value: e.slice(e.indexOf('=') + 1) }));
  if (a.rest.length > 0) container[bool(a, 'command') ? 'command' : 'args'] = a.rest;
  if (flag(a, 'port')) container.ports = [{ containerPort: Number(flag(a, 'port')) }];
  const restart = flag(a, 'restart') ?? 'Always';
  let pod: unknown = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, labels: Object.keys(labels).length > 0 ? labels : { run: name } },
    spec: { containers: [container], dnsPolicy: 'ClusterFirst', restartPolicy: restart },
    status: {},
  };
  const overrides = flag(a, 'overrides');
  if (overrides) pod = mergePatch(pod, JSON.parse(overrides) as unknown);
  const res = send(env, req(mappingFor('pods') as Mapping, 'create', ns, { body: pod as never, options: { fieldManager: 'kubectl-run' } }));
  return res.ok ? out(`pod/${name} created\n`) : err(serverError(res));
};

/** RFC 7386 JSON merge patch. */
function mergePatch(target: unknown, p: unknown): unknown {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return p;
  const t: Obj = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Obj) } : {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete t[k];
    else t[k] = mergePatch(t[k], v);
  }
  return t;
}

/** kubectl apply -f: creation only (see createFromFiles). */
const apply: Verb = (env, a, ns, stdin) => {
  if (!flag(a, 'filename')) return { unsupported: 'kubectl apply without -f' };
  if (flag(a, 'dry-run') && flag(a, 'dry-run') !== 'none') return { unsupported: 'kubectl apply --dry-run' };
  return createFromFiles(env, a, ns, stdin, true);
};

/**
 * kubectl delete: DELETE with propagationPolicy from --cascade (default background) and
 * gracePeriodSeconds from --grace-period/--force, then (--wait, default true) until each object is
 * gone. upstream: cmd/delete/delete.go Complete (grace period rules), DeleteResult, waitForDeletion.
 */
const del: Verb = (env, a, ns, stdin) => {
  const cascade = flag(a, 'cascade') ?? 'background';
  const policy = { background: 'Background', orphan: 'Orphan', foreground: 'Foreground', true: 'Background', false: 'Orphan' }[cascade];
  if (!policy) return err(`error: invalid cascade value (${cascade}). Must be "background", "foreground", or "orphan".`);
  let grace = flag(a, 'grace-period') === undefined ? -1 : Number(flag(a, 'grace-period'));
  const force = bool(a, 'force');
  if (grace === 0 && !force) grace = 1;
  if (force && grace < 0) grace = 0;
  const options: RequestOptions = { propagationPolicy: policy, ...(grace >= 0 ? { gracePeriodSeconds: grace } : {}) };
  let targets: [Mapping, Obj][] = [];
  // With -l, --all or --field-selector, NotFound is ignored unless the flag says otherwise.
  const ignoreNotFound = bool(a, 'ignore-not-found', flag(a, 'selector') !== undefined);
  if (flag(a, 'filename')) {
    const docs = manifests(env, flag(a, 'filename') as string, stdin);
    if (typeof docs === 'string') return err(docs);
    for (const { doc } of docs) {
      const m = mappingForKind(String(doc.apiVersion ?? ''), String(doc.kind ?? ''));
      if (!m) return { unsupported: `delete -f of ${String(doc.kind)}` };
      targets.push([m, { metadata: { name: (doc.metadata as Obj).name, namespace: m.namespaced ? ((doc.metadata as Obj).namespace ?? ns) : undefined } }]);
    }
  } else {
    const rs = refs(a.pos);
    if (!rs) return { unsupported: `kubectl delete ${a.pos.join(' ')}` };
    if (rs.some((r) => r.name === undefined) && !flag(a, 'selector')) return { unsupported: 'kubectl delete of a type without names or selector' };
    for (const r of rs) {
      if (r.name !== undefined) targets.push([r.m, { metadata: { name: r.name, namespace: ns } }]);
    }
    targets = [...targets, ...resolve(env, rs.filter((r) => r.name === undefined), ns, a)];
  }
  let stdout = '';
  let stderr = '';
  const deleted: [Mapping, string, string | undefined][] = [];
  for (const [m, o] of targets) {
    const name = String(meta(o).name);
    const objNs = m.namespaced ? String(meta(o).namespace ?? ns) : undefined;
    const res = send(env, req(m, 'delete', objNs, { name, options }));
    if (!res.ok) {
      if (res.code === 404 && ignoreNotFound) continue;
      stderr += serverError(res);
      continue;
    }
    stdout += `${m.kind.toLowerCase()}${m.group ? `.${m.group}` : ''} "${name}" ${force && grace === 0 ? 'force ' : ''}deleted${objNs ? ` from ${objNs} namespace` : ''}\n`;
    deleted.push([m, name, objNs]);
  }
  if (targets.length === 0 && stderr === '') stdout = 'No resources found\n';
  if (bool(a, 'wait', true) && deleted.length > 0) {
    const gone = waitUntil(env, () => deleted.every(([m, name, n]) => !get(env, m, n ?? '', name)), duration(flag(a, 'timeout'), 7 * 24 * 3_600_000));
    if (!gone) stderr += 'error: timed out waiting for the condition\n';
  }
  return out(stdout, stderr === '' ? 0 : 1, stderr);
};

/** kubectl wait: --for=delete, --for=condition=NAME[=VALUE] (case folded). upstream: cmd/wait/wait.go, condition.go IsConditionMet. */
const wait: Verb = (env, a, ns) => {
  const fors = a.flags.for ?? [];
  if (fors.length !== 1) return { unsupported: 'kubectl wait with other than one --for' };
  const cond = fors[0] as string;
  const rs = refs(a.pos);
  if (!rs) return { unsupported: `kubectl wait ${a.pos.join(' ')}` };
  const timeout = duration(flag(a, 'timeout'), 30_000);
  if (cond.toLowerCase() === 'delete') {
    const ok = waitUntil(env, () => resolve(env, rs, ns, a).length === 0, timeout);
    return ok ? out('') : err('error: timed out waiting for the condition');
  }
  const m = /^condition=([^=]+)(?:=(.*))?$/.exec(cond);
  if (!m) return { unsupported: `kubectl wait --for=${cond}` };
  const [, cname, cvalue = 'true'] = m as unknown as [string, string, string | undefined];
  const met = (o: Obj) =>
    (((o.status as Obj | undefined)?.conditions ?? []) as Obj[]).some((c) => String(c.type).toLowerCase() === cname.toLowerCase() && String(c.status).toLowerCase() === cvalue.toLowerCase());
  const ok = waitUntil(
    env,
    () => {
      const objs = resolve(env, rs, ns, a);
      return objs.length >= rs.filter((r) => r.name !== undefined).length && objs.length > 0 && objs.every(([, o]) => met(o));
    },
    timeout,
  );
  return ok ? out('') : err('error: timed out waiting for the condition');
};

/**
 * What kubectl rollout status waits for. upstream:
 * staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollout_status.go DeploymentStatusViewer.Status.
 */
function rolloutState(d: Obj): 'done' | 'waiting' | 'deadline' {
  const md = meta(d);
  const spec = (d.spec ?? {}) as Obj;
  const st = (d.status ?? {}) as Obj;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  if (n(md.generation) > n(st.observedGeneration)) return 'waiting';
  const progressing = ((st.conditions ?? []) as Obj[]).find((c) => c.type === 'Progressing');
  if (progressing?.reason === 'ProgressDeadlineExceeded') return 'deadline';
  if (spec.replicas !== undefined && n(st.updatedReplicas) < n(spec.replicas)) return 'waiting';
  if (n(st.replicas) > n(st.updatedReplicas)) return 'waiting';
  if (n(st.availableReplicas) < n(st.updatedReplicas)) return 'waiting';
  return 'done';
}

const DEPLOYMENTS = (): Mapping => mappingFor('deployments') as Mapping;

function deploymentArg(a: Args, at = 1): string | undefined {
  const p = a.pos[at];
  if (p === undefined) return undefined;
  const [t, n] = p.includes('/') ? (p.split('/') as [string, string]) : [p, a.pos[at + 1]];
  return mappingFor(t)?.resource === 'deployments' ? n : undefined;
}

/** strategicpatch of `{"spec":{"paused":X}}` (rollout_pause.go / rollout_resume.go via ObjectPauser/ObjectResumer). */
function pauseResume(env: ShimEnv, ns: string, name: string, paused: boolean): ShimResult | Unsupported {
  const m = DEPLOYMENTS();
  const d = get(env, m, ns, name);
  if (!d) return err(`Error from server (NotFound): deployments.apps "${name}" not found`);
  const now = ((d.spec as Obj).paused ?? false) === true;
  if (now === paused) return err(`error: deployments.apps "${name}" is ${paused ? 'already paused' : 'not paused'}`);
  const r = patch(env, m, ns, name, { spec: { paused: paused ? true : null } }, 'strategic', { fieldManager: 'kubectl-rollout' });
  if ('unsupported' in r) return r;
  return r.ok ? out(`deployment.apps/${name} ${paused ? 'paused' : 'resumed'}\n`) : err(serverError(r));
}

const ANNOTATIONS_TO_SKIP = [
  'kubectl.kubernetes.io/last-applied-configuration',
  'deployment.kubernetes.io/revision',
  'deployment.kubernetes.io/revision-history',
  'deployment.kubernetes.io/desired-replicas',
  'deployment.kubernetes.io/max-replicas',
  'deprecated.deployment.rollback.to',
];

/**
 * kubectl rollout undo: polymorphichelpers/rollback.go DeploymentRollbacker.Rollback sends a JSON
 * patch replacing /spec/template (the revision's ReplicaSet template without pod-template-hash) and
 * /metadata/annotations (the Deployment's skipped annotations, the ReplicaSet's others). JSON
 * patches are not simulated: an update with the same result is sent instead.
 */
function undo(env: ShimEnv, ns: string, name: string, toRevision: number): ShimResult | Unsupported {
  const m = DEPLOYMENTS();
  const d = get(env, m, ns, name);
  if (!d) return err(`Error from server (NotFound): deployments.apps "${name}" not found`);
  const uid = meta(d).uid;
  const rss = list(env, mappingFor('replicasets') as Mapping, ns).filter((rs) => ((meta(rs).ownerReferences ?? []) as Obj[]).some((r) => r.uid === uid));
  const rev = (rs: Obj): number => Number(((meta(rs).annotations ?? {}) as Obj)['deployment.kubernetes.io/revision'] ?? 0);
  const sorted = [...rss].sort((x, y) => rev(x) - rev(y));
  const target = toRevision === 0 ? sorted[sorted.length - 2] : sorted.find((rs) => rev(rs) === toRevision);
  if (!target) return err(toRevision === 0 ? 'error: no rollout history found for deployment "web"' : `error: unable to find specified revision ${toRevision} in history`);
  const template = JSON.parse(JSON.stringify((target.spec as Obj).template)) as Obj;
  delete ((meta(template).labels ?? {}) as Obj)['pod-template-hash'];
  const annotations: Obj = {};
  const da = (meta(d).annotations ?? {}) as Obj;
  for (const k of ANNOTATIONS_TO_SKIP) if (k in da) annotations[k] = da[k];
  const ra = (meta(target).annotations ?? {}) as Obj;
  for (const k of Object.keys(ra)) if (!ANNOTATIONS_TO_SKIP.includes(k)) annotations[k] = ra[k];
  const body = { ...d, metadata: { ...meta(d), annotations }, spec: { ...(d.spec as Obj), template } };
  const r = send(env, req(m, 'update', ns, { name, body: body as never, options: { fieldManager: 'kubectl-rollout' } }));
  return r.ok ? out(`deployment.apps/${name} rolled back\n`) : err(serverError(r));
}

const rollout: Verb = (env, a, ns) => {
  const sub = a.pos[0];
  const name = deploymentArg(a);
  if (name === undefined) return { unsupported: `kubectl rollout ${a.pos.join(' ')} (Deployments only)` };
  if (sub === 'status') {
    if (!bool(a, 'watch', true)) return out('');
    const current = () => get(env, DEPLOYMENTS(), ns, name);
    const ok = waitUntil(env, () => {
      const d = current();
      return !d || rolloutState(d) !== 'waiting';
    }, duration(flag(a, 'timeout'), 7 * 24 * 3_600_000));
    const d = current();
    if (!d) return err(`Error from server (NotFound): deployments.apps "${name}" not found`);
    if (!ok) return err('error: timed out waiting for the condition');
    return rolloutState(d) === 'done' ? out(`deployment "${name}" successfully rolled out\n`) : err(`error: deployment "${name}" exceeded its progress deadline`);
  }
  if (sub === 'history') return out('');
  if (sub === 'pause') return pauseResume(env, ns, name, true);
  if (sub === 'resume') return pauseResume(env, ns, name, false);
  if (sub === 'undo') return undo(env, ns, name, Number(flag(a, 'to-revision') ?? 0));
  return { unsupported: `kubectl rollout ${String(sub)}` };
};

/** kubectl label: a JSON merge patch of metadata.labels (cmd/label/label.go RunLabel, MergePatchType). */
const label: Verb = (env, a, ns) => {
  // Label specs are `key=value` and `key-`; the other arguments name the objects.
  const kvs = a.pos.filter((p) => p.includes('=') || (p.endsWith('-') && !p.includes('/')));
  const objs = a.pos.filter((p) => !kvs.includes(p));
  const rs = refs(objs);
  if (!rs || rs.length === 0 || rs.some((r) => r.name === undefined)) return { unsupported: `kubectl label ${a.pos.join(' ')}` };
  let stdout = '';
  for (const r of rs) {
    const o = get(env, r.m, ns, r.name as string);
    if (!o) return err(`Error from server (NotFound): ${r.m.resource}${r.m.group ? `.${r.m.group}` : ''} "${String(r.name)}" not found`);
    const current = (meta(o).labels ?? {}) as Record<string, string>;
    const labels: Record<string, string | null> = {};
    let removing = false;
    for (const kv of kvs) {
      if (kv.endsWith('-') && !kv.includes('=')) {
        labels[kv.slice(0, -1)] = null;
        removing = true;
        continue;
      }
      const [k, v] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)];
      if (k in current && current[k] !== v && !bool(a, 'overwrite')) return err(`error: '${k}' already has a value (${String(current[k])}), and --overwrite is false`);
      labels[k] = v;
    }
    const res = send(env, req(r.m, 'patch', ns, { name: r.name as string, body: { metadata: { labels } } as never, options: { patchType: 'merge', fieldManager: 'kubectl-label' } }));
    if (!res.ok) return err(serverError(res));
    stdout += `${qualified(r.m, r.name as string)} ${removing ? 'unlabeled' : 'labeled'}\n`;
  }
  return out(stdout);
};

/**
 * kubectl scale: a JSON merge patch `{"spec":{"replicas":N}}` of the scale subresource
 * (staging/src/k8s.io/kubectl/pkg/scale/scale.go ScaleSimple). The simulator's scale subresource is
 * read-only, so the same patch is sent to the Deployment itself, where it sets the same field.
 */
const scale: Verb = (env, a, ns) => {
  const rs = refs(a.pos);
  if (!rs || rs.length === 0) return { unsupported: `kubectl scale ${a.pos.join(' ')}` };
  if (rs.some((r) => r.name === undefined)) return err('error: resource(s) were provided, but no name was specified');
  let stdout = '';
  for (const r of rs) {
    if (r.m.resource !== 'deployments' && r.m.resource !== 'replicasets') return { unsupported: `kubectl scale ${r.m.resource}` };
    const res = send(env, req(r.m, 'patch', ns, { name: r.name as string, body: { spec: { replicas: Number(flag(a, 'replicas')) } } as never, options: { patchType: 'merge' } }));
    if (!res.ok) return err(serverError(res));
    stdout += `${qualified(r.m, r.name as string)} scaled\n`;
  }
  return out(stdout);
};

/** kubectl cordon/uncordon: strategic patch of spec.unschedulable (drain/cordon.go PatchOrReplaceWithContext). */
const cordon = (on: boolean): Verb => (env, a) => {
  const m = mappingFor('nodes') as Mapping;
  let stdout = '';
  for (const n of a.pos) {
    const r = patch(env, m, '', n, { spec: { unschedulable: on ? true : null } }, 'strategic', { fieldManager: 'kubectl-cordon' });
    if ('unsupported' in r) return r;
    if (!r.ok) return err(serverError(r));
    stdout += `node/${n} ${on ? 'cordoned' : 'uncordoned'}\n`;
  }
  return out(stdout);
};

/**
 * kubectl taint: the Node's taints with the given ones added or removed (cmd/taint/taint.go
 * reorganizeTaints), sent as a strategic patch; spec.taints has no patch strategy, so the list is
 * replaced, as a merge patch replaces it.
 */
const taint: Verb = (env, a) => {
  const m = mappingFor('nodes') as Mapping;
  const [t, ...rest] = a.pos;
  if (mappingFor(t ?? '')?.resource !== 'nodes') return { unsupported: `kubectl taint ${a.pos.join(' ')}` };
  const node = rest[0] as string;
  const specs = rest.slice(1);
  const o = get(env, m, '', node);
  if (!o) return err(`Error from server (NotFound): nodes "${node}" not found`);
  let taints = [...((((o.spec ?? {}) as Obj).taints ?? []) as Obj[])];
  let removed = false;
  for (const s of specs) {
    if (s.endsWith('-')) {
      const [kv, effect] = s.slice(0, -1).split(':') as [string, string | undefined];
      const key = kv.split('=')[0];
      taints = taints.filter((x) => !(x.key === key && (effect === undefined || x.effect === effect)));
      removed = true;
      continue;
    }
    const [kv, effect] = s.split(':') as [string, string];
    const [key, value] = kv.split('=') as [string, string | undefined];
    taints = taints.filter((x) => !(x.key === key && x.effect === effect));
    taints.push({ key, ...(value !== undefined ? { value } : {}), effect });
  }
  const r = patch(env, m, '', node, { spec: { taints: taints.length > 0 ? taints : null } }, 'merge', { fieldManager: 'kubectl-taint' });
  if ('unsupported' in r) return r;
  return r.ok ? out(`node/${node} ${removed ? 'untainted' : 'tainted'}\n`) : err(serverError(r));
};

/** kubectl patch: -p with --type (default strategic). upstream: cmd/patch/patch.go. */
const patchVerb: Verb = (env, a, ns) => {
  const rs = refs(a.pos);
  if (!rs || rs.length !== 1 || rs[0]?.name === undefined) return { unsupported: `kubectl patch ${a.pos.join(' ')}` };
  const r0 = rs[0];
  const body = JSON.parse(flag(a, 'patch') ?? 'null') as unknown;
  const sub = flag(a, 'subresource');
  const r = patch(env, r0.m, ns, r0.name as string, body, flag(a, 'type') ?? 'strategic', { fieldManager: 'kubectl-patch', ...(sub ? { subresource: sub } : {}) });
  if ('unsupported' in r) return r;
  return r.ok ? out(`${qualified(r0.m, r0.name as string)} patched\n`) : err(serverError(r));
};

/** kubectl expose deployment: cmd/expose/expose.go RunExpose and createService. */
const expose: Verb = (env, a, ns) => {
  const rs = refs(a.pos);
  if (!rs || rs.length !== 1 || rs[0]?.name === undefined || rs[0].m.resource !== 'deployments') return { unsupported: `kubectl expose ${a.pos.join(' ')}` };
  const d = get(env, rs[0].m, ns, rs[0].name);
  if (!d) return err(`Error from server (NotFound): deployments.apps "${rs[0].name}" not found`);
  const port = flag(a, 'port');
  if (!port) return { unsupported: 'kubectl expose without --port (port introspection)' };
  const selector = (((d.spec as Obj).selector as Obj).matchLabels ?? {}) as Obj;
  const target = flag(a, 'target-port') ?? port;
  const svc = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: flag(a, 'name') ?? rs[0].name, labels: meta(d).labels },
    spec: { ports: [{ port: Number(port), protocol: flag(a, 'protocol') ?? 'TCP', targetPort: /^\d+$/.test(target) ? Number(target) : target }], selector },
  };
  const r = send(env, req(mappingFor('services') as Mapping, 'create', ns, { body: svc as never, options: { fieldManager: 'kubectl-expose' } }));
  return r.ok ? out(`service/${String(svc.metadata.name)} exposed\n`) : err(serverError(r));
};

/**
 * kubectl set image deployment/NAME C=IMAGE: a strategic patch of the containers by name
 * (cmd/set/set_image.go). It merges a list, so the Deployment is updated with the image changed:
 * the result the patch would have.
 */
const set: Verb = (env, a, ns) => {
  if (a.pos[0] !== 'image') return { unsupported: `kubectl set ${String(a.pos[0])}` };
  const name = deploymentArg(a);
  if (name === undefined) return { unsupported: `kubectl set image ${a.pos.slice(1).join(' ')}` };
  const m = DEPLOYMENTS();
  const d = get(env, m, ns, name);
  if (!d) return err(`Error from server (NotFound): deployments.apps "${name}" not found`);
  const pairs = a.pos.slice(a.pos[1]?.includes('/') ? 2 : 3).map((p) => p.split('=') as [string, string]);
  const copy = JSON.parse(JSON.stringify(d)) as Obj;
  const containers = (((copy.spec as Obj).template as Obj).spec as Obj).containers as Obj[];
  for (const [c, image] of pairs) {
    const target = containers.find((x) => x.name === c || c === '*');
    if (!target) return err(`error: unable to find container named "${c}"`);
    target.image = image;
  }
  const r = send(env, req(m, 'update', ns, { name, body: copy as never, options: { fieldManager: 'kubectl-set' } }));
  return r.ok ? out(`deployment.apps/${name} image updated\n`) : err(serverError(r));
};

/**
 * kubectl get for polling and substitution only: `-o name` and `-o jsonpath=…` of a listing or of
 * named objects (a List when several are named). Never used for a compared step.
 */
const getVerb: Verb = (env, a, ns) => {
  const rs = refs(a.pos);
  if (!rs || rs.length === 0) return { unsupported: `kubectl get ${a.pos.join(' ')}` };
  const o = flag(a, 'output') ?? '';
  const objs = resolve(env, rs, ns, a);
  const named = rs.filter((r) => r.name !== undefined);
  if (named.length > 0 && objs.length < named.length) return err('Error from server (NotFound): not found');
  if (o === 'name') return out(objs.map(([m, x]) => `${qualified(m, String(meta(x).name))}\n`).join(''));
  if (o.startsWith('jsonpath=')) {
    const single = named.length === 1 && rs.length === 1;
    const data = single ? objs[0]?.[1] : { apiVersion: 'v1', kind: 'List', items: objs.map(([, x]) => x), metadata: { resourceVersion: '' } };
    try {
      return out(jsonpath(o.slice('jsonpath='.length), data));
    } catch (e) {
      return err(`error: error executing jsonpath: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { unsupported: `kubectl get -o ${o || 'table'} in the shim` };
};

/** Commands that read and print only: no state to replay. */
const READ_ONLY: Verb = () => out('');

const VERBS: Record<string, Verb> = {
  create,
  run,
  apply,
  delete: del,
  wait,
  rollout,
  label,
  scale,
  cordon: cordon(true),
  uncordon: cordon(false),
  taint,
  patch: patchVerb,
  expose,
  set,
  get: getVerb,
  describe: READ_ONLY,
  logs: READ_ONLY,
  explain: READ_ONLY,
  top: READ_ONLY,
  version: READ_ONLY,
  'cluster-info': READ_ONLY,
  'api-resources': READ_ONLY,
  'api-versions': READ_ONLY,
  kustomize: READ_ONLY,
  help: READ_ONLY,
  options: READ_ONLY,
};


/** The kubectl verb of a command line (`kubectl -n x get …` → get), or undefined when it is not one simple kubectl command. */
export function verbOf(line: string): { verb: string; sub?: string } | undefined {
  const w = splitWords(line, () => 'x');
  if (!w || w.words[0] !== 'kubectl') return undefined;
  const pos = parseArgs(w.words.slice(1)).pos;
  if (pos.length === 0) return { verb: '' };
  return { verb: pos[0] as string, ...(pos[1] !== undefined ? { sub: pos[1] } : {}) };
}

/** `kubectl config` subcommands that only read the kubeconfig. */
const CONFIG_MUTATORS = new Set(['use-context', 'set-context', 'delete-context', 'rename-context', 'set-cluster', 'delete-cluster', 'set-credentials', 'delete-user', 'set', 'unset']);

/**
 * Whether the command changes no state the rest of a case could see, so that it may be skipped
 * without blocking: verbs that only read (`get` too: it is what is under test, and is reported, not
 * replayed), anything with `--dry-run=client|server` or `--local`, help, and — in a client-only case,
 * where the oracle had no server — every command but those that write the kubeconfig.
 */
export function readOnly(line: string, server = true): boolean {
  const v = verbOf(line);
  if (!v) return false;
  if (v.verb === 'config') return !CONFIG_MUTATORS.has(v.sub ?? '');
  if (!server) return true;
  if (/(^| )--dry-run(=(client|server))?( |$)/.test(line) || /(^| )--local( |$|=true)/.test(line)) return true;
  if (v.verb === 'rollout') return v.sub === 'history' || v.sub === 'status';
  if (/(^| )(-h|--help)( |$)/.test(line)) return true;
  return VERBS[v.verb] === READ_ONLY || v.verb === 'get' || v.verb === '';
}

/** Runs one kubectl command line through the shim. */
export function shim(env: ShimEnv, line: string, stdin?: string): ShimResult | Unsupported {
  const w = splitWords(line, env.substitute);
  if (!w || w.words[0] !== 'kubectl') return { unsupported: `the shell command "${line}"` };
  const a = parseArgs(w.words.slice(1));
  const verb = a.pos.shift() ?? '';
  if (/(^| )(-h|--help)( |$)/.test(line)) return out('');
  if (verb === 'config' && !CONFIG_MUTATORS.has(a.pos[0] ?? '')) return out('');
  if (verb === 'config') return { unsupported: `kubectl config ${a.pos[0] ?? ''} writes the kubeconfig, which the shim does not do` };
  const fn = VERBS[verb];
  if (!fn) return { unsupported: `kubectl ${verb} is not in the shim` };
  const ns = flag(a, 'namespace') ?? 'default';
  try {
    return fn(env, a, ns, stdin);
  } catch (e) {
    if (e instanceof NotSimulated) return { unsupported: `the API server does not simulate ${e.message}` };
    throw e;
  }
}

/** The phase that brings a verb to the simulated kubectl (prompts/07b, 08, 15, 18b, 23, 26b). */
export function phaseOf(line: string): string {
  const v = verbOf(line);
  if (!v) return 'unknown';
  const sub = v.sub ?? '';
  if (v.verb === 'get') {
    if (/jsonpath|custom-columns|--sort-by|--field-selector|--raw/.test(line)) return '15';
    return '07a';
  }
  if (v.verb === 'create') return /(^| )(-f|--filename)( |=)/.test(line) ? '07b' : '08';
  if (['describe', 'apply', 'delete'].includes(v.verb)) return '07b';
  if (['patch', 'wait', 'replace'].includes(v.verb)) return '15';
  // prompts/08: config view, get-contexts, use-context, set-context --current; prompts/15: the rest.
  if (v.verb === 'config') return ['view', 'get-contexts', 'use-context', 'set-context', 'current-context'].includes(sub) ? '08' : '15';
  if (['top', 'autoscale'].includes(v.verb)) return '18b';
  if (['cordon', 'uncordon', 'drain', 'taint'].includes(v.verb)) return '26b';
  if (v.verb === 'kustomize') return '23';
  if (['auth', 'certificate'].includes(v.verb)) return '20a';
  if (['exec', 'cp', 'port-forward'].includes(v.verb)) return '17';
  return '08';
}
