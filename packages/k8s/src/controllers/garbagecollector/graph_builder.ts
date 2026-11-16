// The graph builder's event handling: which nodes a change of one object puts on the work queues.
//
// upstream: pkg/controller/garbagecollector/graph_builder.go processGraphChanges, with
// addDependentToOwners, addUnblockedOwnersToDeleteQueue, processTransitions and referencesDiffs.
// The graph itself is the store (graph.ts), so "insert", "update owners" and "remove" have nothing
// to write; what remains is what each case enqueues.
//
// Not ported: the replacement of a virtual node by the observed one (processGraphChanges, the
// `found && !existingNode.isObserved()` branch). It exists because informers of different
// resources fill in any order; here an owner is either stored or not when its dependent is seen,
// and addDependentToOwners below checks a stored owner's coordinates and namespace directly, which
// is the same check from the dependent's side. The absentOwnerCache is not needed either: every
// lookup reads the store.

import { jsonEqual, type Json } from '../../apimachinery/json.ts';
import type { ApiResource } from '../../discovery/registry.ts';
import type { ControllerEvent, Reader } from '../types.ts';
import {
  beingDeleted,
  dependentsOf,
  deletingDependents,
  FINALIZER_DELETE_DEPENDENTS,
  FINALIZER_ORPHAN_DEPENDENTS,
  gcKey,
  hasFinalizer,
  identityOf,
  matchesCoordinates,
  nodeByUid,
  ownerReferences,
  virtualOwner,
  type ObjectReference,
  type OwnerReference,
} from './graph.ts';
import type { ApiObject } from '../../apiserver/store.ts';

/** processGraphChanges for one watch event of the monitor of `r`. */
export function graphChangeKeys(r: ApiResource, ev: ControllerEvent, read: Reader): string[] {
  const obj = ev.object;
  const id = identityOf(r, obj);
  const keys: string[] = [];
  if (ev.type === 'ADDED') {
    // !found: insertNode, then processTransitions (the add may already be a deletion).
    keys.push(...addDependentToOwners(id, ownerReferences(obj), read));
    keys.push(...processTransitions(undefined, obj, id, read));
  } else if (ev.type === 'MODIFIED') {
    const { added, removed, changed } = referencesDiffs(ownerReferences(ev.old ?? obj), ownerReferences(obj));
    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      keys.push(...addUnblockedOwnersToDeleteQueue(removed, changed, read));
      keys.push(...addDependentToOwners(id, added, read));
    }
    keys.push(...processTransitions(ev.old, obj, id, read));
  } else {
    // deleteEvent: removeNode; its dependents may now be dangling, and owners waiting for their
    // dependents may now be free.
    for (const dep of dependentsOf(read, id.uid)) keys.push(gcKey('attemptToDelete', dep.identity));
    for (const ref of ownerReferences(obj)) {
      const owner = nodeByUid(read, ref.uid);
      if (owner && deletingDependents(owner.object)) keys.push(gcKey('attemptToDelete', owner.identity));
    }
  }
  return keys;
}

/**
 * addDependentToOwners: an owner not in the graph becomes a virtual node queued for
 * attemptToDelete (which asks the API server whether it exists); a stored owner whose namespace or
 * coordinates disagree with the reference queues the dependent, and a namespace mismatch is
 * reported with an OwnerRefInvalidNamespace event (reportInvalidNamespaceOwnerRef).
 */
function addDependentToOwners(id: ObjectReference, owners: OwnerReference[], read: Reader): string[] {
  const keys: string[] = [];
  let potentiallyInvalid = false;
  for (const ref of owners) {
    const owner = nodeByUid(read, ref.uid);
    if (!owner) {
      keys.push(gcKey('attemptToDelete', virtualOwner(ref, id.namespace)));
      continue;
    }
    if (potentiallyInvalid) continue;
    const ownerNamespaced = owner.identity.namespace !== '';
    if (ownerNamespaced && owner.identity.namespace !== id.namespace) {
      // The report key records the event, then queues the dependent.
      keys.push(gcKey('ownerRefInvalidNamespace', id, ref.uid));
      potentiallyInvalid = true;
    } else if (!matchesCoordinates(ref, owner.identity)) {
      potentiallyInvalid = true;
    }
  }
  if (potentiallyInvalid) keys.push(gcKey('attemptToDelete', id));
  return keys;
}

/** addUnblockedOwnersToDeleteQueue: a blocking reference removed or unblocked frees its owner. */
function addUnblockedOwnersToDeleteQueue(removed: OwnerReference[], changed: { oldRef: OwnerReference; newRef: OwnerReference }[], read: Reader): string[] {
  const keys: string[] = [];
  for (const ref of removed) {
    if (ref.blockOwnerDeletion !== true) continue;
    const owner = nodeByUid(read, ref.uid);
    if (owner) keys.push(gcKey('attemptToDelete', owner.identity));
  }
  for (const c of changed) {
    if (c.oldRef.blockOwnerDeletion === true && c.newRef.blockOwnerDeletion !== true) {
      const owner = nodeByUid(read, c.newRef.uid);
      if (owner) keys.push(gcKey('attemptToDelete', owner.identity));
    }
  }
  return keys;
}

/** deletionStartsWithFinalizer. */
function deletionStartsWithFinalizer(old: ApiObject | undefined, obj: ApiObject, finalizer: string): boolean {
  if (!beingDeleted(obj) || !hasFinalizer(obj, finalizer)) return false;
  if (!old) return true;
  return !beingDeleted(old) || !hasFinalizer(old, finalizer);
}

/**
 * processTransitions: an object that starts waiting for its dependents to be orphaned goes to
 * attemptToOrphan; one that starts waiting for them to be deleted queues every dependent, then
 * itself.
 */
function processTransitions(old: ApiObject | undefined, obj: ApiObject, id: ObjectReference, read: Reader): string[] {
  if (deletionStartsWithFinalizer(old, obj, FINALIZER_ORPHAN_DEPENDENTS)) return [gcKey('attemptToOrphan', id)];
  if (deletionStartsWithFinalizer(old, obj, FINALIZER_DELETE_DEPENDENTS)) {
    return [...dependentsOf(read, id.uid).map((d) => gcKey('attemptToDelete', d.identity)), gcKey('attemptToDelete', id)];
  }
  return [];
}

/**
 * referencesDiffs. `removed` comes from a Go set in upstream (no order); here in the old list's
 * order.
 */
function referencesDiffs(old: OwnerReference[], now: OwnerReference[]): { added: OwnerReference[]; removed: OwnerReference[]; changed: { oldRef: OwnerReference; newRef: OwnerReference }[] } {
  const added: OwnerReference[] = [];
  const changed: { oldRef: OwnerReference; newRef: OwnerReference }[] = [];
  const remaining = new Map(old.map((r) => [r.uid, r]));
  for (const ref of now) {
    const prev = remaining.get(ref.uid);
    if (prev) {
      if (!jsonEqual(prev as unknown as Json, ref as unknown as Json)) changed.push({ oldRef: prev, newRef: ref });
      remaining.delete(ref.uid);
    } else added.push(ref);
  }
  return { added, removed: [...remaining.values()], changed };
}
