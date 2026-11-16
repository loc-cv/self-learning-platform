// The kubectl verbs the simulator does not have yet, as the API requests the real kubectl sends,
// so that a golden case's setup and state-changing steps can be replayed before their verbs are
// simulated. Tools code only: what the shim prints is never compared (a shimmed `patch` step is
// reported, not judged), and `kubectl get` is never shimmed for a compared step — it is what the
// differential runner tests. The shim's `get` serves only polling (`until`) and `$(...)`.
//
// Sources for what each verb sends (fieldManager values from each command's
// cmdutil.AddFieldManagerFlagVar; managedFields are not simulated, DIV-015, so they have no effect):
//   cmd/wait/wait.go (wait), cmd/patch/patch.go (patch), cmd/taint/taint.go and drain/cordon.go
//   (taint, cordon, uncordon).
//
// Patches go as real kubectl sends them, JSON merge or strategic merge (the API server applies
// both, apiserver/pipeline.ts patch); JSON patches are refused.

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

/** The texts `-f` names (a file, a directory's .yaml/.yml/.json files in name order, or `-`). */
function manifestTexts(env: ShimEnv, f: string, stdin: string | undefined): string[] {
  if (f === '-') return [stdin ?? ''];
  const dir = env.listDir(f);
  const files = dir ? dir.filter((n) => /\.(ya?ml|json)$/.test(n)).map((n) => `${f.replace(/\/$/, '')}/${n}`) : [f];
  return files.map((file) => env.readFile(file) ?? '');
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

/**
 * Why a `kubectl create -f` or `apply -f` cannot be replayed: its manifests use the oracle's
 * device (oracleDevice). The simulated kubectl creates such objects; the runner checks first.
 */
export function oracleDeviceIn(env: ShimEnv, line: string, stdin?: string): string | undefined {
  const w = splitWords(line, () => 'x');
  if (!w || w.words[0] !== 'kubectl') return undefined;
  const a = parseArgs(w.words.slice(1));
  if (!['create', 'apply'].includes(a.pos[0] ?? '') || !flag(a, 'filename')) return undefined;
  for (const f of a.flags.filename ?? []) {
    for (const text of manifestTexts(env, f, stdin)) {
      const why = oracleDevice(text);
      if (why) return why;
    }
  }
  return undefined;
}

// ---- patches ----

function patch(env: ShimEnv, m: Mapping, ns: string, name: string, body: unknown, type: string, opts: { subresource?: string; fieldManager: string }): ApiResponse | Unsupported {
  const why = oracleDevice(body);
  if (why) return { unsupported: why };
  if (type !== 'strategic' && type !== 'merge') return { unsupported: `${type} patches (the simulator applies JSON merge and strategic merge patches)` };
  return send(env, req(m, 'patch', ns, { name, body: body as never, ...(opts.subresource ? { subresource: opts.subresource } : {}), options: { patchType: type, fieldManager: opts.fieldManager } }));
}

// ---- verbs ----

type Verb = (env: ShimEnv, a: Args, ns: string, stdin: string | undefined) => ShimResult | Unsupported;

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
 * reorganizeTaints), sent as the two-way strategic patch of the Node; spec.taints has no patch
 * strategy, so the patch holds the whole list (null when none is left).
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
  const r = patch(env, m, '', node, { spec: { taints: taints.length > 0 ? taints : null } }, 'strategic', { fieldManager: 'kubectl-taint' });
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
  wait,
  cordon: cordon(true),
  uncordon: cordon(false),
  taint,
  patch: patchVerb,
  get: getVerb,
  describe: READ_ONLY,
  top: READ_ONLY,
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

/** `kubectl config` subcommands that write the kubeconfig and are not simulated yet (phase 15; view, get-*, current-context, use-, set- and delete-context are). */
const CONFIG_MUTATORS = new Set(['rename-context', 'set-cluster', 'delete-cluster', 'set-credentials', 'delete-user', 'set', 'unset']);

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

/** The phase that brings a verb to the simulated kubectl (prompts/07b, 15, 18b, 23, 26b). */
export function phaseOf(line: string): string {
  const v = verbOf(line);
  if (!v) return 'unknown';
  if (v.verb === 'get') {
    if (/jsonpath|custom-columns|--sort-by|--field-selector|--raw/.test(line)) return '15';
    return '07a';
  }
  // describe prints a notice only for kinds other than Pod, Deployment, Service and Node (prompts/15).
  if (v.verb === 'describe') return '15';
  if (['apply', 'create', 'delete'].includes(v.verb)) return '07b';
  if (['patch', 'wait', 'replace'].includes(v.verb)) return '15';
  if (v.verb === 'config') return '15';
  if (['top', 'autoscale'].includes(v.verb)) return '18b';
  if (['cordon', 'uncordon', 'drain', 'taint'].includes(v.verb)) return '26b';
  if (v.verb === 'kustomize') return '23';
  if (['auth', 'certificate'].includes(v.verb)) return '20a';
  if (['exec', 'cp', 'port-forward'].includes(v.verb)) return '17';
  return '15';
}
