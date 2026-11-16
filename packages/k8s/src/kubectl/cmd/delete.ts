// kubectl delete: delete objects named by type and name, type/name, selector or --all, then wait
// (by default) until each is gone — in virtual time, so a Pod's grace period makes kubectl wait.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/delete/delete_flags.go NewDeleteCommandFlags
//             (flags and defaults), ToOptions, parseCascadingFlag (the cascade error and the
//             deprecated boolean forms' warnings)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/delete/delete.go Complete (ignore-not-found's
//             default with --all and selectors, --now, --grace-period=0 without --force becomes 1,
//             --force alone becomes 0, the builder with RequireObject(false): objects named are not
//             fetched first), Validate (-o, --all with a selector, the force warning and error),
//             DeleteResult (ContinueOnError, NotFound ignored, the cluster-scope warning, "No
//             resources found", no wait after an error or a dry run, a week when --timeout is 0),
//             deleteResource, PrintObj (the output lines)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/wait/delete.go IsDeleted (get, UID check, list
//             and watch by metadata.name until DELETED), wait.go RunWaitContext (one deadline for
//             all objects), condition.go extendErrWaitTimeout (`… on <resource>/<name>`)
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/wait/error.go errInterrupted.Error
//             ("timed out waiting for the condition")
//   upstream: staging/src/k8s.io/kubectl/pkg/util/interrupt/interrupt.go Handler.Signal (Ctrl-C
//             while waiting: exit 1, nothing printed)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetDryRunStrategy (klog warnings
//             at lines 714, 728, 731 of the pinned file), AddSourceToErr
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go SelectAllParam,
//             LabelSelectorParam, FieldSelectorParam (trimmed; empty means unset), visitByPaths
//             (-f with resource arguments; the label selector filters a file's objects)

import type { Op, ProcApi } from '@simlab/host';
import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import type { Status } from '../../apimachinery/errors.ts';
import type { ApiRequest, RequestOptions } from '../../apiserver/types.ts';
import { strategyFor } from '../../apiserver/strategies.ts';
import type { Invocation, Verb } from '../cli/command.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import { parseGoBool, type FlagDef } from '../cli/flagset.ts';
import { parseGoDuration } from '../cli/goduration.ts';
import type { Mapping } from '../client/restmapper.ts';
import { closeWatch, fail, openProcessWatch, openSession, overridesOf, request, resolveConfig, takeWatchEvents, klogLine, warningLine, type Session } from '../client/session.ts';
import { continueOnError, visitFiles, type FileItem } from '../resource/files.ts';
import { openServer } from '../resource/server.ts';
import { argumentError, buildPlan, splitResourceArgument, type Plan } from '../resource/builder.ts';
import { enhanceListError } from './get.ts';
import { parseYaml } from './printing.ts';

const FLAGS: FlagDef[] = [
  { name: 'all', kind: 'bool', default: false },
  { name: 'all-namespaces', shorthand: 'A', kind: 'bool', default: false },
  { name: 'cascade', kind: 'string', default: 'background', noOptDefVal: 'background' },
  { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: 'unchanged' },
  { name: 'field-selector', kind: 'string', default: '' },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'force', kind: 'bool', default: false },
  { name: 'grace-period', kind: 'int', default: -1 },
  { name: 'ignore-not-found', kind: 'bool', default: false },
  { name: 'now', kind: 'bool', default: false },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'timeout', kind: 'duration', default: '0s' },
  { name: 'wait', kind: 'bool', default: true },
];

type Propagation = 'Background' | 'Orphan' | 'Foreground';
type DryRun = 'none' | 'client' | 'server';

/** One object to delete: resource.Info without its object (RequireObject(false)). */
interface Info {
  mapping: Mapping;
  namespace: string;
  name: string;
  /** The file it came from (Info.Source), for AddSourceToErr. */
  source: string;
}

interface Options {
  propagation: Propagation;
  gracePeriod: number;
  dryRun: DryRun;
  output: string;
  ignoreNotFound: boolean;
  wait: boolean;
  /** Nanoseconds; 0 means a week. */
  timeoutNs: bigint;
  warnClusterScope: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const WEEK_NS = 168n * 3_600_000_000_000n;

/** printers.WarningPrinter */
function* printWarning(p: ProcApi, message: string): Op<void> {
  yield* p.write(2, warningLine(p, message));
}

/** parseCascadingFlag */
function* parseCascade(p: ProcApi, flag: string): Op<Propagation | KubectlError> {
  const b = parseGoBool(flag);
  if (b === undefined) {
    if (flag === 'orphan') return 'Orphan';
    if (flag === 'foreground') return 'Foreground';
    if (flag === 'background') return 'Background';
    return messageError(`invalid cascade value (${flag}). Must be "background", "foreground", or "orphan"`);
  }
  yield* p.write(2, `warning: --cascade=${flag} is deprecated (boolean value) and can be replaced with --cascade=${b ? 'background' : 'orphan'}.\n`);
  return b ? 'Background' : 'Orphan';
}

/** GetDryRunStrategy */
function* dryRunStrategy(p: ProcApi, flag: string): Op<DryRun | KubectlError> {
  const b = parseGoBool(flag);
  if (b === undefined) {
    switch (flag) {
      case 'unchanged':
        yield* p.write(2, klogLine(p, 'W', 'helpers.go:714', '--dry-run is deprecated and can be replaced with --dry-run=client.'));
        return 'client';
      case 'client':
      case 'server':
      case 'none':
        return flag;
      default:
        return messageError(`Invalid dry-run value (${flag}). Must be "none", "server", or "client".`);
    }
  }
  if (b) {
    yield* p.write(2, klogLine(p, 'W', 'helpers.go:728', `--dry-run=${flag} is deprecated (boolean value) and can be replaced with --dry-run=client.`));
    return 'client';
  }
  yield* p.write(2, klogLine(p, 'W', 'helpers.go:731', `--dry-run=${flag} is deprecated (boolean value) and can be replaced with --dry-run=none.`));
  return 'none';
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const changed = (name: string) => flags.changed.includes(name);
  // ToOptions
  const propagation = yield* parseCascade(p, str(v.cascade));
  if (typeof propagation !== 'string') return yield* fail(p, propagation);
  // Complete
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const deleteAll = v.all === true;
  const allNamespaces = v['all-namespaces'] === true;
  const labelSelector = str(v.selector);
  const fieldSelector = str(v['field-selector']);
  let ignoreNotFound = v['ignore-not-found'] === true;
  if ((deleteAll || labelSelector.length > 0 || fieldSelector.length > 0) && !changed('ignore-not-found')) ignoreNotFound = true;
  let gracePeriod = v['grace-period'] as number;
  const force = v.force === true;
  if (v.now === true) {
    if (gracePeriod !== -1) return yield* fail(p, messageError('--now and --grace-period cannot be specified together'));
    gracePeriod = 1;
  }
  if (gracePeriod === 0 && !force) gracePeriod = 1;
  if (force && gracePeriod < 0) gracePeriod = 0;
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const timeout = parseGoDuration(str(v.timeout));
  const timeoutNs = 'ns' in timeout ? timeout.ns : 0n;
  // The builder's own errors come before any request (visitorResult returns b.errs first).
  const trimmedLabel = labelSelector.trim();
  const trimmedField = fieldSelector.trim();
  const builderErrors: KubectlError[] = [];
  if (deleteAll && (trimmedLabel !== '' || trimmedField !== '')) builderErrors.push(messageError("setting 'all' parameter but found a non empty selector. "));
  const argErr = argumentError(inv.args);
  if (argErr) builderErrors.push(argErr);
  if (builderErrors.length > 0) return yield* fail(p, { type: 'aggregate', errors: builderErrors });
  const filenames = (v.filename as string[] | undefined) ?? [];
  let source: Source;
  let session: Session | undefined;
  if (filenames.length > 0) {
    // AllNamespaces(true) empties the builder's namespace, so a file's objects without one would be
    // deleted with none; not modeled.
    if (allNamespaces) return yield* p.unsupported({ kind: 'flag', what: 'the flag --all-namespaces with -f' });
    // The clients are built first; a document needs the server only for its mapping.
    const server = yield* openServer(p, config);
    if (typeof server === 'number') return server;
    const items = yield* visitFiles(p, { filenames, recursive: v.recursive === true }, config.namespace, config.explicitNamespace, { selector: trimmedLabel, server });
    if (!Array.isArray(items)) return yield* fail(p, items);
    // visitByPaths: resource arguments are refused with paths.
    const pathErr = pathArgumentError(inv.args);
    if (pathErr) return yield* fail(p, pathErr);
    if ('session' in server) session = server.session;
    source = { kind: 'files', items };
  } else {
    // Discovery (and with it the connection) maps the types.
    const opened = yield* openSession(p, config);
    if (typeof opened === 'number') return opened;
    session = opened;
    const selecting = deleteAll || trimmedLabel !== '' || trimmedField !== '';
    const plan = buildPlan({
      args: inv.args,
      namespace: config.namespace,
      allNamespaces,
      ...(selecting ? { labelSelector: trimmedLabel } : {}),
      ...(trimmedField !== '' ? { fieldSelector: trimmedField } : {}),
      allowEmptySelector: false,
    });
    if ('type' in plan) return yield* fail(p, plan);
    source = { kind: 'plan', plan };
  }
  // Validate
  const output = str(v.output);
  if (output !== '' && output !== 'name') return yield* fail(p, messageError(`unexpected -o output mode: ${output}. We only support '-o name'`));
  if (deleteAll && labelSelector.length > 0) return yield* fail(p, messageError('cannot set --all and --selector at the same time'));
  if (deleteAll && fieldSelector.length > 0) return yield* fail(p, messageError('cannot set --all and --field-selector at the same time'));
  if (gracePeriod === 0 && force) {
    yield* printWarning(p, 'Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.');
  } else if (gracePeriod > 0 && force) {
    return yield* fail(p, messageError('--force and --grace-period greater than 0 cannot be specified together'));
  }
  // A type whose objects the simulator does not store: notice before anything is deleted.
  const targets =
    source.kind === 'plan'
      ? source.plan.visits.filter((vi) => !(vi.kind === 'list' && vi.fromCategory)).map((vi) => vi.mapping)
      : source.items.flatMap((i) => ('mapping' in i ? [i.mapping] : []));
  for (const m of targets) {
    if (strategyFor(m.group, m.resource)) continue;
    return yield* p.unsupported({ kind: 'resource', what: `the resource type "${m.resource}${m.group ? `.${m.group}` : ''}"` });
  }
  const waitForDeletion = v.wait === true;
  if (waitForDeletion && timeoutNs < 0n && dryRun === 'none') {
    return yield* p.unsupported({ kind: 'flag-value', what: `the flag --timeout with a negative duration` });
  }
  const o: Options = {
    propagation,
    gracePeriod,
    dryRun,
    output,
    ignoreNotFound,
    wait: waitForDeletion,
    timeoutNs,
    warnClusterScope: config.explicitNamespace && !allNamespaces,
  };
  return yield* deleteResult(p, session, source, o);
}

/** What the builder visits: a plan over arguments and selectors, or the objects of -f's files. */
type Source = { kind: 'plan'; plan: Plan } | { kind: 'files'; items: FileItem[] };

/** visitByPaths: the argument errors with -f (after normalizeMultipleResourcesArgs). */
function pathArgumentError(args: readonly string[]): KubectlError | undefined {
  if (args.length === 0) return undefined;
  const combined = args.length >= 2 && splitResourceArgument(args[0] as string).length > 1;
  if (!combined && !args.every((a) => a.includes('/'))) return messageError('when paths, URLs, or stdin is provided as input, you may not specify resource arguments as well');
  return messageError('resource/name arguments cannot be provided when a path is specified');
}

/** The infos of the plan, in visiting order: lists are flattened into their items. */
function* visitPlan(s: Session, plan: Plan, errors: KubectlError[], onInfo: (info: Info) => Op<void>): Op<void> {
  for (const visit of plan.visits) {
    const m = visit.mapping;
    if (visit.kind === 'get') {
      yield* onInfo({ mapping: m, namespace: visit.namespace, name: visit.name, source: '' });
      continue;
    }
    const options: RequestOptions = {};
    if (visit.labelSelector !== '') options.labelSelector = visit.labelSelector;
    if (visit.fieldSelector !== '') options.fieldSelector = visit.fieldSelector;
    const r = yield* request(s, { verb: 'list', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), options });
    if (!r.ok) {
      // A category's type whose objects the simulator does not store holds none (D-066).
      if ('notSimulated' in r) continue;
      errors.push({ type: 'status', status: enhanceListError(r.status, visit) });
      continue;
    }
    for (const item of ((r.object as JsonObject).items as JsonObject[] | undefined) ?? []) {
      const md = isObject(item.metadata) ? item.metadata : {};
      yield* onInfo({ mapping: m, namespace: m.namespaced ? str(md.namespace) : '', name: str(md.name), source: '' });
    }
  }
}

/**
 * The objects of -f's files in order. A namespace mismatch reaches the command's visitor like its
 * own errors; the reader's errors are reported after everything else (FileItem).
 */
function* visitItems(items: FileItem[], errors: KubectlError[], readErrors: KubectlError[], onInfo: (info: Info) => Op<void>): Op<void> {
  for (const item of items) {
    if ('error' in item) {
      (item.stage === 'read' ? readErrors : errors).push(item.error);
      continue;
    }
    yield* onInfo({ mapping: item.mapping, namespace: item.namespace, name: item.name, source: item.source });
  }
}

/** PrintObj */
function printLine(info: Info, o: Options): string {
  const g = info.mapping;
  const kindString = g.group === '' ? g.kind.toLowerCase() : `${g.kind.toLowerCase()}.${g.group}`;
  if (o.output === 'name') return `${kindString}/${info.name}\n`;
  let operation = o.gracePeriod === 0 ? 'force deleted' : 'deleted';
  if (info.mapping.namespaced) operation = `${operation} from ${info.namespace} namespace`;
  if (o.dryRun === 'client') operation = `${operation} (dry run)`;
  else if (o.dryRun === 'server') operation = `${operation} (server dry run)`;
  return `${kindString} "${info.name}" ${operation}\n`;
}

/** AddSourceToErr("deleting", source, err) */
function withSource(status: Status, source: string): Status {
  if (source === '') return status;
  return { ...status, message: `error when deleting "${source}": ${status.message ?? ''}` };
}

function* deleteResult(p: ProcApi, session: Session | undefined, source: Source, o: Options): Op<number> {
  let found = 0;
  let warnClusterScope = o.warnClusterScope;
  const deleted: Info[] = [];
  const uids = new Map<string, string>();
  const errors: KubectlError[] = [];
  const readErrors: KubectlError[] = [];
  const onInfo = function* (info: Info): Op<void> {
    deleted.push(info);
    found++;
    if (warnClusterScope && !info.mapping.namespaced) {
      yield* printWarning(p, 'deleting cluster-scoped resources, not scoped to the provided namespace');
      warnClusterScope = false;
    }
    if (o.dryRun === 'client') {
      yield* p.write(1, printLine(info, o));
      return;
    }
    const options: RequestOptions = { propagationPolicy: o.propagation };
    if (o.gracePeriod >= 0) options.gracePeriodSeconds = o.gracePeriod;
    if (o.dryRun === 'server') options.dryRun = true;
    // Every info of a file has its mapping, which needed the server.
    const s = session as Session;
    const m = info.mapping;
    const r = yield* request(s, { verb: 'delete', group: m.group, version: m.version, resource: m.resource, ...(info.namespace ? { namespace: info.namespace } : {}), name: info.name, options });
    if (!r.ok) {
      if ('notSimulated' in r) {
        errors.push({ type: 'notSimulated', what: r.notSimulated });
        return;
      }
      errors.push({ type: 'status', status: withSource(r.status, info.source) });
      return;
    }
    yield* p.write(1, printLine(info, o));
    const obj = r.object as JsonObject;
    const uid = obj.kind === 'Status' ? str(isObject(obj.details) ? obj.details.uid : '') : str(isObject(obj.metadata) ? obj.metadata.uid : '');
    if (uid !== '') uids.set(locationKey(info), uid);
  };
  if (source.kind === 'plan') yield* visitPlan(session as Session, source.plan, errors, onInfo);
  else yield* visitItems(source.items, errors, readErrors, onInfo);
  // ContinueOnError collects the errors; IgnoreErrors(IsNotFound) filters them afterwards.
  const notSimulated = errors.find((e) => e.type === 'notSimulated');
  if (notSimulated) return yield* fail(p, notSimulated);
  const remaining = errors.filter((e) => !(o.ignoreNotFound && e.type === 'status' && e.status.reason === 'NotFound'));
  const err = continueOnError(remaining, readErrors);
  if (err) return yield* fail(p, err);
  if (found === 0) {
    yield* p.write(1, 'No resources found\n');
    return 0;
  }
  if (!o.wait || o.dryRun !== 'none' || !session) return 0;
  return yield* waitForDeletion(session, deleted, uids, o.timeoutNs === 0n ? WEEK_NS : o.timeoutNs);
}

function locationKey(info: Info): string {
  return `${info.mapping.group}/${info.mapping.resource}/${info.namespace}/${info.name}`;
}

/** Milliseconds of virtual time for a timeout, rounded up so that a positive one never reads as 0. */
function nsToMs(ns: bigint): number {
  return Number((ns + 999_999n) / 1_000_000n);
}

/** RunWaitContext with IsDeleted for each object, under one deadline. */
function* waitForDeletion(s: Session, infos: Info[], uids: Map<string, string>, timeoutNs: bigint): Op<number> {
  const p = s.p;
  const deadline = p.ctx.now + nsToMs(timeoutNs);
  for (const info of infos) {
    const r = yield* isDeleted(s, info, uids.get(locationKey(info)), deadline);
    if (r === 'deleted') continue;
    if (r === 'interrupted') return 1;
    if (r === 'timeout') return yield* fail(p, messageError(`timed out waiting for the condition on ${info.mapping.resource}/${info.name}`));
    return yield* fail(p, r);
  }
  return 0;
}

function* isDeleted(s: Session, info: Info, uid: string | undefined, deadline: number): Op<'deleted' | 'timeout' | 'interrupted' | KubectlError> {
  const p = s.p;
  const m = info.mapping;
  const base = { group: m.group, version: m.version, resource: m.resource, ...(info.namespace ? { namespace: info.namespace } : {}) };
  const got = yield* request(s, { verb: 'get', ...base, name: info.name } as ApiRequest);
  if (!got.ok) {
    if ('notSimulated' in got) return { type: 'notSimulated', what: got.notSimulated };
    if (got.status.reason === 'NotFound') return 'deleted';
    return { type: 'status', status: got.status };
  }
  const uidOf = (o: JsonObject) => str(isObject(o.metadata) ? o.metadata.uid : '');
  if (uid !== undefined && uidOf(got.object as JsonObject) !== uid) return 'deleted';
  // UntilWithSync: list by name, then watch from the list's resourceVersion.
  const fieldSelector = `metadata.name=${info.name}`;
  const list = yield* request(s, { verb: 'list', ...base, options: { fieldSelector } } as ApiRequest);
  if (!list.ok) {
    if ('notSimulated' in list) return { type: 'notSimulated', what: list.notSimulated };
    return { type: 'status', status: list.status };
  }
  const listObj = list.object as JsonObject;
  const items = (listObj.items as JsonObject[] | undefined) ?? [];
  const current = items.find((i) => isObject(i.metadata) && i.metadata.name === info.name);
  if (!current || (uid !== undefined && uidOf(current) !== uid)) return 'deleted';
  const rv = str(isObject(listObj.metadata) ? listObj.metadata.resourceVersion : '');
  const w = openProcessWatch(s, { verb: 'watch', ...base, options: { fieldSelector, resourceVersion: rv } } as ApiRequest);
  if ('notSimulated' in w) return { type: 'notSimulated', what: w.notSimulated };
  if ('status' in w) return { type: 'status', status: w.status };
  p.trap(2, 'interrupt');
  try {
    for (;;) {
      for (const e of takeWatchEvents(s, w.id)) if (e.type === 'DELETED') return 'deleted';
      const left = deadline - p.ctx.now;
      if (left <= 0) return 'timeout';
      try {
        yield* p.wait(w.topic, left);
      } catch (e) {
        if (e instanceof Error && e.name === 'Interrupted') return 'interrupted';
        throw e;
      }
    }
  } finally {
    closeWatch(s, w.id);
    p.trap(2, 'default');
  }
}

export const deleteVerb: Verb = { path: 'delete', flags: FLAGS, run };
