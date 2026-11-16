// kubectl rollout status: watch each object until its rollout is done, printing the status
// viewer's line for every event, in virtual time; --watch=false prints the current line once.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/rollout/rollout_status.go NewCmdRolloutStatus
//             (flags), Validate ("required resource not specified", "revision must be a positive
//             integer"), Run (a list and watch by metadata.name; the line printed for every Added
//             and Modified event; "object has been deleted"; "No resources found in <ns>
//             namespace." on standard error when nothing was visited)
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollout_status.go StatusViewerFor
//             ("no status viewer has been implemented for <GroupKind>"),
//             DeploymentStatusViewer.Status (every line and error)
//   upstream: staging/src/k8s.io/client-go/tools/watch/until.go UntilWithSync (an informer: Added
//             for the listed object, Modified for each update, no resync), UntilWithoutRetry
//             (wait.ErrorInterrupted(nil) when the context ends), ContextWithOptionalTimeout (a
//             negative timeout logs an error and means none)
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/wait/error.go errInterrupted.Error
//             ("timed out waiting for the condition")
//   upstream: staging/src/k8s.io/kubectl/pkg/util/interrupt/interrupt.go (Ctrl-C: exit 1, nothing
//             printed)

import type { Op, ProcApi } from '@simlab/host';
import type { JsonObject } from '../../../apimachinery/json.ts';
import type { ApiRequest } from '../../../apiserver/types.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { parseGoDuration } from '../../cli/goduration.ts';
import { closeWatch, fail, klogLine, openProcessWatch, request, takeWatchEvents, type Session } from '../../client/session.ts';
import { conditionOf, meta, revisionOf, spec, status, TIMED_OUT_REASON } from './deployment.ts';
import { aggregateOf, buildInfos, configOf, groupKindString, kustomizeNotice, requiredResource, type Info } from './infos.ts';
import { appsKindNotice } from './kinds.ts';

export const STATUS_FLAGS: FlagDef[] = [
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'watch', shorthand: 'w', kind: 'bool', default: true },
  { name: 'revision', kind: 'int64', default: 0 },
  { name: 'timeout', kind: 'duration', default: '0s' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const goQuote = (s: string): string => JSON.stringify(s);

export type StatusResult = { text: string; done: boolean } | { error: KubectlError };

/** DeploymentStatusViewer.Status */
export function deploymentStatus(d: JsonObject, revision: bigint): StatusResult {
  const name = str(meta(d).name);
  if (revision > 0n) {
    const r = revisionOf(d);
    if ('error' in r) return { error: messageError(`cannot get the revision of deployment ${goQuote(name)}: ${r.error}`) };
    if (revision !== r.value) return { error: messageError(`desired revision (${revision}) is different from the running revision (${r.value})`) };
  }
  const st = status(d);
  if (num(meta(d).generation) <= num(st.observedGeneration)) {
    const cond = conditionOf(d, 'Progressing');
    if (cond && cond.reason === TIMED_OUT_REASON) return { error: messageError(`deployment ${goQuote(name)} exceeded its progress deadline`) };
    const replicas = spec(d).replicas;
    const updated = num(st.updatedReplicas);
    if (typeof replicas === 'number' && updated < replicas) {
      return { text: `Waiting for deployment ${goQuote(name)} rollout to finish: ${updated} out of ${replicas} new replicas have been updated...\n`, done: false };
    }
    if (num(st.replicas) > updated) {
      return { text: `Waiting for deployment ${goQuote(name)} rollout to finish: ${num(st.replicas) - updated} old replicas are pending termination...\n`, done: false };
    }
    if (num(st.availableReplicas) < updated) {
      return { text: `Waiting for deployment ${goQuote(name)} rollout to finish: ${num(st.availableReplicas)} of ${updated} updated replicas are available...\n`, done: false };
    }
    return { text: `deployment ${goQuote(name)} successfully rolled out\n`, done: true };
  }
  return { text: 'Waiting for deployment spec update to be observed...\n', done: false };
}

/** Milliseconds of virtual time for a timeout, rounded up so that a positive one never reads as 0. */
function nsToMs(ns: bigint): number {
  return Number((ns + 999_999n) / 1_000_000n);
}

type Until = 'done' | 'interrupted' | KubectlError;

/** UntilWithSync over the object: list by name, then watch from the list's resourceVersion. */
function* untilRolledOut(s: Session, info: Info, revision: bigint, watch: boolean, timeoutMs: number): Op<Until> {
  const p = s.p;
  const m = info.mapping;
  const deadline = timeoutMs > 0 ? p.ctx.now + timeoutMs : undefined;
  const base = { group: m.group, version: m.version, resource: m.resource, ...(info.namespace ? { namespace: info.namespace } : {}) };
  const fieldSelector = `metadata.name=${info.name}`;
  const list = yield* request(s, { verb: 'list', ...base, options: { fieldSelector } } as ApiRequest);
  if (!list.ok) {
    if ('notSimulated' in list) return { type: 'notSimulated', what: list.notSimulated };
    return { type: 'status', status: list.status };
  }
  const listObj = list.object as JsonObject;
  const rv = str(meta(listObj).resourceVersion);
  const w = openProcessWatch(s, { verb: 'watch', ...base, options: { fieldSelector, resourceVersion: rv } } as ApiRequest);
  if ('notSimulated' in w) return { type: 'notSimulated', what: w.notSimulated };
  if ('status' in w) return { type: 'status', status: w.status };
  /** The condition on one event: undefined to keep watching. */
  const condition = function* (obj: JsonObject): Op<Until | undefined> {
    const r = deploymentStatus(obj, revision);
    if ('error' in r) return r.error;
    yield* p.write(1, r.text);
    if (r.done || !watch) return 'done';
    return undefined;
  };
  p.trap(2, 'interrupt');
  try {
    // The informer's initial list: Added for the object, if it is there.
    for (const item of (listObj.items as JsonObject[] | undefined) ?? []) {
      const r = yield* condition(item);
      if (r !== undefined) return r;
    }
    for (;;) {
      for (const e of takeWatchEvents(s, w.id)) {
        if (e.type === 'DELETED') return messageError('object has been deleted');
        if (e.type !== 'ADDED' && e.type !== 'MODIFIED') continue;
        const r = yield* condition(e.object);
        if (r !== undefined) return r;
      }
      const left = deadline === undefined ? undefined : deadline - p.ctx.now;
      if (left !== undefined && left <= 0) return messageError('timed out waiting for the condition');
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

function* negativeTimeout(p: ProcApi): Op<void> {
  // klog.FromContext(parent).Error(nil, "Timeout for context shall not be negative")
  yield* p.write(2, klogLine(p, 'E', 'until.go:159', '"Timeout for context shall not be negative"'));
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const config = yield* configOf(inv);
  if (typeof config === 'number') return config;
  const required = requiredResource(inv);
  if (required) return yield* fail(p, required);
  const revision = BigInt(v.revision as number);
  if (revision < 0n) return yield* fail(p, messageError(`revision must be a positive integer: ${revision}`));
  const k = yield* kustomizeNotice(inv);
  if (k !== undefined) return k;
  const timeout = parseGoDuration(str(v.timeout));
  const timeoutNs = 'ns' in timeout ? timeout.ns : 0n;
  const watch = v.watch !== false;
  const built = yield* buildInfos(inv, config);
  if (typeof built === 'number') return built;
  const errors: KubectlError[] = [];
  let resourceFound = false;
  for (const item of built.visited) {
    if ('error' in item) {
      errors.push(item.error);
      continue;
    }
    resourceFound = true;
    const m = item.info.mapping;
    if (m.kind === 'DaemonSet' || m.kind === 'StatefulSet') return yield* appsKindNotice(p, 'rollout status', m.kind);
    if (m.kind !== 'Deployment' || !(m.group === 'apps' || m.group === 'extensions')) {
      errors.push(messageError(`no status viewer has been implemented for ${groupKindString(m)}`));
      continue;
    }
    if (timeoutNs < 0n) yield* negativeTimeout(p);
    const r = yield* untilRolledOut(built.session as Session, item.info, revision, watch, timeoutNs > 0n ? nsToMs(timeoutNs) : 0);
    if (r === 'interrupted') return 1;
    if (r !== 'done') {
      if (r.type === 'notSimulated') return yield* p.unsupported({ kind: 'behavior', what: r.what });
      errors.push(r);
    }
  }
  const err = aggregateOf(errors);
  if (err) return yield* fail(p, err);
  if (!resourceFound) yield* p.write(2, `No resources found in ${config.namespace} namespace.\n`);
  return 0;
}

export const statusVerb: Verb = {
  path: 'rollout status',
  flags: STATUS_FLAGS,
  partial: { kustomize: 'every value' },
  run,
};
