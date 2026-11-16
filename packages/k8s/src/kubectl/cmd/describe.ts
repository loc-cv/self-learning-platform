// kubectl describe: the objects named by type and name, type/name, a selector or a name prefix,
// each printed by its kind's describer (packages/k8s/src/kubectl/describe/), with its events.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/describe/describe.go NewDescribeFlags (ShowEvents
//             true, ChunkSize 500), AddFlags, ToOptions (the missing-type error), Run (the builder
//             with ContinueOnError, events off for several objects or an error unless --show-events
//             is set, describer errors deduplicated by text, "\n\n" between objects, "No resources
//             found"), DescribeMatchingResources (a NotFound with TYPE NAME_PREFIX lists the type in
//             the namespace and describes the names that start with the prefix, each followed by a
//             newline, or returns the original error)
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go Info.Get (a NotFound outside
//             default may be its namespace's), ContinueOnErrorVisitor (one error is returned as it
//             is, so IsNotFound sees it; several are an aggregate, which IsNotFound does not see
//             into); builder.go visitByName, visitBySelector
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/printing.go SuggestAPIResources
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go visitByPaths (resource
//             arguments refused with -f), FilenameParam; with -f the infos carry the file's objects,
//             so RetrieveLazy sends nothing and a missing object is the describer's own error
//
// Kinds other than Pod, Deployment, Service and Node have describers upstream (most of them the
// generic one) that the simulator does not have yet: describing one prints a notice and nothing
// else.

import type { Op } from '@simlab/host';
import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import type { Invocation, Verb } from '../cli/command.ts';
import type { Status } from '../../apimachinery/errors.ts';
import { errorMessage, messageError, type KubectlError } from '../cli/errors.ts';
import type { FlagDef } from '../cli/flagset.ts';
import type { ClientConfig } from '../client/kubeconfig.ts';
import type { Mapping } from '../client/restmapper.ts';
import { fail, openSession, overridesOf, request, resolveConfig, type Session } from '../client/session.ts';
import { DESCRIBERS, type DescriberSettings } from '../describe/describers.ts';
import { NotSimulated } from '../describe/errors.ts';
import { argumentError, buildPlan, splitResourceArgument, type Plan, type Visit } from '../resource/builder.ts';
import { continueOnError, visitFiles } from '../resource/files.ts';
import { openServer, sessionOf } from '../resource/server.ts';
import { parseYaml } from './printing.ts';

const FLAGS: FlagDef[] = [
  { name: 'all-namespaces', shorthand: 'A', kind: 'bool', default: false },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'show-events', kind: 'bool', default: true },
  { name: 'chunk-size', kind: 'int64', default: 500 },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One object to describe: what the builder visited. */
interface Info {
  mapping: Mapping;
  namespace: string;
  name: string;
}

const resourceName = (m: Mapping): string => `${m.resource}${m.group ? `.${m.group}` : ''}`;
const notDescribed = (m: Mapping): string => `describe for the resource type "${resourceName(m)}"`;
const describerOf = (m: Mapping) => DESCRIBERS[`${m.group}/${m.kind}`];

type Visited = { infos: Info[]; errors: KubectlError[] } | { notice: string };

/** The builder's visitors with ContinueOnError and Flatten: infos and errors in order. */
function* visit(s: Session, plan: Plan): Op<Visited> {
  const infos: Info[] = [];
  const errors: KubectlError[] = [];
  for (const v of plan.visits) {
    const m = v.mapping;
    const base = { group: m.group, version: m.version, resource: m.resource, ...(v.namespace ? { namespace: v.namespace } : {}) };
    if (v.kind === 'list') {
      const options = { ...(v.labelSelector !== '' ? { labelSelector: v.labelSelector } : {}), ...(v.fieldSelector !== '' ? { fieldSelector: v.fieldSelector } : {}) };
      const r = yield* request(s, { verb: 'list', ...base, options });
      if (!r.ok) {
        if ('notSimulated' in r) {
          if (v.fromCategory) continue;
          return { notice: `the resource type "${resourceName(m)}"` };
        }
        errors.push({ type: 'status', status: enhanceListError(r.status, v) });
        continue;
      }
      for (const item of ((r.object as JsonObject).items as JsonObject[] | undefined) ?? []) {
        const md = isObject(item.metadata) ? item.metadata : {};
        infos.push({ mapping: m, namespace: str(md.namespace), name: str(md.name) });
      }
      continue;
    }
    // RetrieveLazy: Info.Get
    const r = yield* request(s, { verb: 'get', ...base, name: v.name });
    if (r.ok) {
      infos.push({ mapping: m, namespace: v.namespace, name: v.name });
      continue;
    }
    if ('notSimulated' in r) return { notice: `the resource type "${resourceName(m)}"` };
    let status = r.status;
    if (status.reason === 'NotFound' && v.namespace !== '' && v.namespace !== 'default') {
      const ns = yield* request(s, { verb: 'get', group: '', version: 'v1', resource: 'namespaces', name: v.namespace });
      if (!ns.ok && !('notSimulated' in ns) && ns.status.reason === 'NotFound') status = ns.status;
    }
    errors.push({ type: 'status', status });
  }
  return { infos, errors };
}

/** resource.EnhanceListError (helper.go), as get applies it. */
function enhanceListError(status: Status, v: Extract<Visit, { kind: 'list' }>): Status {
  if (status.reason !== 'BadRequest' && status.reason !== 'NotFound') return status;
  const m = v.mapping;
  const subj = `${m.group}/${m.version}, Resource=${m.resource}`;
  const message =
    v.labelSelector === '' && v.fieldSelector === ''
      ? `Unable to list "${subj}": ${status.message ?? ''}`
      : `Unable to find "${subj}" that match label selector "${v.labelSelector}", field selector "${v.fieldSelector}": ${status.message ?? ''}`;
  return { ...status, message };
}

/** The texts of the objects' descriptions, or the notice to print instead of anything. */
type Described = { texts: string[]; errors: KubectlError[] } | { notice: string };

function* describeAll(s: Session, infos: Info[], settings: DescriberSettings): Op<Described> {
  for (const info of infos) if (!describerOf(info.mapping)) return { notice: notDescribed(info.mapping) };
  const texts: string[] = [];
  const errors: KubectlError[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    const describer = describerOf(info.mapping);
    if (!describer) continue;
    let r;
    try {
      r = yield* describer(s, info.namespace, info.name, settings);
    } catch (e) {
      if (e instanceof NotSimulated) return { notice: e.what };
      throw e;
    }
    if ('error' in r) {
      if (r.error.type === 'notSimulated') return { notice: r.error.what };
      // errs.Has(err.Error())
      const key = errorMessage(r.error).text;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push(r.error);
      continue;
    }
    texts.push(r.text);
  }
  return { texts, errors };
}

/** IsNotFound: a single error as it is (an aggregate of several is not looked into). */
const isNotFound = (errors: KubectlError[]): boolean => errors.length === 1 && errors[0]?.type === 'status' && errors[0].status.reason === 'NotFound';

// Go's time.Local: TZ unset reads /etc/localtime (UTC on the simulated machines), empty is UTC;
// a zone with offset 0 prints +0000 in RFC1123Z like UTC. Names as packages/host's date reads them.
const ZERO_OFFSET_ZONES = new Set(['UTC', 'UTC0', 'Etc/UTC', ':UTC', ':Etc/UTC', 'Universal', 'Zulu', 'UCT', 'UTC+0', 'GMT', 'GMT0', 'Etc/GMT', 'GMT+0']);

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const tz = p.env.TZ;
  if (tz !== undefined && tz !== '' && !ZERO_OFFSET_ZONES.has(tz)) {
    return yield* p.unsupported({ kind: 'behavior', what: `the time zone TZ=${tz}`, hints: ['the simulated machines run in UTC; TZ=UTC or an unset TZ works'] });
  }
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const filenames = (v.filename as string[] | undefined) ?? [];
  if (inv.args.length === 0 && filenames.length === 0) {
    return yield* fail(p, messageError('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.\n'));
  }
  const allNamespaces = v['all-namespaces'] === true;
  const showEventsSet = flags.changed.includes('show-events');
  const argErr = argumentError(inv.args);
  if (argErr) return yield* fail(p, argErr);
  if (filenames.length > 0) return yield* runFiles(inv, config, filenames, allNamespaces, showEventsSet);
  const session = yield* openSession(p, config);
  if (typeof session === 'number') return session;
  // LabelSelectorParam ignores an empty (or blank) selector.
  const selector = str(v.selector).trim();
  const plan = buildPlan({ args: inv.args, namespace: config.namespace, allNamespaces, ...(selector !== '' ? { labelSelector: selector } : {}) });
  if ('type' in plan) return yield* fail(p, plan);
  const visited = yield* visit(session, plan);
  if ('notice' in visited) return yield* p.unsupported({ kind: 'resource', what: visited.notice });
  const { infos, errors } = visited;
  const settings: DescriberSettings = { showEvents: v['show-events'] !== false };
  if ((errors.length > 0 || infos.length > 1) && !showEventsSet) settings.showEvents = false;
  if (errors.length > 0 && isNotFound(errors) && inv.args.length === 2) {
    return yield* describeMatching(session, errors[0] as KubectlError, inv.args[0] as string, inv.args[1] as string, config.namespace, settings);
  }
  const described = yield* describeAll(session, infos, settings);
  if ('notice' in described) return yield* p.unsupported({ kind: 'resource', what: described.notice });
  if (described.texts.length > 0) yield* p.write(1, described.texts.join('\n\n'));
  const all = [...errors, ...described.errors];
  if (infos.length === 0 && all.length === 0) {
    yield* p.write(2, allNamespaces ? 'No resources found\n' : `No resources found in ${config.namespace} namespace.\n`);
  }
  if (all.length === 0) return 0;
  return yield* fail(p, { type: 'aggregate', errors: all });
}

/** visitByPaths: the argument errors with -f (after normalizeMultipleResourcesArgs). */
function pathArgumentError(args: readonly string[]): KubectlError | undefined {
  if (args.length === 0) return undefined;
  const combined = args.length >= 2 && splitResourceArgument(args[0] as string).length > 1;
  if (!combined && !args.every((a) => a.includes('/'))) return messageError('when paths, URLs, or stdin is provided as input, you may not specify resource arguments as well');
  return messageError('resource/name arguments cannot be provided when a path is specified');
}

/** describe -f: the objects the manifests name, each described from the server. */
function* runFiles(inv: Invocation, config: ClientConfig, filenames: string[], allNamespaces: boolean, showEventsSet: boolean): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  // AllNamespaces(true) empties the builder's namespace, which a file's objects without one would
  // then be described in; not modeled.
  if (allNamespaces) return yield* p.unsupported({ kind: 'flag', what: 'the flag --all-namespaces with -f' });
  const server = yield* openServer(p, config);
  if (typeof server === 'number') return server;
  const items = yield* visitFiles(p, { filenames, recursive: v.recursive === true }, config.namespace, config.explicitNamespace, { selector: str(v.selector), server });
  if (!Array.isArray(items)) return yield* fail(p, items);
  const pathErr = pathArgumentError(inv.args);
  if (pathErr) return yield* fail(p, pathErr);
  const infos: Info[] = [];
  const visitErrors: KubectlError[] = [];
  const readErrors: KubectlError[] = [];
  for (const item of items) {
    if ('error' in item) (item.stage === 'read' ? readErrors : visitErrors).push(item.error);
    else infos.push({ mapping: item.mapping, namespace: item.mapping.namespaced ? item.namespace : '', name: item.name });
  }
  const infosErr = continueOnError(visitErrors, readErrors);
  const settings: DescriberSettings = { showEvents: v['show-events'] !== false };
  if ((infosErr !== undefined || infos.length > 1) && !showEventsSet) settings.showEvents = false;
  const session = sessionOf(server);
  let texts: string[] = [];
  let errors: KubectlError[] = [];
  if (infos.length > 0) {
    // a mapping needs discovery, so an object was read only if the server answered
    if (!session) throw new Error('describe -f: an object was mapped without a server');
    const described = yield* describeAll(session, infos, settings);
    if ('notice' in described) return yield* p.unsupported({ kind: 'resource', what: described.notice });
    ({ texts, errors } = described);
  }
  if (texts.length > 0) yield* p.write(1, texts.join('\n\n'));
  const all = [...(infosErr ? [infosErr] : []), ...errors];
  if (infos.length === 0 && all.length === 0) yield* p.write(2, `No resources found in ${config.namespace} namespace.\n`);
  if (all.length === 0) return 0;
  return yield* fail(p, { type: 'aggregate', errors: all });
}

/** DescribeMatchingResources */
function* describeMatching(s: Session, original: KubectlError, resource: string, prefix: string, namespace: string, settings: DescriberSettings): Op<number> {
  const p = s.p;
  const plan = buildPlan({ args: [resource], namespace, allNamespaces: false, singleResourceType: true });
  if ('type' in plan) return yield* fail(p, plan);
  const visited = yield* visit(s, plan);
  if ('notice' in visited) return yield* p.unsupported({ kind: 'resource', what: visited.notice });
  // Without ContinueOnError the first error ends the visit.
  if (visited.errors.length > 0) return yield* fail(p, visited.errors[0] as KubectlError);
  const matching = visited.infos.filter((i) => i.name.startsWith(prefix));
  if (matching.length === 0) return yield* fail(p, original);
  let out = '';
  for (const info of matching) {
    const described = yield* describeAll(s, [info], settings);
    if ('notice' in described) return yield* p.unsupported({ kind: 'resource', what: described.notice });
    if (described.errors.length > 0) {
      if (out !== '') yield* p.write(1, out);
      return yield* fail(p, described.errors[0] as KubectlError);
    }
    out += `${described.texts[0] as string}\n`;
  }
  yield* p.write(1, out);
  return 0;
}

export const describeVerb: Verb = {
  path: 'describe',
  flags: FLAGS,
  noEffect: {
    'chunk-size': 'lists are answered whole; the printed result is the same',
  },
  run,
};
