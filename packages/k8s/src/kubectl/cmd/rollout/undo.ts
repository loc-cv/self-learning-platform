// kubectl rollout undo: put a Deployment's template back to one of its earlier ReplicaSets' (the
// previous revision, or --to-revision) with a JSON patch; the deployment controller then rolls
// out that template as a new revision.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/rollout/rollout_undo.go NewCmdRolloutUndo (flags),
//             Complete (GetDryRunStrategy first), Validate, RunUndo (the warning for an object with
//             the last-applied annotation, the result as the NamePrinter's operation, with the dry
//             run suffix of PrintFlagsWithDryRunStrategy)
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollback.go RollbackerFor,
//             DeploymentRollbacker.Rollback (every error and result), equalIgnoreHash,
//             annotationsToSkip, getDeploymentPatch (replace /spec/template and
//             /metadata/annotations), deploymentRevision, revisionNotFoundErr
//   upstream: staging/src/k8s.io/kubectl/pkg/apps/kind_visitor.go GroupKindElement.Accept

import type { Op } from '@simlab/host';
import { cloneJson, isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import type { Mapping } from '../../client/restmapper.ts';
import { fail, request, type Session } from '../../client/session.ts';
import { LAST_APPLIED } from '../../util/apply.ts';
import { CHANGE_FORMATS, dryRunStrategy, type DryRun } from '../helpers.ts';
import { allReplicaSets, annotations, equalIgnoreHash, meta, printTemplate, revisionOf, spec } from './deployment.ts';
import { aggregateOf, buildInfos, configOf, groupKindString, kustomizeNotice, requiredResource, type Info } from './infos.ts';
import { typedPrinter } from '../typed.ts';
import { appsKindNotice, visitorAccepts } from './kinds.ts';

export const UNDO_FLAGS: FlagDef[] = [
  { name: 'to-revision', kind: 'int64', default: 0 },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: 'unchanged' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const goQuote = (s: string): string => JSON.stringify(s);

const DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY = 'pod-template-hash';

/** annotationsToSkip */
const ANNOTATIONS_TO_SKIP = [
  LAST_APPLIED,
  'deployment.kubernetes.io/revision',
  'deployment.kubernetes.io/revision-history',
  'deployment.kubernetes.io/desired-replicas',
  'deployment.kubernetes.io/max-replicas',
  'deprecated.deployment.rollback.to',
];

const revisionNotFound = (r: bigint): KubectlError => messageError(`unable to find specified revision ${r} in history`);

/** The error text of a failed request, as %v prints it. */
const statusText = (r: { status: { message?: string } }): string => r.status.message ?? '';

/** deploymentRevision: the ReplicaSet of the revision (0: the one before the latest). */
function* deploymentRevision(s: Session, d: JsonObject, toRevision: bigint): Op<{ rs: JsonObject } | { error: KubectlError }> {
  const all = yield* allReplicaSets(s, d);
  if ('error' in all) return { error: messageError(`failed to retrieve replica sets from deployment ${str(meta(d).name)}: ${all.error}`) };
  const rss = all.newRS ? [...all.allOld, all.newRS] : all.allOld;
  let latestRevision = -1n;
  let latest: JsonObject | undefined;
  let previousRevision = -1n;
  let previous: JsonObject | undefined;
  for (const rs of rss) {
    const r = revisionOf(rs);
    if ('error' in r) continue;
    const v = r.value;
    if (toRevision === 0n) {
      if (latestRevision < v) {
        previousRevision = latestRevision;
        previous = latest;
        latestRevision = v;
        latest = rs;
      } else if (previousRevision < v) {
        previousRevision = v;
        previous = rs;
      }
    } else if (toRevision === v) return { rs };
  }
  if (toRevision > 0n) return { error: revisionNotFound(toRevision) };
  if (!previous) return { error: messageError(`no rollout history found for deployment ${goQuote(str(meta(d).name))}`) };
  return { rs: previous };
}

/** DeploymentRollbacker.Rollback: the result to print, or the error. */
function* rollback(s: Session, info: Info, toRevision: bigint, dryRun: DryRun): Op<string | KubectlError> {
  if (toRevision < 0n) return revisionNotFound(toRevision);
  const got = yield* request(s, { verb: 'get', group: 'apps', version: 'v1', resource: 'deployments', namespace: info.namespace, name: info.name });
  if (!got.ok) {
    if ('notSimulated' in got) return { type: 'notSimulated', what: got.notSimulated };
    return messageError(`failed to retrieve Deployment ${info.name}: ${statusText(got)}`);
  }
  const d = got.object as JsonObject;
  const found = yield* deploymentRevision(s, d, toRevision);
  if ('error' in found) return found.error;
  const rs = found.rs;
  const rsTemplate = spec(rs).template;
  if (dryRun === 'client') return printTemplate(rsTemplate);
  if (spec(d).paused === true) return messageError("you cannot rollback a paused deployment; resume it first with 'kubectl rollout resume' and try again");
  if (equalIgnoreHash(rsTemplate, spec(d).template)) return `skipped rollback (current template already matches revision ${toRevision})`;
  const template: JsonObject = isObject(rsTemplate) ? cloneJson(rsTemplate) : {};
  if (isObject(template.metadata) && isObject(template.metadata.labels)) delete template.metadata.labels[DEFAULT_DEPLOYMENT_UNIQUE_LABEL_KEY];
  const da = annotations(d);
  const merged: Record<string, Json> = {};
  for (const k of ANNOTATIONS_TO_SKIP) if (k in da) merged[k] = da[k] as string;
  for (const [k, v] of Object.entries(annotations(rs))) if (!ANNOTATIONS_TO_SKIP.includes(k)) merged[k] = v;
  const patch: Json = [
    { op: 'replace', path: '/spec/template', value: template },
    { op: 'replace', path: '/metadata/annotations', value: merged },
  ];
  const r = yield* request(s, {
    verb: 'patch',
    group: 'apps',
    version: 'v1',
    resource: 'deployments',
    namespace: info.namespace,
    name: info.name,
    body: patch,
    options: { patchType: 'json', ...(dryRun === 'server' ? { dryRun: true } : {}) },
  });
  if (!r.ok) {
    if ('notSimulated' in r) return { type: 'notSimulated', what: r.notSimulated };
    return messageError(`failed restoring revision ${toRevision}: ${statusText(r)}`);
  }
  return 'rolled back';
}

/** RollbackerFor: whether the kind has a rollbacker, or its error. */
function rollbackerError(m: Mapping): KubectlError | undefined {
  const gk = groupKindString(m);
  if (!visitorAccepts(m)) return messageError(`error retrieving rollbacker for ${goQuote(gk)}, no visitor method exists for {${m.group} ${m.kind}}`);
  if (m.kind === 'Deployment' || m.kind === 'DaemonSet' || m.kind === 'StatefulSet') return undefined;
  return messageError(`no rollbacker has been implemented for ${goQuote(gk)}`);
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const config = yield* configOf(inv);
  if (typeof config === 'number') return config;
  const required = requiredResource(inv);
  if (required) return yield* fail(p, required);
  const k = yield* kustomizeNotice(inv);
  if (k !== undefined) return k;
  const toRevision = BigInt(v['to-revision'] as number);
  const built = yield* buildInfos(inv, config);
  if (typeof built === 'number') return built;
  const errors: KubectlError[] = [];
  for (const item of built.visited) {
    if ('error' in item) {
      errors.push(item.error);
      continue;
    }
    const { info } = item;
    if (LAST_APPLIED in annotations(info.object)) {
      // fmt.Fprintf(o.ErrOut, warningRollbackApplyManagedResource, info.ObjectName(), …): plain text.
      yield* p.write(
        2,
        `Warning: resource ${info.mapping.resource}/${info.name} was previously managed with 'kubectl apply'. Rolling back will not update the ${LAST_APPLIED} annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.\n`,
      );
    }
    const kindErr = rollbackerError(info.mapping);
    if (kindErr) {
      errors.push(kindErr);
      continue;
    }
    if (info.mapping.kind !== 'Deployment') return yield* appsKindNotice(p, 'rollout undo', info.mapping.kind);
    const result = yield* rollback(built.session as Session, info, toRevision, dryRun);
    if (typeof result !== 'string') {
      if (result.type === 'notSimulated') return yield* p.unsupported({ kind: 'behavior', what: result.what });
      errors.push(result);
      continue;
    }
    const printer = typedPrinter(str(v.output), result, dryRun, str(v.template));
    if ('type' in printer) {
      if (printer.type === 'notSimulated') return yield* p.unsupported({ kind: 'output-format', what: printer.what });
      errors.push(printer);
      continue;
    }
    yield* p.write(1, printer.print(info.object));
  }
  const err = aggregateOf(errors);
  return err ? yield* fail(p, err) : 0;
}

export const undoVerb: Verb = {
  path: 'rollout undo',
  flags: UNDO_FLAGS,
  noEffect: {
    'allow-missing-template-keys': 'only matters to template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: { kustomize: 'every value', template: 'every value' },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run,
};
