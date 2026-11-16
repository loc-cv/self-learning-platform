// The garbage collector's dependency graph, read from the store.
//
// upstream: pkg/controller/garbagecollector/graph.go keeps a node per object seen by its metadata
// informers (uidToNode), with the owners from its ownerReferences and the set of dependents that
// reference its UID. Here the store is the informer cache and always complete, so a node is the
// stored object with that UID, its dependents are the stored objects whose ownerReferences name
// that UID, and a "virtual" node (an owner referenced but never observed) is a UID no stored object
// has. Nothing has to be kept in world data.
//
// Order: upstream iterates the dependents map (Go map, no order); here dependents come in
// discovery order of their resource, then store key order.

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { ApiResource } from '../../discovery/registry.ts';
import type { Reader } from '../types.ts';
import { apiVersionOf, preferredResources, resourcePath } from './resources.ts';

/** metav1.OwnerReference as stored. */
export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

/** graph.go objectReference: an owner reference's coordinates plus the namespace. */
export interface ObjectReference {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  uid: string;
}

/** objectReference.String(). */
export function referenceString(r: ObjectReference): string {
  return `[${r.apiVersion}/${r.kind}, namespace: ${r.namespace}, name: ${r.name}, uid: ${r.uid}]`;
}

export const FINALIZER_ORPHAN_DEPENDENTS = 'orphan';
export const FINALIZER_DELETE_DEPENDENTS = 'foregroundDeletion';

/**
 * The resources the GC monitors: GetDeletableResources (preferred, verbs delete, list and watch)
 * minus ignoredResources (graph_builder.go: core and events.k8s.io events).
 */
let monitored: ApiResource[] | undefined;
export function monitoredResources(): ApiResource[] {
  monitored ??= preferredResources(['delete', 'list', 'watch'], false).filter((r) => r.resource !== 'events' || (r.group !== '' && r.group !== 'events.k8s.io'));
  return monitored;
}

const meta = (o: ApiObject): JsonObject => (o.metadata ?? {}) as JsonObject;
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

export function ownerReferences(o: ApiObject): OwnerReference[] {
  const refs = meta(o).ownerReferences;
  return Array.isArray(refs) ? (refs as unknown as OwnerReference[]) : [];
}

export function finalizers(o: ApiObject): string[] {
  const f = meta(o).finalizers;
  return Array.isArray(f) ? f.map((x) => str(x)) : [];
}

export const uidOf = (o: ApiObject): string => str(meta(o).uid);
export const beingDeleted = (o: ApiObject): boolean => str(meta(o).deletionTimestamp) !== '';
export const hasFinalizer = (o: ApiObject, f: string): boolean => finalizers(o).includes(f);
/** node.isDeletingDependents as the graph builder sets it: deleting, with foregroundDeletion. */
export const deletingDependents = (o: ApiObject): boolean => beingDeleted(o) && hasFinalizer(o, FINALIZER_DELETE_DEPENDENTS);

/** identityFromEvent: the object as the monitor of `r` sees it. */
export function identityOf(r: ApiResource, o: ApiObject): ObjectReference {
  const m = meta(o);
  return { apiVersion: apiVersionOf(r), kind: r.kind, namespace: str(m.namespace), name: str(m.name), uid: str(m.uid) };
}

export interface Node {
  resource: ApiResource;
  object: ApiObject;
  identity: ObjectReference;
}

/** uidToNode.Read: the stored object with this UID. */
export function nodeByUid(read: Reader, uid: string): Node | undefined {
  if (uid === '') return undefined;
  for (const r of monitoredResources()) {
    for (const o of read.list(resourcePath(r))) {
      if (uidOf(o) === uid) return { resource: r, object: o, identity: identityOf(r, o) };
    }
  }
  return undefined;
}

/** node.getDependents: stored objects with an ownerReference to `uid`. */
export function dependentsOf(read: Reader, uid: string): Node[] {
  const out: Node[] = [];
  if (uid === '') return out;
  for (const r of monitoredResources()) {
    for (const o of read.list(resourcePath(r))) {
      if (ownerReferences(o).some((ref) => ref.uid === uid)) out.push({ resource: r, object: o, identity: identityOf(r, o) });
    }
  }
  return out;
}

/** node.blockingDependents: dependents whose reference to `uid` has blockOwnerDeletion=true. */
export function blockingDependents(read: Reader, uid: string): Node[] {
  return dependentsOf(read, uid).filter((d) => ownerReferences(d.object).some((ref) => ref.uid === uid && ref.blockOwnerDeletion === true));
}

/** ownerReferenceMatchesCoordinates. */
export function matchesCoordinates(ref: OwnerReference, id: ObjectReference): boolean {
  return ref.uid === id.uid && ref.name === id.name && ref.kind === id.kind && ref.apiVersion === id.apiVersion;
}

/** The virtual node addDependentToOwners creates for an owner not in the graph. */
export function virtualOwner(ref: OwnerReference, dependentNamespace: string): ObjectReference {
  return { apiVersion: ref.apiVersion, kind: ref.kind, namespace: dependentNamespace, name: ref.name, uid: ref.uid };
}

// ---- queue keys ----
// The two work queues of upstream (attemptToDelete, attemptToOrphan) share the controller's one
// queue, told apart by the key's first word; the node is carried as its identity, JSON-encoded
// because ownerReference names are not validated as path segments.

export type GcQueue = 'attemptToDelete' | 'attemptToOrphan' | 'ownerRefInvalidNamespace';

export function gcKey(queue: GcQueue, id: ObjectReference, extra?: string): string {
  const parts = [id.apiVersion, id.kind, id.namespace, id.name, id.uid, ...(extra !== undefined ? [extra] : [])];
  return `${queue} ${JSON.stringify(parts)}`;
}

export function parseGcKey(key: string): { queue: GcQueue; id: ObjectReference; extra?: string } | undefined {
  const sp = key.indexOf(' ');
  if (sp < 0) return undefined;
  const queue = key.slice(0, sp) as GcQueue;
  let parts: unknown;
  try {
    parts = JSON.parse(key.slice(sp + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length < 5 || !parts.every((p) => typeof p === 'string')) return undefined;
  const [apiVersion, kind, namespace, name, uid, extra] = parts as string[];
  return { queue, id: { apiVersion: apiVersion as string, kind: kind as string, namespace: namespace as string, name: name as string, uid: uid as string }, ...(extra !== undefined ? { extra } : {}) };
}
