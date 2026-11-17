// Deleting the content of a terminating namespace, then finalizing it.
// upstream: pkg/controller/namespace/deletion/namespaced_resources_deleter.go (Delete,
// retryOnConflictError, updateNamespaceStatusFunc, finalized, finalizeNamespace,
// deleteAllContent, deleteAllContentForGroupVersionResource, deleteEachItem,
// estimateGracefulTermination, estimateGracefulTerminationForPods).
//
// Differences, all without a visible effect on objects:
// - upstream deletes each resource with one DELETE of the collection (deletecollection) and falls
//   back to listing and deleting each item (deleteEachItem) when the resource does not support it.
//   The simulated API server has no deletecollection verb yet, so the fallback is always taken:
//   the same objects are deleted, with the same propagation (Background), one request each.
// - Lists and the live GET of the namespace read the store, which is what the API server would
//   answer.
// - Discovery cannot fail (static registry): the discovery and group version conditions are
//   always their ok variants.
// - upstream walks the resources of a Go map (no order); here discovery order. Condition messages
//   are sorted by upstream, so the order shows nowhere but in the trace.

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { parseTime } from '../../apimachinery/time.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { ApiResponse } from '../../apiserver/types.ts';
import type { ApiResource } from '../../discovery/registry.ts';
import type { SyncCtx, SyncResult } from '../types.ts';
import { preferredResources, resourcePath } from '../garbagecollector/resources.ts';
import { newConditionUpdater, processContentTotals, processDeleteContentErr, updateConditions, type ConditionUpdater, type ContentTotals } from './conditions.ts';

/** v1.FinalizerKubernetes: the finalizer token of the namespace controller. */
export const FINALIZER_KUBERNETES = 'kubernetes';

/** finalizerEstimateSeconds: the wait when content with finalizers remains. */
const FINALIZER_ESTIMATE_SECONDS = 15;

const meta = (o: ApiObject): JsonObject => (o.metadata ?? {}) as JsonObject;
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

interface ApiErr {
  code: number;
  message: string;
}

function apiErr(res: ApiResponse): ApiErr | undefined {
  if (res.ok) return undefined;
  if ('notSimulated' in res) return { code: 0, message: `[sim] not simulated: ${res.notSimulated}` };
  return { code: res.code, message: res.status.message ?? '' };
}

/** Delete: the namespace controller's sync of one namespace. */
export function deleteNamespace(c: SyncCtx, name: string): SyncResult {
  const ns = c.get('v1/namespaces', undefined, name);
  if (!ns) return { done: true };
  if (str(meta(ns).deletionTimestamp) === '') return { done: true };
  const updated = retryOnConflictError(c, ns, updateNamespaceStatusFunc);
  if ('error' in updated) return updated.error.code === 404 ? { done: true } : { error: updated.error.message };
  const namespace = updated.ok;
  if (str(meta(namespace).deletionTimestamp) === '') return { done: true };
  if (finalized(namespace)) return { done: true };
  const r = deleteAllContent(c, namespace);
  if (r.errors.length > 0) return { error: aggregate(r.errors) };
  if (r.estimate > 0) {
    // ResourcesRemainingError: the worker requeues after estimate/2 + 1 seconds.
    c.trace('namespace.content-remaining', `some content remains in the namespace, estimate ${r.estimate} seconds before it is removed`, { namespace: name, estimate: r.estimate, remaining: r.remaining }, name);
    return { requeueAfter: (Math.floor(r.estimate / 2) + 1) * 1000 };
  }
  const fin = retryOnConflictError(c, namespace, finalizeNamespace);
  if ('error' in fin && fin.error.code !== 404) return { error: fin.error.message };
  if (!('error' in fin)) c.trace('namespace.finalized', `namespace ${name} is empty: its kubernetes finalizer is removed`, { namespace: name }, name);
  return { done: true };
}

/** utilerrors.NewAggregate(errs).Error(). */
function aggregate(errs: string[]): string {
  return errs.length === 1 ? (errs[0] as string) : `[${errs.join(', ')}]`;
}

type UpdateFn = (c: SyncCtx, ns: ApiObject) => { ok: ApiObject } | { error: ApiErr };

/**
 * retryOnConflictError: on Conflict, get the latest namespace and call again. Upstream loops
 * until no conflict; a sync here is one instant, so a second conflict cannot come from another
 * writer and the loop is bounded.
 */
function retryOnConflictError(c: SyncCtx, ns: ApiObject, fn: UpdateFn): { ok: ApiObject } | { error: ApiErr } {
  let latest = ns;
  for (let i = 0; i < 10; i++) {
    const r = fn(c, latest);
    if ('ok' in r || r.error.code !== 409) return r;
    const prevUid = str(meta(latest).uid);
    const got = c.client.resource('v1/namespaces').get(undefined, str(meta(latest).name));
    if (!got.ok) return { error: apiErr(got) as ApiErr };
    latest = got.object as ApiObject;
    if (str(meta(latest).uid) !== prevUid) return { error: { code: 0, message: 'namespace uid has changed across retries' } };
  }
  return { error: { code: 409, message: 'namespace kept conflicting' } };
}

/** updateNamespaceStatusFunc: phase Terminating, unless it is already (the API server sets it on delete). */
function updateNamespaceStatusFunc(c: SyncCtx, ns: ApiObject): { ok: ApiObject } | { error: ApiErr } {
  const status = (ns.status ?? {}) as JsonObject;
  if (str(meta(ns).deletionTimestamp) === '' || status.phase === 'Terminating') return { ok: ns };
  const next = { ...ns, status: { ...status, phase: 'Terminating' } };
  const res = c.client.resource('v1/namespaces').updateStatus(undefined, next);
  return res.ok ? { ok: res.object as ApiObject } : { error: apiErr(res) as ApiErr };
}

function finalized(ns: ApiObject): boolean {
  const spec = (ns.spec ?? {}) as JsonObject;
  return !Array.isArray(spec.finalizers) || spec.finalizers.length === 0;
}

/** finalizeNamespace: PUT namespaces/<name>/finalize without the controller's token (sorted set). */
function finalizeNamespace(c: SyncCtx, ns: ApiObject): { ok: ApiObject } | { error: ApiErr } {
  const spec = (ns.spec ?? {}) as JsonObject;
  const rest = [...new Set((Array.isArray(spec.finalizers) ? spec.finalizers : []).map((f) => str(f)).filter((f) => f !== FINALIZER_KUBERNETES))].sort();
  const body: JsonObject = { apiVersion: 'v1', kind: 'Namespace', metadata: meta(ns), spec: { ...spec, finalizers: rest } };
  const res = c.client.request({ verb: 'update', group: '', version: 'v1', resource: 'namespaces', subresource: 'finalize', name: str(meta(ns).name), body });
  return res.ok ? { ok: res.object as ApiObject } : { error: apiErr(res) as ApiErr };
}

interface GvrDeletionMetadata {
  finalizerEstimateSeconds: number;
  numRemaining: number;
  finalizersToNumRemaining: Map<string, number>;
  error?: string;
}

const isPods = (r: ApiResource): boolean => r.group === '' && r.version === 'v1' && r.resource === 'pods';

/** deleteAllContent: every namespaced resource that supports delete, Pods first. */
function deleteAllContent(c: SyncCtx, ns: ApiObject): { estimate: number; errors: string[]; remaining: Record<string, number> } {
  const namespace = str(meta(ns).name);
  const deletedAt = timeMs(str(meta(ns).deletionTimestamp));
  const errors: string[] = [];
  const u = newConditionUpdater(c.now);
  let estimate = 0;
  const resources = preferredResources(['delete'], true);
  const totals: ContentTotals = { gvrToNumRemaining: new Map(), finalizersToNumRemaining: new Map() };
  const add = (r: ApiResource, md: GvrDeletionMetadata): void => {
    if (md.finalizerEstimateSeconds > estimate) estimate = md.finalizerEstimateSeconds;
    if (md.numRemaining > 0) {
      totals.gvrToNumRemaining.set(`${r.resource}.${r.group}`, md.numRemaining);
      for (const [f, n] of md.finalizersToNumRemaining) if (n !== 0) totals.finalizersToNumRemaining.set(f, (totals.finalizersToNumRemaining.get(f) ?? 0) + n);
    }
  };
  const pods = resources.find(isPods);
  if (pods) {
    const md = deleteAllContentForGroupVersionResource(c, pods, namespace, deletedAt);
    if (md.error !== undefined) {
      errors.push(`failed to delete pods for namespace: ${namespace}, err: ${md.error}`);
      processDeleteContentErr(u, md.error);
    }
    add(pods, md);
    if ((totals.gvrToNumRemaining.get('pods.') ?? 0) > 0) {
      // Pods still remain: other resources wait (their controllers would recreate Pods otherwise).
      updateStatus(c, ns, u);
      return { estimate, errors, remaining: Object.fromEntries(totals.gvrToNumRemaining) };
    }
  }
  for (const r of resources) {
    if (isPods(r)) continue;
    const md = deleteAllContentForGroupVersionResource(c, r, namespace, deletedAt);
    if (md.error !== undefined) {
      errors.push(md.error);
      processDeleteContentErr(u, md.error);
    }
    add(r, md);
  }
  processContentTotals(u, totals);
  updateStatus(c, ns, u);
  return { estimate, errors, remaining: Object.fromEntries([...totals.gvrToNumRemaining].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

/** The conditions update; an error is only logged upstream (HandleError). */
function updateStatus(c: SyncCtx, ns: ApiObject, u: ConditionUpdater): void {
  const status = updateConditions(u, (ns.status ?? {}) as JsonObject);
  if (!status) return;
  // The namespace as read at the start of the sync: its resourceVersion goes stale here, so the
  // finalize that follows conflicts once and is retried, as upstream's does.
  c.client.resource('v1/namespaces').updateStatus(undefined, { ...ns, status });
}

function timeMs(t: string): number {
  const r = parseTime(t, false);
  return 'micros' in r ? r.micros / 1000 : 0;
}

/** deleteAllContentForGroupVersionResource. */
function deleteAllContentForGroupVersionResource(c: SyncCtx, r: ApiResource, namespace: string, deletedAt: number): GvrDeletionMetadata {
  const estimate = estimateGracefulTermination(c, r, namespace, deletedAt);
  const none = new Map<string, number>();
  const err = deleteEachItem(c, r, namespace);
  if (err !== undefined) return { finalizerEstimateSeconds: estimate, numRemaining: 0, finalizersToNumRemaining: none, error: err };
  const items = c.list(resourcePath(r), namespace);
  if (items.length === 0) return { finalizerEstimateSeconds: 0, numRemaining: 0, finalizersToNumRemaining: none };
  const finalizers = new Map<string, number>();
  for (const item of items) {
    const fs = meta(item).finalizers;
    for (const f of Array.isArray(fs) ? fs : []) finalizers.set(str(f), (finalizers.get(str(f)) ?? 0) + 1);
  }
  if (estimate !== 0) return { finalizerEstimateSeconds: estimate, numRemaining: items.length, finalizersToNumRemaining: finalizers };
  if (finalizers.size > 0) return { finalizerEstimateSeconds: FINALIZER_ESTIMATE_SECONDS, numRemaining: items.length, finalizersToNumRemaining: finalizers };
  // gvr printed with %v: GroupVersionResource.String().
  return {
    finalizerEstimateSeconds: estimate,
    numRemaining: items.length,
    finalizersToNumRemaining: none,
    error: `unexpected items still remain in namespace: ${namespace} for gvr: ${r.group}/${r.version}, Resource=${r.resource}`,
  };
}

/** deleteEachItem: list, then delete each item with Background propagation. */
function deleteEachItem(c: SyncCtx, r: ApiResource, namespace: string): string | undefined {
  for (const item of c.list(resourcePath(r), namespace)) {
    const res = c.client.resource(resourcePath(r)).delete(namespace, str(meta(item).name), { propagationPolicy: 'Background' });
    const err = apiErr(res);
    if (err && err.code !== 404 && err.code !== 405) return err.message;
  }
  return undefined;
}

/**
 * estimateGracefulTermination: for Pods, the longest terminationGracePeriodSeconds of the Pods
 * not finished, unless that long has passed since the namespace's deletion.
 */
function estimateGracefulTermination(c: SyncCtx, r: ApiResource, namespace: string, deletedAt: number): number {
  if (!isPods(r)) return 0;
  let estimate = 0;
  for (const pod of c.list('v1/pods', namespace)) {
    const phase = str(((pod.status ?? {}) as JsonObject).phase);
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const grace = ((pod.spec ?? {}) as JsonObject).terminationGracePeriodSeconds;
    if (typeof grace === 'number' && grace > estimate) estimate = grace;
  }
  if (c.now - deletedAt >= estimate * 1000) return 0;
  return estimate;
}
