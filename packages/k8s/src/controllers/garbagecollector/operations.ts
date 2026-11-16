// The garbage collector's API calls. upstream: pkg/controller/garbagecollector/operations.go
// (getObject, deleteObject, patchObject, removeFinalizer) and patch.go (deleteOwnerRefJSONMergePatch,
// unblockOwnerReferencesJSONMergePatch).
//
// Reads come from the store (the GC's live GETs go to the same store). Upstream patches
// ownerReferences with a strategic merge patch and falls back to a JSON merge patch when the
// resource has no strategic merge support; the simulated API server only takes JSON merge patches,
// so the fallback (upstream's own) is what is sent. Its effect is the same; it carries the
// dependent's resourceVersion as a precondition where the strategic patch carried its UID.

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import type { ApiResponse } from '../../apiserver/types.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { SyncCtx } from '../types.ts';
import { finalizers, ownerReferences, referenceString, type ObjectReference, type OwnerReference } from './graph.ts';
import { resourcePath, restMapping } from './resources.ts';

/** An error of a GC operation: an API error, or one of upstream's local errors. */
export interface GcError {
  /** HTTP code of an API error; 0 for local errors. */
  code: number;
  message: string;
}

export const notFound = (e: GcError | undefined): boolean => e?.code === 404;
export const conflict = (e: GcError | undefined): boolean => e?.code === 409;

export function apiError(res: ApiResponse): GcError | undefined {
  if (res.ok) return undefined;
  if ('notSimulated' in res) return { code: 0, message: `[sim] not simulated: ${res.notSimulated}` };
  return { code: res.code, message: res.status.message ?? '' };
}

/** restMappingError.Error(). */
const restMappingError = (id: { apiVersion: string; kind: string }): GcError => ({ code: 0, message: `unable to get REST mapping for ${id.apiVersion}/${id.kind}.` });

/** namespacedOwnerOfClusterScopedObjectErr. */
export const NAMESPACED_OWNER_OF_CLUSTER_SCOPED = 'cluster-scoped objects cannot refer to namespaced owners';

const resourceDefaultNamespace = (namespaced: boolean, ns: string): string | undefined => (namespaced ? ns : undefined);

/**
 * getObject: the live object at the identity's coordinates. A kind the simulator does not store
 * has no objects: NotFound.
 */
export function getObject(c: SyncCtx, id: ObjectReference): { object: ApiObject } | { error: GcError } {
  const m = restMapping(id.apiVersion, id.kind);
  if (!m) return { error: restMappingError(id) };
  const ns = resourceDefaultNamespace(m.namespaced, id.namespace);
  if (m.namespaced && !ns) return { error: { code: 0, message: NAMESPACED_OWNER_OF_CLUSTER_SCOPED } };
  const o = m.stored ? c.get(resourcePath(m.resource), ns, id.name) : undefined;
  return o ? { object: o } : { error: { code: 404, message: `${m.resource.resource} "${id.name}" not found` } };
}

/** deleteObject: delete with a UID (and resourceVersion) precondition and a propagation policy. */
export function deleteObject(c: SyncCtx, id: ObjectReference, resourceVersion: string, ownersAtResourceVersion: OwnerReference[] | undefined, policy: string): GcError | undefined {
  const m = restMapping(id.apiVersion, id.kind);
  if (!m) return restMappingError(id);
  const ns = resourceDefaultNamespace(m.namespaced, id.namespace);
  const preconditions = { uid: id.uid, ...(resourceVersion !== '' ? { resourceVersion } : {}) };
  const err = apiError(c.client.resource(resourcePath(m.resource)).delete(ns, id.name, { preconditions, propagationPolicy: policy }));
  if (conflict(err) && resourceVersion !== '') {
    // Retry without the resourceVersion precondition when only unrelated fields changed.
    const live = getObject(c, id);
    if ('error' in live) {
      if (notFound(live.error)) return live.error;
    } else {
      const lm = live.object.metadata as JsonObject;
      if (lm.uid === id.uid && lm.resourceVersion !== resourceVersion && sameRefs(ownerReferences(live.object), ownersAtResourceVersion ?? [])) {
        return deleteObject(c, id, '', undefined, policy);
      }
    }
  }
  return err;
}

const sameRefs = (a: OwnerReference[], b: OwnerReference[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** patchObject with a JSON merge patch. */
export function patchObject(c: SyncCtx, id: ObjectReference, patch: Json): GcError | undefined {
  const m = restMapping(id.apiVersion, id.kind);
  if (!m) return restMappingError(id);
  return apiError(c.client.resource(resourcePath(m.resource)).patch(resourceDefaultNamespace(m.namespaced, id.namespace), id.name, patch));
}

/** deleteOwnerRefJSONMergePatch: the dependent's references minus those to `ownerUids`. */
export function deleteOwnerRefPatch(c: SyncCtx, id: ObjectReference, ownerUids: string[]): { patch: Json } | { error: GcError } {
  const cur = getObject(c, id);
  if ('error' in cur) return cur;
  const kept = ownerReferences(cur.object).filter((r) => !ownerUids.includes(r.uid));
  // A nil slice marshals as null: the merge patch removes the field.
  return { patch: { metadata: { resourceVersion: (cur.object.metadata as JsonObject).resourceVersion as Json, ownerReferences: kept.length > 0 ? (kept as unknown as Json) : null } } };
}

/** unblockOwnerReferencesJSONMergePatch: every reference with blockOwnerDeletion=false. */
export function unblockOwnerReferencesPatch(c: SyncCtx, id: ObjectReference): { patch: Json } | { error: GcError } {
  const cur = getObject(c, id);
  if ('error' in cur) return cur;
  const refs = ownerReferences(cur.object).map((r) => ({ ...r, blockOwnerDeletion: false }));
  return { patch: { metadata: { resourceVersion: (cur.object.metadata as JsonObject).resourceVersion as Json, ownerReferences: refs.length > 0 ? (refs as unknown as Json) : null } } };
}

/** retry.DefaultBackoff.Steps. */
const UPDATE_MAX_RETRIES = 4;

/** removeFinalizer: patch the finalizer out, retrying on conflict. */
export function removeFinalizer(c: SyncCtx, owner: ObjectReference, target: string): GcError | undefined {
  let last: GcError | undefined;
  for (let i = 0; i < UPDATE_MAX_RETRIES; i++) {
    const cur = getObject(c, owner);
    if ('error' in cur) {
      if (notFound(cur.error)) return undefined;
      return { code: 0, message: `cannot finalize owner ${referenceString(owner)}, because cannot get it: ${cur.error.message}. The garbage collector will retry later` };
    }
    const fs = finalizers(cur.object);
    if (!fs.includes(target)) return undefined;
    const kept = fs.filter((f) => f !== target);
    last = patchObject(c, owner, { metadata: { resourceVersion: (cur.object.metadata as JsonObject).resourceVersion as Json, finalizers: kept.length > 0 ? kept : null } });
    if (!conflict(last)) return last;
  }
  return { code: 0, message: `updateMaxRetries(${UPDATE_MAX_RETRIES}) has reached. The garbage collector will retry later for owner ${referenceString(owner)}` };
}
