// kubectl expose: a Service for a Pod, Deployment, ReplicaSet, ReplicationController or Service,
// named by arguments (fetched from the server) or by -f (the file's object as it is). The
// selector, ports, protocols and labels come from the object unless flags give them. Like
// upstream, the options carry over from one object to the next when several are named (the first
// object's selector and ports are reused).
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/expose/expose.go AddFlags, ToOptions, Complete,
//             RunExpose, createService, parseLabels, makeProtocols, parseProtocols
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/canbeexposed.go,
//             mapbasedselectorforobject.go (MakeLabels), portsforobject.go,
//             multiprotocolsforobject.go
//   upstream: staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupKind.String;
//             staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go Parse
//   fixtures/golden/v1.37.2/generate/expose.yaml, errors/not-found.yaml

import type { Op } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { goQuote, type FlagDef } from '../../cli/flagset.ts';
import type { Mapping } from '../../client/restmapper.ts';
import { fail, openSession, overridesOf, request, resolveConfig } from '../../client/session.ts';
import { argumentError, buildPlan } from '../../resource/builder.ts';
import { continueOnError, visitFiles } from '../../resource/files.ts';
import { openServer } from '../../resource/server.ts';
import { pathArgumentError } from '../delete.ts';
import { dryRunStrategy } from '../helpers.ts';
import { parseYaml } from '../printing.ts';
import { createRequest, printObject, str, strs, typedApplyAnnotation } from './common.ts';
import { typedPrinter, type TypedPrinter } from '../typed.ts';
import { OUTPUT_FORMATS, OUTPUT_NO_EFFECT, OUTPUT_PARTIAL, outputFlags } from './generator.ts';
import { applyOverrides, OVERRIDE_FLAGS, OVERRIDE_PARTIAL } from './overrides.ts';

const FLAGS: FlagDef[] = [
  ...outputFlags('kubectl-expose'),
  { name: 'protocol', kind: 'string', default: '' },
  { name: 'port', kind: 'string', default: '' },
  { name: 'type', kind: 'string', default: '' },
  { name: 'load-balancer-ip', kind: 'string', default: '' },
  { name: 'selector', kind: 'string', default: '' },
  { name: 'labels', shorthand: 'l', kind: 'string', default: '' },
  { name: 'target-port', kind: 'string', default: '' },
  { name: 'external-ip', kind: 'string', default: '' },
  { name: 'name', kind: 'string', default: '' },
  { name: 'session-affinity', kind: 'string', default: '' },
  { name: 'cluster-ip', kind: 'string', default: '' },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  ...OVERRIDE_FLAGS,
];

/** canBeExposed */
const EXPOSABLE = new Set(['/ReplicationController', '/Service', '/Pod', 'apps/Deployment', 'apps/ReplicaSet', 'extensions/Deployment', 'extensions/ReplicaSet']);

const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const strMap = (v: Json | undefined): Record<string, string> | undefined => (isObject(v) ? (v as Record<string, string>) : undefined);

/** MakeLabels: `k=v` pairs joined by commas (map order; parsed back into a map, so order does not show). */
function makeLabels(m: Record<string, string> | undefined): string {
  return Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

/** %+v of []metav1.LabelSelectorRequirement */
function requirements(exprs: Json[]): string {
  return `[${exprs
    .map((e) => {
      const r = obj(e);
      const values = Array.isArray(r.values) ? (r.values as string[]).join(' ') : '';
      return `{Key:${str(r.key)} Operator:${str(r.operator)} Values:[${values}]}`;
    })
    .join(' ')}]`;
}

/** mapBasedSelectorForObject */
function selectorFor(kind: string, o: JsonObject): string | { error: string } {
  const spec = obj(o.spec);
  if (kind === 'ReplicationController') return makeLabels(strMap(spec.selector));
  if (kind === 'Pod') {
    const labels = strMap(obj(o.metadata).labels);
    if (!labels || Object.keys(labels).length === 0) return { error: 'the pod has no labels and cannot be exposed' };
    return makeLabels(labels);
  }
  if (kind === 'Service') {
    if (!isObject(spec.selector)) return { error: 'the service has no pod selector set' };
    return makeLabels(strMap(spec.selector));
  }
  const what = kind === 'Deployment' ? 'deployment' : 'replicaset';
  const sel = isObject(spec.selector) ? spec.selector : undefined;
  const ml = strMap(sel?.matchLabels);
  if (!sel || !ml || Object.keys(ml).length === 0) return { error: `invalid ${what}: no selectors, therefore cannot be exposed` };
  const exprs = Array.isArray(sel.matchExpressions) ? sel.matchExpressions : [];
  if (exprs.length > 0) return { error: `couldn't convert expressions - "${requirements(exprs)}" to map-based selector format` };
  return makeLabels(ml);
}

/** The containers' or the Service's ports: each port once, as text, with its protocols. */
function portsFor(kind: string, o: JsonObject): { ports: string[]; protocols: Record<string, string[]> } {
  const spec = obj(o.spec);
  const ports: string[] = [];
  const protocols: Record<string, string[]> = {};
  const add = (port: Json | undefined, protocol: Json | undefined) => {
    const key = String(typeof port === 'number' ? port : 0);
    if (!ports.includes(key)) ports.push(key);
    (protocols[key] ??= []).push(typeof protocol === 'string' && protocol !== '' ? protocol : 'TCP');
  };
  if (kind === 'Service') {
    for (const sp of Array.isArray(spec.ports) ? spec.ports : []) add(obj(sp).port, obj(sp).protocol);
    return { ports, protocols };
  }
  const podSpec = kind === 'Pod' ? spec : obj(obj(spec.template).spec);
  for (const c of Array.isArray(podSpec.containers) ? podSpec.containers : []) {
    for (const cp of Array.isArray(obj(c).ports) ? (obj(c).ports as Json[]) : []) add(obj(cp).containerPort, obj(cp).protocol);
  }
  return { ports, protocols };
}

/** expose.go parseLabels */
function parseLabels(spec: string): { labels: Record<string, string> } | { error: string } {
  if (spec === '') return { error: 'no label spec passed' };
  const out: Record<string, string> = {};
  for (const item of spec.split(',')) {
    const kv = item.split('=');
    if (kv.length !== 2) return { error: `unexpected label spec: ${item}` };
    if (kv[0] === '') return { error: 'unexpected empty label key' };
    out[kv[0] as string] = kv[1] as string;
  }
  return { labels: out };
}

/** strconv.Atoi, with its error text. */
function atoi(s: string): number | { error: string } {
  if (!/^[+-]?[0-9]+$/.test(s)) return { error: `strconv.Atoi: parsing ${goQuote(s)}: invalid syntax` };
  const n = BigInt(s);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return { error: `strconv.Atoi: parsing ${goQuote(s)}: value out of range` };
  return Number(n);
}

/** What RunExpose keeps on its options while it visits. */
interface State {
  name: string;
  defaultName: string;
  selector: string;
  port: string;
  ports: string;
  protocol: string;
  protocols: Record<string, string[]> | undefined;
  labels: string;
  targetPort: string;
  externalIP: string;
  type: string;
  loadBalancerIP: string;
  sessionAffinity: string;
  clusterIP: string;
}

/** createService */
function createService(o: State): { service: JsonObject } | { error: string } {
  if (o.selector === '') return { error: 'selector must be specified' };
  const parsed = parseLabels(o.selector);
  if ('error' in parsed) return parsed;
  const selector = parsed.labels;
  let labels: Record<string, string> | undefined;
  if (o.labels !== '') {
    const l = parseLabels(o.labels);
    if ('error' in l) return l;
    labels = l.labels;
  }
  const name = o.name !== '' ? o.name : o.defaultName;
  if (name === '') return { error: 'name must be specified' };
  const portString = o.ports !== '' ? o.ports : o.port;
  const ports: JsonObject[] = [];
  if (portString !== '') {
    const list = portString.split(',');
    for (let i = 0; i < list.length; i++) {
      const s = list[i] as string;
      const port = atoi(s);
      if (typeof port !== 'number') return port;
      const portName = list.length > 1 ? `port-${i + 1}` : '';
      let protocol = o.protocol;
      const map = o.protocols ?? {};
      const haveMap = Object.keys(map).length > 0;
      if (protocol === '' && !haveMap) protocol = 'TCP';
      else if (protocol === '' && haveMap) {
        protocol = 'TCP';
        const found = map[s];
        if (found) {
          if (found.length === 1) protocol = found[0] as string;
          else {
            for (const p of found) ports.push({ name: `port-${i + 1}-${p.toLowerCase()}`, port, protocol: p });
            continue;
          }
        }
      }
      ports.push({ ...(portName !== '' ? { name: portName } : {}), port, protocol });
    }
  }
  if (o.targetPort !== '') {
    // intstr.Parse: a number when Atoi takes it, else a name
    const n = atoi(o.targetPort);
    const target = typeof n === 'number' ? n : o.targetPort;
    for (const p of ports) p.targetPort = target;
  } else for (const p of ports) p.targetPort = p.port as number;
  const spec: JsonObject = { selector, ports };
  if (o.externalIP !== '') spec.externalIPs = [o.externalIP];
  if (o.type !== '') spec.type = o.type;
  if (spec.type === 'LoadBalancer' && o.loadBalancerIP !== '') spec.loadBalancerIP = o.loadBalancerIP;
  if (o.sessionAffinity !== '') {
    if (o.sessionAffinity !== 'None' && o.sessionAffinity !== 'ClientIP') return { error: `unknown session affinity: ${o.sessionAffinity}` };
    spec.sessionAffinity = o.sessionAffinity;
  }
  if (o.clusterIP !== '') spec.clusterIP = o.clusterIP;
  return { service: { apiVersion: 'v1', kind: 'Service', metadata: { name, ...(labels ? { labels } : {}) }, spec } };
}

interface Info {
  mapping: Mapping;
  object: JsonObject;
  name: string;
}

function* run(inv: Invocation): Op<number> {
  const { p } = inv;
  const v = inv.flags.values;
  // ToOptions
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const printer = typedPrinter(str(v.output), 'exposed', dryRun, str(v.template));
  if ('type' in printer) return yield* fail(p, printer);
  // Complete
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const filenames = strs(v.filename);
  const kustomize = str(v.kustomize);
  if (kustomize !== '') return yield* p.unsupported({ kind: 'flag', what: 'the flag --kustomize (kustomize is not simulated)' });
  // RunExpose: the builder
  // The builder fetches each object as it visits it: errors and objects in argument order.
  const entries: ({ info: Info } | { error: KubectlError })[] = [];
  const readErrors: KubectlError[] = [];
  let server = yield* openServer(p, config);
  if (typeof server === 'number') return server;
  if (filenames.length > 0) {
    const items = yield* visitFiles(p, { filenames, recursive: v.recursive === true }, config.namespace, config.explicitNamespace, { server });
    if (!Array.isArray(items)) return yield* fail(p, items);
    const pathErr = pathArgumentError(inv.args);
    if (pathErr) return yield* fail(p, pathErr);
    for (const item of items) {
      if ('error' in item) {
        if (item.stage === 'read') readErrors.push(item.error);
        else entries.push({ error: item.error });
      } else entries.push({ info: { mapping: item.mapping, object: item.object, name: item.name } });
    }
  } else {
    if (inv.args.length === 0) {
      const plan = buildPlan({ args: [], namespace: config.namespace, allNamespaces: false, allowEmptySelector: false });
      if ('type' in plan) return yield* fail(p, plan);
    }
    const argErr = argumentError(inv.args);
    if (argErr) return yield* fail(p, argErr);
    const session = yield* openSession(p, config);
    if (typeof session === 'number') return session;
    server = { session };
    const plan = buildPlan({ args: inv.args, namespace: config.namespace, allNamespaces: false, allowEmptySelector: false });
    if ('type' in plan) return yield* fail(p, plan);
    for (const visit of plan.visits) {
      if (visit.kind !== 'get') continue;
      const m = visit.mapping;
      const r = yield* request(session, { verb: 'get', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), name: visit.name });
      if (r.ok) {
        entries.push({ info: { mapping: m, object: r.object as JsonObject, name: visit.name } });
        continue;
      }
      if ('notSimulated' in r) return yield* p.unsupported({ kind: 'resource', what: r.notSimulated });
      let status = r.status;
      // Info.Get: a missing namespace is reported instead of the object
      if (status.reason === 'NotFound' && visit.namespace !== '' && visit.namespace !== 'default') {
        const ns = yield* request(session, { verb: 'get', group: '', version: 'v1', resource: 'namespaces', name: visit.namespace });
        if (!ns.ok && !('notSimulated' in ns) && ns.status.reason === 'NotFound') status = ns.status;
      }
      entries.push({ error: { type: 'status', status } });
    }
  }
  const o: State = {
    name: str(v.name),
    defaultName: '',
    selector: str(v.selector),
    port: str(v.port),
    ports: '',
    protocol: str(v.protocol),
    protocols: undefined,
    labels: str(v.labels),
    targetPort: str(v['target-port']),
    externalIP: str(v['external-ip']),
    type: str(v.type),
    loadBalancerIP: str(v['load-balancer-ip']),
    sessionAffinity: str(v['session-affinity']),
    clusterIP: str(v['cluster-ip']),
  };
  const errors: KubectlError[] = [];
  for (const entry of entries) {
    if ('error' in entry) {
      errors.push(entry.error);
      continue;
    }
    const r = yield* exposeOne(inv, entry.info, o, printer, dryRun, config.namespace, config.explicitNamespace, server);
    if (typeof r === 'number') return r;
    if (r) errors.push(r);
  }
  const err = continueOnError(errors, readErrors);
  if (err) return yield* fail(p, err);
  return 0;
}

/** RunExpose's visit function for one object. */
function* exposeOne(
  inv: Invocation,
  info: Info,
  o: State,
  printer: TypedPrinter,
  dryRun: 'none' | 'client' | 'server',
  namespace: string,
  enforceNamespace: boolean,
  server: Parameters<typeof createRequest>[1],
): Op<KubectlError | undefined | number> {
  const { p } = inv;
  const v = inv.flags.values;
  const m = info.mapping;
  if (!EXPOSABLE.has(`${m.group}/${m.kind}`)) return messageError(`cannot expose a ${m.group === '' ? m.kind : `${m.kind}.${m.group}`}`);
  o.defaultName = info.name.length > 63 ? info.name.slice(0, 63) : info.name;
  if (o.selector === '') {
    const s = selectorFor(m.kind, info.object);
    if (typeof s !== 'string') return messageError(`couldn't retrieve selectors via --selector flag or introspection: ${s.error}`);
    o.selector = s;
  }
  const headless = o.clusterIP === 'None';
  const found = portsFor(m.kind, info.object);
  if (o.port === '') {
    if (found.ports.length === 0) {
      if (!headless) return messageError("couldn't find port via --port flag or introspection");
    } else if (found.ports.length === 1) o.port = found.ports[0] as string;
    else o.ports = found.ports.join(',');
  }
  if (Object.keys(found.protocols).length > 0) o.protocols = found.protocols;
  if (o.labels === '') o.labels = makeLabels(strMap(obj(info.object.metadata).labels));
  const created = createService(o);
  if ('error' in created) return messageError(created.error);
  const overridden = applyOverrides(created.service, 'core/v1.Service', str(v.overrides), str(v['override-type']));
  if ('error' in overridden) return overridden.error;
  const svc = overridden.object;
  if (dryRun === 'client') {
    if (enforceNamespace) (svc.metadata as JsonObject).namespace = namespace;
    return yield* printObject(p, printer, svc, 'core/v1.Service');
  }
  typedApplyAnnotation(v['save-config'] === true, svc, 'core/v1.Service');
  const r = yield* createRequest(p, server, { group: '', version: 'v1', resource: 'services', namespace }, svc, { fieldManager: str(v['field-manager']), directive: 'Strict', dryRun });
  if (typeof r === 'number') return r;
  if ('error' in r) return r.error;
  return yield* printObject(p, printer, r.object, 'core/v1.Service');
}

export const exposeVerb: Verb = {
  path: 'expose',
  flags: FLAGS,
  noEffect: { ...OUTPUT_NO_EFFECT },
  partial: { ...OUTPUT_PARTIAL, ...OVERRIDE_PARTIAL, kustomize: 'prints a notice: kustomize is not simulated', filename: 'URLs print a notice: the simulated machines have no network access' },
  outputFormats: OUTPUT_FORMATS,
  run,
};
