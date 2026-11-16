// The objects a changing command works on: cli-runtime's resource builder with Unstructured(),
// ContinueOnError() and Flatten(), over resource arguments and selectors (each object fetched, list
// items given their kind), or over -f's manifests (re-fetched from the server with Latest(), or
// used as read with Local()). The result is in visit order, objects and errors alike, as the
// ContinueOnErrorVisitor hands them on; errors the builder records before visiting come back alone.
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go ResourceTypeOrNameArgs,
//             LabelSelectorParam, FieldSelectorParam, FilenameParam, Latest, Local, visitorResult,
//             visitByPaths ("when paths, URLs, or stdin is provided as input, you may not specify
//             resource arguments as well"), Do (singleItemImplied: one name, or one path that is not a
//             directory or a stream); LocalResourceError
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go ContinueOnErrorVisitor,
//             RetrieveLatest ("no namespace set on resource %s %q"), FlattenListVisitor;
//             staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/unstructured UnstructuredList (items
//             take the list's apiVersion and the kind without "List")

import type { Op, ProcApi } from '@simlab/host';
import { FsError } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import type { RequestOptions } from '../../../apiserver/types.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { ClientConfig } from '../../client/kubeconfig.ts';
import type { Mapping } from '../../client/restmapper.ts';
import { openSession, request, type Session } from '../../client/session.ts';
import { argumentError, buildPlan, splitResourceArgument } from '../../resource/builder.ts';
import { visitFiles } from '../../resource/files.ts';
import { openServer, sessionOf, type ServerState } from '../../resource/server.ts';
import { enhanceListError } from '../get.ts';

/** resource.Info with its object. */
export interface Info {
  mapping: Mapping;
  namespace: string;
  name: string;
  /** The file it came from, '' for an argument. */
  source: string;
  object: JsonObject;
}

/** One visit: an object, or an error handed to the visitor (ContinueOnError collects it). */
export type Entry = { info: Info } | { error: KubectlError };

export interface FindInput {
  config: ClientConfig;
  /** Resource arguments (types, names, type/name). */
  args: readonly string[];
  filenames: readonly string[];
  recursive: boolean;
  kustomize: string;
  local: boolean;
  /** ResourceTypeOrNameArgs(allowEmptySelector = --all, …). */
  all: boolean;
  selector: string;
  fieldSelector: string;
  allNamespaces: boolean;
  /** Latest(): objects from files are fetched from the server again. */
  latest: boolean;
  /** ResourceTypeOrNameArgs(true, …) without --all: a type alone selects all its objects (edit). */
  allowEmptySelector?: boolean;
  /** Subresource(…): objects are read from (and written to) this subresource. */
  subresource?: string;
}

export interface Found {
  entries: Entry[];
  /** The reader's errors (EagerVisitorList): reported after everything else. */
  readErrors: KubectlError[];
  singleItemImplied: boolean;
  /** The server, when one was reached (never with --local). */
  session: Session | undefined;
}

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

export const LOCAL_RESOURCE_ERROR = `error: you must specify resources by --filename when --local is set.
Example resource specifications include:
   '-f rsrc.yaml'
   '--filename=rsrc.json'`;

/** visitByPaths: the argument errors with -f (after normalizeMultipleResourcesArgs). */
function pathArgumentError(args: readonly string[]): KubectlError | undefined {
  if (args.length === 0) return undefined;
  const combined = args.length >= 2 && splitResourceArgument(args[0] as string).length > 1;
  if (!combined && !args.every((a) => a.includes('/'))) return messageError('when paths, URLs, or stdin is provided as input, you may not specify resource arguments as well');
  return messageError('resource/name arguments cannot be provided when a path is specified');
}

function isPlainFile(p: ProcApi, path: string): boolean {
  if (path === '-' || path.startsWith('http://') || path.startsWith('https://')) return false;
  try {
    return p.fs().stat(path).type !== 'dir';
  } catch (e) {
    if (e instanceof FsError) return false;
    throw e;
  }
}

function base(i: { mapping: Mapping; namespace: string }): { group: string; version: string; resource: string; namespace?: string } {
  const m = i.mapping;
  return { group: m.group, version: m.version, resource: m.resource, ...(m.namespaced && i.namespace !== '' ? { namespace: i.namespace } : {}) };
}

/** Fetches one object by name (Info.Get). */
export function* getObject(s: Session, info: { mapping: Mapping; namespace: string; name: string }, subresource = ''): Op<{ ok: JsonObject } | { error: KubectlError }> {
  const r = yield* request(s, { verb: 'get', ...base(info), name: info.name, ...(subresource !== '' ? { subresource } : {}) });
  if (!r.ok) return { error: 'notSimulated' in r ? { type: 'notSimulated', what: r.notSimulated } : { type: 'status', status: r.status } };
  return { ok: r.object as JsonObject };
}

/**
 * Resolves and fetches the objects: the result, the exit status when the connection failed (its
 * error already printed), or the builder's error.
 */
export function* find(p: ProcApi, input: FindInput): Op<Found | number | { error: KubectlError }> {
  const { config } = input;
  const argErr = argumentError(input.args);
  if (argErr && !input.local) return { error: argErr };
  if (input.filenames.length > 0 || input.kustomize !== '') {
    if (input.local && input.args.length > 0) return { error: messageError(LOCAL_RESOURCE_ERROR) };
    if (input.allNamespaces) return { error: { type: 'notSimulated', what: 'the flag --all-namespaces with -f' } };
    // Local(): nothing is asked of a server (ReadOptions.local skips discovery).
    const server: ServerState | number = input.local ? { refused: { scheme: 'http', host: '', port: 0, base: '', dialAddress: '' } } : yield* openServer(p, config);
    if (typeof server === 'number') return server;
    const items = yield* visitFiles(p, { filenames: [...input.filenames], recursive: input.recursive, ...(input.kustomize ? { kustomize: input.kustomize } : {}) }, config.namespace, config.explicitNamespace, {
      selector: input.local ? '' : input.selector,
      server,
      ...(input.local ? { local: true } : {}),
    });
    if (!Array.isArray(items)) return { error: items };
    if (!input.local) {
      const pathErr = pathArgumentError(input.args);
      if (pathErr) return { error: pathErr };
    }
    const session = input.local ? undefined : sessionOf(server);
    const entries: Entry[] = [];
    const readErrors: KubectlError[] = [];
    for (const item of items) {
      if ('error' in item) {
        if (item.stage === 'read') readErrors.push(item.error);
        else entries.push({ error: item.error });
        continue;
      }
      const info: Info = { mapping: item.mapping, namespace: item.namespace, name: item.name, source: item.source, object: item.object };
      if (input.latest && session && info.name !== '') {
        // RetrieveLatest
        if (info.mapping.namespaced && info.namespace === '') {
          entries.push({ error: messageError(`no namespace set on resource ${info.mapping.resource} "${info.name}"`) });
          continue;
        }
        const got = yield* getObject(session, info, input.subresource);
        if ('error' in got) {
          entries.push(got);
          continue;
        }
        info.object = got.ok;
      }
      entries.push({ info });
    }
    const single = input.filenames.length === 1 && isPlainFile(p, input.filenames[0] as string);
    return { entries, readErrors, singleItemImplied: single, session };
  }
  if (input.local) {
    if (input.args.length > 0) return { error: messageError(LOCAL_RESOURCE_ERROR) };
    // Nothing to visit: visitorResult's "You must provide one or more resources …".
    const none = buildPlan({ args: [], namespace: config.namespace, allNamespaces: false });
    return { error: 'type' in none ? none : messageError('no resources') };
  }
  // Discovery (and with it the connection) maps the types.
  const opened = yield* openSession(p, config);
  if (typeof opened === 'number') return opened;
  const selector = input.selector.trim();
  const fieldSelector = input.fieldSelector.trim();
  const selecting = input.all || selector !== '' || fieldSelector !== '';
  const plan = buildPlan({
    args: input.args,
    namespace: config.namespace,
    allNamespaces: input.allNamespaces,
    ...(selecting ? { labelSelector: selector } : {}),
    ...(fieldSelector !== '' ? { fieldSelector } : {}),
    allowEmptySelector: input.allowEmptySelector === true,
  });
  if ('type' in plan) return { error: plan };
  const entries: Entry[] = [];
  for (const visit of plan.visits) {
    const m = visit.mapping;
    if (visit.kind === 'get') {
      const got = yield* getObject(opened, { mapping: m, namespace: visit.namespace, name: visit.name }, input.subresource);
      entries.push('error' in got ? got : { info: { mapping: m, namespace: visit.namespace, name: visit.name, source: '', object: got.ok } });
      continue;
    }
    const options: RequestOptions = {};
    if (visit.labelSelector !== '') options.labelSelector = visit.labelSelector;
    if (visit.fieldSelector !== '') options.fieldSelector = visit.fieldSelector;
    const r = yield* request(opened, { verb: 'list', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), options });
    if (!r.ok) {
      if ('notSimulated' in r) {
        if (visit.fromCategory) continue;
        entries.push({ error: { type: 'notSimulated', what: r.notSimulated } });
        continue;
      }
      entries.push({ error: { type: 'status', status: enhanceListError(r.status, visit) } });
      continue;
    }
    const list = r.object as JsonObject;
    for (const item of (list.items as JsonObject[] | undefined) ?? []) {
      const object: JsonObject = { apiVersion: str(list.apiVersion), kind: m.kind, ...item };
      const md = isObject(item.metadata) ? item.metadata : {};
      entries.push({ info: { mapping: m, namespace: m.namespaced ? str(md.namespace) : '', name: str(md.name), source: '', object } });
    }
  }
  return { entries, readErrors: [], singleItemImplied: plan.singleItemImplied, session: opened };
}

/** The request coordinates of an info. */
export function infoBase(i: Info): { group: string; version: string; resource: string; namespace?: string } {
  return base(i);
}
