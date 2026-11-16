// What every rollout subcommand builds first: the objects named by arguments, a selector or -f,
// fetched from the server (the builder's Latest()), with ContinueOnError's error collection.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/rollout/rollout_{status,history,undo,pause,
//             resume,restart}.go Complete (the namespace), Validate ("required resource not
//             specified"), Run (NamespaceParam().DefaultNamespace(), LabelSelectorParam,
//             FilenameParam(EnforceNamespace), ResourceTypeOrNameArgs(true, …), ContinueOnError,
//             Latest, Flatten)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go IsFilenameSliceEmpty
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go visitByPaths (resource
//             arguments refused with paths), visitor.go Info.Get (NotFound outside default checks
//             the namespace), RetrieveLatest, ContinueOnErrorVisitor

import type { Op, ProcApi } from '@simlab/host';
import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import type { RequestOptions } from '../../../apiserver/types.ts';
import type { Invocation } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { ClientConfig } from '../../client/kubeconfig.ts';
import type { Mapping } from '../../client/restmapper.ts';
import { fail, openSession, overridesOf, request, resolveConfig, type Session } from '../../client/session.ts';
import { argumentError, buildPlan, splitResourceArgument } from '../../resource/builder.ts';
import { visitFiles } from '../../resource/files.ts';
import { openServer, sessionOf } from '../../resource/server.ts';
import { enhanceListError } from '../get.ts';
import { parseYaml } from '../printing.ts';

/** resource.Info after Latest(): the object as the server holds it now. */
export interface Info {
  mapping: Mapping;
  namespace: string;
  name: string;
  object: JsonObject;
}

/** One visited item: an object or the error its retrieval returned, in visiting order. */
export type Visited = { info: Info } | { error: KubectlError };

export interface Built {
  /** Undefined only when -f's documents all failed before any reached the server. */
  session: Session | undefined;
  config: ClientConfig;
  visited: Visited[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function apiVersionOf(m: Mapping): string {
  return m.group === '' ? m.version : `${m.group}/${m.version}`;
}

/** `<resource>[.<group>]`, as the pause/resume/restart errors name a type. */
export function resourceString(m: Mapping): string {
  return m.group === '' ? m.resource : `${m.resource}.${m.group}`;
}

/** schema.GroupKind.String(): `Kind` or `Kind.group`. */
export function groupKindString(m: Mapping): string {
  return m.group === '' ? m.kind : `${m.kind}.${m.group}`;
}

/** The resolved client configuration, or the exit status after its error. */
export function* configOf(inv: Invocation): Op<ClientConfig | number> {
  const config = resolveConfig(inv.p, overridesOf(inv.flags.values), parseYaml);
  if ('type' in config) return yield* fail(inv.p, config);
  return config;
}

/** Validate: arguments or -f/-k must name something. */
export function requiredResource(inv: Invocation): KubectlError | undefined {
  const filenames = (inv.flags.values.filename as string[] | undefined) ?? [];
  if (inv.args.length === 0 && filenames.length === 0 && str(inv.flags.values.kustomize) === '') return messageError('required resource not specified');
  return undefined;
}

/** -k and URLs print a notice before anything is built. */
export function* kustomizeNotice(inv: Invocation): Op<number | undefined> {
  if (inv.flags.changed.includes('kustomize')) return yield* inv.p.unsupported({ kind: 'flag', what: 'the flag --kustomize' });
  return undefined;
}

/** visitByPaths: resource arguments are refused with paths. */
function pathArgumentError(args: readonly string[]): KubectlError | undefined {
  if (args.length === 0) return undefined;
  const combined = args.length >= 2 && splitResourceArgument(args[0] as string).length > 1;
  if (!combined && !args.every((a) => a.includes('/'))) return messageError('when paths, URLs, or stdin is provided as input, you may not specify resource arguments as well');
  return messageError('resource/name arguments cannot be provided when a path is specified');
}

function withTypeMeta(obj: JsonObject, m: Mapping): JsonObject {
  return { apiVersion: apiVersionOf(m), kind: m.kind, ...obj };
}

/** Info.Get: the object, or its error (a NotFound outside default may be its namespace's). */
function* getLatest(s: Session, m: Mapping, namespace: string, name: string): Op<Visited | { notSimulated: string }> {
  const r = yield* request(s, { verb: 'get', group: m.group, version: m.version, resource: m.resource, ...(m.namespaced && namespace ? { namespace } : {}), name });
  if (r.ok) return { info: { mapping: m, namespace: m.namespaced ? namespace : '', name, object: withTypeMeta(r.object as JsonObject, m) } };
  if ('notSimulated' in r) return { notSimulated: r.notSimulated };
  let status = r.status;
  if (status.reason === 'NotFound' && m.namespaced && namespace !== '' && namespace !== 'default') {
    const ns = yield* request(s, { verb: 'get', group: '', version: 'v1', resource: 'namespaces', name: namespace });
    if (!ns.ok && !('notSimulated' in ns) && ns.status.reason === 'NotFound') status = ns.status;
  }
  return { error: { type: 'status', status } };
}

function* typeNotice(p: ProcApi, m: Mapping): Op<number> {
  return yield* p.unsupported({ kind: 'resource', what: `the resource type "${resourceString(m)}"` });
}

/**
 * Builds and visits: the objects in order with the errors of their retrieval, or the exit status
 * when the builder failed before visiting (r.Err()) or a notice was printed.
 */
export function* buildInfos(inv: Invocation, config: ClientConfig): Op<Built | number> {
  const { p } = inv;
  const v = inv.flags.values;
  const selector = str(v.selector).trim();
  const filenames = (v.filename as string[] | undefined) ?? [];
  const visited: Visited[] = [];
  if (filenames.length > 0) {
    const server = yield* openServer(p, config);
    if (typeof server === 'number') return server;
    const items = yield* visitFiles(p, { filenames, recursive: v.recursive === true }, config.namespace, config.explicitNamespace, { selector, server });
    if (!Array.isArray(items)) return yield* fail(p, items);
    const pathErr = pathArgumentError(inv.args);
    if (pathErr) return yield* fail(p, pathErr);
    const readErrors: KubectlError[] = [];
    const session = sessionOf(server);
    for (const item of items) {
      if ('error' in item) {
        if (item.stage === 'read') readErrors.push(item.error);
        else visited.push({ error: item.error });
        continue;
      }
      // A mapped document needed discovery, so the server answered.
      if (!session) throw new Error('rollout -f: an object was mapped without a server');
      const got = yield* getLatest(session, item.mapping, item.namespace, item.name);
      if ('notSimulated' in got) return yield* typeNotice(p, item.mapping);
      visited.push(got);
    }
    // The EagerVisitorList's errors come after everything else, as one aggregate.
    if (readErrors.length > 0) visited.push({ error: readErrors.length === 1 ? (readErrors[0] as KubectlError) : { type: 'aggregate', errors: readErrors } });
    return { session, config, visited };
  }
  const argErr = argumentError(inv.args);
  if (argErr) return yield* fail(p, argErr);
  const opened = yield* openSession(p, config);
  if (typeof opened === 'number') return opened;
  const s = opened;
  const plan = buildPlan({ args: inv.args, namespace: config.namespace, allNamespaces: false, ...(selector !== '' ? { labelSelector: selector } : {}) });
  if ('type' in plan) return yield* fail(p, plan);
  for (const visit of plan.visits) {
    const m = visit.mapping;
    if (visit.kind === 'get') {
      const got = yield* getLatest(s, m, visit.namespace, visit.name);
      if ('notSimulated' in got) return yield* typeNotice(p, m);
      visited.push(got);
      continue;
    }
    const options: RequestOptions = {};
    if (visit.labelSelector !== '') options.labelSelector = visit.labelSelector;
    if (visit.fieldSelector !== '') options.fieldSelector = visit.fieldSelector;
    const r = yield* request(s, { verb: 'list', group: m.group, version: m.version, resource: m.resource, ...(m.namespaced && visit.namespace ? { namespace: visit.namespace } : {}), options });
    if (!r.ok) {
      if ('notSimulated' in r) {
        if (visit.fromCategory) continue;
        return yield* typeNotice(p, m);
      }
      visited.push({ error: { type: 'status', status: enhanceListError(r.status, visit) } });
      continue;
    }
    for (const item of ((r.object as JsonObject).items as JsonObject[] | undefined) ?? []) {
      const md = isObject(item.metadata) ? item.metadata : {};
      visited.push({ info: { mapping: m, namespace: m.namespaced ? str(md.namespace) : '', name: str(md.name), object: withTypeMeta(item, m) } });
    }
  }
  return { session: s, config, visited };
}

/** ContinueOnError's result: nil, one error, or the aggregate of all of them in order. */
export function aggregateOf(errors: readonly KubectlError[]): KubectlError | undefined {
  if (errors.length === 0) return undefined;
  return errors.length === 1 ? errors[0] : { type: 'aggregate', errors: [...errors] };
}

