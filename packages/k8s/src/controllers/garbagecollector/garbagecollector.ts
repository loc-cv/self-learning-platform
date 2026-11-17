// The garbage collector's workers. upstream: pkg/controller/garbagecollector/garbagecollector.go
// attemptToDeleteWorker, attemptToDeleteItem, isDangling, classifyReferences,
// processDeletingDependentsItem, attemptToOrphanWorker, orphanDependents; graph_builder.go
// reportInvalidNamespaceOwnerRef and the virtual delete event of processGraphChanges.

import type { JsonObject } from '../../apimachinery/json.ts';
import type { SyncCtx, SyncResult } from '../types.ts';
import {
  beingDeleted,
  blockingDependents,
  deletingDependents,
  dependentsOf,
  FINALIZER_DELETE_DEPENDENTS,
  FINALIZER_ORPHAN_DEPENDENTS,
  gcKey,
  hasFinalizer,
  nodeByUid,
  ownerReferences,
  parseGcKey,
  referenceString,
  uidOf,
  type ObjectReference,
  type OwnerReference,
} from './graph.ts';
import {
  deleteObject,
  deleteOwnerRefPatch,
  getObject,
  NAMESPACED_OWNER_OF_CLUSTER_SCOPED,
  notFound,
  patchObject,
  removeFinalizer,
  unblockOwnerReferencesPatch,
  type GcError,
} from './operations.ts';
import { restMapping } from './resources.ts';

/** What attemptToDeleteItem returns besides success. */
type Outcome = { ok: true } | { virtualDelete: true } | { forget: true } | { error: GcError };

const OK: Outcome = { ok: true };

export function syncGarbageCollector(c: SyncCtx, key: string): SyncResult {
  const k = parseGcKey(key);
  if (!k) return { done: true };
  switch (k.queue) {
    case 'attemptToDelete':
      return attemptToDeleteWorker(c, k.id);
    case 'attemptToOrphan':
      return attemptToOrphanWorker(c, k.id);
    case 'ownerRefInvalidNamespace':
      reportInvalidNamespaceOwnerRef(c, k.id, k.extra ?? '');
      c.enqueueAfter(gcKey('attemptToDelete', k.id), 0);
      return { done: true };
  }
}

/** attemptToDeleteWorker: forget on success, a virtual delete, or an error that will not resolve. */
function attemptToDeleteWorker(c: SyncCtx, id: ObjectReference): SyncResult {
  const r = attemptToDeleteItem(c, id);
  if ('virtualDelete' in r) {
    enqueueVirtualDeleteEvent(c, id);
    return { done: true };
  }
  if ('error' in r) return { error: r.error.message };
  return { done: true };
}

/**
 * The virtual delete event processGraphChanges handles for a node the API server does not have:
 * the dependents that reference it are queued. Upstream queues only those whose reference matches
 * the deleted coordinates (partitionDependents) and retries the others under their alternate
 * coordinates; queuing all of them ends the same, since each dependent's attemptToDelete looks up
 * every one of its own references.
 */
function enqueueVirtualDeleteEvent(c: SyncCtx, id: ObjectReference): void {
  c.trace('gc.virtual-delete', `virtual delete event for ${referenceString(id)}`, { apiVersion: id.apiVersion, kind: id.kind, namespace: id.namespace, name: id.name, uid: id.uid }, referenceString(id));
  for (const dep of dependentsOf(c, id.uid)) c.enqueueAfter(gcKey('attemptToDelete', dep.identity), 0);
}

/**
 * attemptToDeleteItem: looks up the live object and issues a delete if its UID matches, it is not
 * waiting for its own dependents, and all its owners are dangling.
 */
function attemptToDeleteItem(c: SyncCtx, id: ObjectReference): Outcome {
  // "being deleted" is a one-way trip to the final deletion (node state, read before the GET).
  const node = nodeByUid(c, id.uid);
  if (node && beingDeleted(node.object) && !deletingDependents(node.object)) return OK;
  const got = getObject(c, id);
  if ('error' in got) {
    if (notFound(got.error)) return { virtualDelete: true };
    if (got.error.message === NAMESPACED_OWNER_OF_CLUSTER_SCOPED) return { forget: true };
    return { error: got.error };
  }
  const latest = got.object;
  if (uidOf(latest) !== id.uid) return { virtualDelete: true };
  if (deletingDependents(latest)) return processDeletingDependentsItem(c, id);
  const refs = ownerReferences(latest);
  if (refs.length === 0) return OK;
  const classified = classifyReferences(c, id, refs);
  if ('error' in classified) {
    if (classified.error.message === NAMESPACED_OWNER_OF_CLUSTER_SCOPED) return { forget: true };
    return classified;
  }
  const { solid, dangling, waiting } = classified;
  c.trace('gc.classify', `classify ${referenceString(id)}: solid ${solid.length}, dangling ${dangling.length}, waitingForDependentsDeletion ${waiting.length}`, {
    kind: id.kind,
    namespace: id.namespace,
    name: id.name,
    uid: id.uid,
    solid: solid.map((r) => r.uid),
    dangling: dangling.map((r) => r.uid),
    waitingForDependentsDeletion: waiting.map((r) => r.uid),
  });
  const rv = String((latest.metadata as JsonObject).resourceVersion ?? '');
  if (solid.length > 0) {
    if (dangling.length === 0 && waiting.length === 0) return OK;
    // Remove the dangling and waiting references: otherwise the waiting owners would be stuck with
    // foregroundDeletion forever.
    const p = deleteOwnerRefPatch(c, id, [...dangling, ...waiting].map((r) => r.uid));
    if ('error' in p) return { error: p.error };
    const err = patchObject(c, id, p.patch);
    return err ? { error: err } : OK;
  }
  if (waiting.length > 0 && dependentsOf(c, id.uid).length > 0) {
    for (const dep of dependentsOf(c, id.uid)) {
      if (deletingDependents(dep.object)) {
        // Cycle prevention: make this item's references non-blocking, then delete it in Foreground.
        const p = unblockOwnerReferencesPatch(c, id);
        if ('error' in p) return { error: p.error };
        const err = patchObject(c, id, p.patch);
        if (err) return { error: err };
        break;
      }
    }
    // Deleted in Foreground: processDeletingDependentsItem finishes it once its own dependents go.
    traceDelete(c, id, dangling, waiting, 'Foreground');
    const err = deleteObject(c, id, rv, refs, 'Foreground');
    if (notFound(err)) return { virtualDelete: true };
    return err ? { error: err } : OK;
  }
  // No solid owner and none waiting for its dependents: delete, honoring a GC finalizer already set.
  const policy = hasFinalizer(latest, FINALIZER_ORPHAN_DEPENDENTS) ? 'Orphan' : hasFinalizer(latest, FINALIZER_DELETE_DEPENDENTS) ? 'Foreground' : 'Background';
  traceDelete(c, id, dangling, waiting, policy);
  const err = deleteObject(c, id, rv, refs, policy);
  if (notFound(err)) return { virtualDelete: true };
  return err ? { error: err } : OK;
}

/**
 * `gc.delete`: the collector deletes an object because none of its owners is left (dangling) or
 * the remaining ones wait for their dependents to go (foreground deletion). The delete request
 * that follows is its `controller.write` record.
 */
function traceDelete(c: SyncCtx, id: ObjectReference, dangling: OwnerReference[], waiting: OwnerReference[], policy: string): void {
  const owners = [...dangling.map((r) => ({ kind: r.kind, name: r.name, uid: r.uid, gone: true })), ...waiting.map((r) => ({ kind: r.kind, name: r.name, uid: r.uid, gone: false }))];
  c.trace(
    'gc.delete',
    `deleting ${referenceString(id)}: ${owners.map((o) => `${o.kind} ${o.name} ${o.gone ? 'is gone' : 'waits for its dependents'}`).join(', ')} (propagation ${policy})`,
    { apiVersion: id.apiVersion, kind: id.kind, namespace: id.namespace, name: id.name, uid: id.uid, owners, policy },
    referenceString(id),
  );
}

/**
 * isDangling: the owner does not exist at the reference's coordinates (in the dependent's
 * namespace when the owner kind is namespaced), or exists with another UID.
 */
function isDangling(c: SyncCtx, ref: OwnerReference, item: ObjectReference): { dangling: true } | { dangling: false; owner: JsonObject } | { error: GcError } {
  const m = restMapping(ref.apiVersion, ref.kind);
  if (!m) return { error: { code: 0, message: `unable to get REST mapping for ${ref.apiVersion}/${ref.kind}.` } };
  if (item.namespace === '' && m.namespaced) return { error: { code: 0, message: NAMESPACED_OWNER_OF_CLUSTER_SCOPED } };
  const got = getObject(c, { apiVersion: ref.apiVersion, kind: ref.kind, namespace: item.namespace, name: ref.name, uid: ref.uid });
  if ('error' in got) return notFound(got.error) ? { dangling: true } : { error: got.error };
  if (uidOf(got.object) !== ref.uid) return { dangling: true };
  return { dangling: false, owner: got.object };
}

/** classifyReferences: solid, dangling, and waiting for its dependents' deletion. */
function classifyReferences(c: SyncCtx, item: ObjectReference, refs: OwnerReference[]): { solid: OwnerReference[]; dangling: OwnerReference[]; waiting: OwnerReference[] } | { error: GcError } {
  const solid: OwnerReference[] = [];
  const dangling: OwnerReference[] = [];
  const waiting: OwnerReference[] = [];
  for (const ref of refs) {
    const d = isDangling(c, ref, item);
    if ('error' in d) return d;
    if (d.dangling) dangling.push(ref);
    else if (beingDeleted(d.owner) && hasFinalizer(d.owner, FINALIZER_DELETE_DEPENDENTS)) waiting.push(ref);
    else solid.push(ref);
  }
  return { solid, dangling, waiting };
}

/**
 * processDeletingDependentsItem: with no blocking dependent left, remove foregroundDeletion;
 * otherwise queue the blocking dependents that are not themselves waiting.
 */
function processDeletingDependentsItem(c: SyncCtx, id: ObjectReference): Outcome {
  const blocking = blockingDependents(c, id.uid);
  if (blocking.length === 0) {
    const err = removeFinalizer(c, id, FINALIZER_DELETE_DEPENDENTS);
    return err ? { error: err } : OK;
  }
  for (const dep of blocking) {
    if (!deletingDependents(dep.object)) c.enqueueAfter(gcKey('attemptToDelete', dep.identity), 0);
  }
  return OK;
}

/**
 * attemptToOrphanWorker: remove the owner from its dependents' ownerReferences, then the orphan
 * finalizer from the owner. Upstream patches the dependents concurrently; here in order.
 */
function attemptToOrphanWorker(c: SyncCtx, owner: ObjectReference): SyncResult {
  const errors: string[] = [];
  for (const dep of dependentsOf(c, owner.uid)) {
    const p = deleteOwnerRefPatch(c, dep.identity, [owner.uid]);
    const err = 'error' in p ? p.error : patchObject(c, dep.identity, p.patch);
    if (err && !notFound(err)) errors.push(`orphaning ${referenceString(dep.identity)} failed, ${err.message}`);
  }
  if (errors.length > 0) {
    // utilerrors.NewAggregate(...).Error(): one message, or a bracketed list.
    const agg = errors.length === 1 ? (errors[0] as string) : `[${errors.join(', ')}]`;
    return { error: `orphanDependents for ${referenceString(owner)} failed with failed to orphan dependents of owner ${referenceString(owner)}, got errors: ${agg}` };
  }
  const err = removeFinalizer(c, owner, FINALIZER_ORPHAN_DEPENDENTS);
  if (err) return { error: `removeOrphanFinalizer for ${referenceString(owner)} failed with ${err.message}` };
  return { done: true };
}

/** reportInvalidNamespaceOwnerRef: a Warning event on the dependent. */
function reportInvalidNamespaceOwnerRef(c: SyncCtx, dep: ObjectReference, invalidOwnerUid: string): void {
  const node = nodeByUid(c, dep.uid);
  if (!node) return;
  const ref = ownerReferences(node.object).find((r) => r.uid === invalidOwnerUid);
  if (!ref) return;
  const invalid: ObjectReference = { apiVersion: ref.apiVersion, kind: ref.kind, namespace: dep.namespace, name: ref.name, uid: ref.uid };
  // v1.ObjectReference{Kind, APIVersion, Namespace, Name, UID}: no resourceVersion.
  const involved = { apiVersion: dep.apiVersion, kind: dep.kind, metadata: { ...(dep.namespace ? { namespace: dep.namespace } : {}), name: dep.name, uid: dep.uid } };
  c.event(involved, 'Warning', 'OwnerRefInvalidNamespace', `ownerRef ${referenceString(invalid)} does not exist in namespace ${JSON.stringify(dep.namespace)}`);
}
