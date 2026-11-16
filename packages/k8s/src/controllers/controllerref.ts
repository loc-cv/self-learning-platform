// ControllerRefManager: a controller claims the objects it should own. It adopts orphans that match
// its selector and releases owned objects that no longer match, by patching their ownerReferences.
//
// upstream: pkg/controller/controller_ref_manager.go (BaseControllerRefManager.ClaimObject,
// PodControllerRefManager, ReplicaSetControllerRefManager, RecheckDeletionTimestamp,
// ownerRefControllerPatch, GenerateDeleteOwnerRefStrategicMergeBytes).
//
// Upstream sends strategic merge patches (ownerReferences merge on uid, finalizers merge as a set,
// metadata.uid as a precondition). The simulator's client sends JSON merge patches, so the patch
// carries the list the strategic merge would produce from the object as read; metadata.uid stays
// in the patch with the same effect (a different UID fails the update as an invalid change).

import { cloneJson, isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { selectorMatches, type Selector } from '../apimachinery/labels.ts';
import type { ApiObject } from '../apiserver/store.ts';
import type { Client } from '../client/client.ts';
import { apiError, getControllerOf, isDeleting, isInvalid, isNotFound, labelsOf, metaOf, nameOf, namespaceOf, plainError, uidOf, type ApiError } from './objects.ts';

export interface ClaimResult {
  claimed: ApiObject[];
  /** utilerrors.NewAggregate of the adopt/release errors. */
  error?: ApiError;
}

/** The parts of a ControllerRefManager every claim needs. */
export interface ControllerRefManager {
  client: Client;
  /** The owner, as the controller read it. */
  controller: ApiObject;
  selector: Selector;
  /** `apps/v1`, `ReplicaSet`: the owner's GroupVersionKind. */
  apiVersion: string;
  kind: string;
  /** `apps/v1/replicasets`: where to re-read the owner before adopting (RecheckDeletionTimestamp). */
  controllerResource: string;
  /** Finalizers added on adoption and removed on release (PodControllerRefManager's finalizers). */
  finalizers?: string[];
}

type Adopter = (obj: ApiObject) => ApiError | undefined;

/**
 * BaseControllerRefManager.ClaimObject: whether `obj` is (now) owned by the controller, adopting
 * or releasing as needed; a NotFound during adopt or release just means "not ours".
 */
function claimObject(m: ControllerRefManager, obj: ApiObject, match: (o: ApiObject) => boolean, adopt: Adopter, release: Adopter): { ok: boolean; error?: ApiError } {
  const ref = getControllerOf(obj);
  if (ref) {
    if (ref.uid !== uidOf(m.controller)) return { ok: false };
    if (match(obj)) return { ok: true };
    // Owned but no longer matching: release, unless the owner is being deleted.
    if (isDeleting(m.controller)) return { ok: false };
    const err = release(obj);
    if (err && !isNotFound(err)) return { ok: false, error: err };
    return { ok: false };
  }
  // An orphan: adopt it if it matches, neither side is being deleted, and it is in our namespace.
  if (isDeleting(m.controller) || !match(obj)) return { ok: false };
  if (isDeleting(obj)) return { ok: false };
  if (namespaceOf(m.controller) !== '' && namespaceOf(m.controller) !== namespaceOf(obj)) return { ok: false };
  const err = adopt(obj);
  if (err) return isNotFound(err) ? { ok: false } : { ok: false, error: err };
  return { ok: true };
}

/**
 * RecheckDeletionTimestamp around a fresh GET of the owner (canAdoptFunc), evaluated once per
 * manager (sync.Once).
 */
function canAdopt(m: ControllerRefManager): () => ApiError | undefined {
  let done = false;
  let result: ApiError | undefined;
  return () => {
    if (done) return result;
    done = true;
    const res = m.client.resource(m.controllerResource).get(namespaceOf(m.controller), nameOf(m.controller));
    const err = apiError(res);
    if (err) {
      result = plainError(`can't recheck DeletionTimestamp: ${err.message}`);
      return result;
    }
    const fresh = (res.ok ? res.object : {}) as ApiObject;
    if (uidOf(fresh) !== uidOf(m.controller)) {
      result = plainError(`can't recheck DeletionTimestamp: original ${m.kind} ${namespaceOf(m.controller)}/${nameOf(m.controller)} is gone: got uid ${uidOf(fresh)}, wanted ${uidOf(m.controller)}`);
      return result;
    }
    const ts = metaOf(fresh).deletionTimestamp;
    // %v of a *metav1.Time: time.Time's String(), `2006-01-02 15:04:05 +0000 UTC` for whole seconds in UTC.
    if (typeof ts === 'string') result = plainError(`${namespaceOf(fresh)}/${nameOf(fresh)} has just been deleted at ${ts.replace('T', ' ').replace(/Z$/, ' +0000 UTC')}`);
    return result;
  };
}

const refsOf = (obj: ApiObject): JsonObject[] => (Array.isArray(metaOf(obj).ownerReferences) ? (metaOf(obj).ownerReferences as Json[]).filter(isObject) : []);
const finalizersOf = (obj: ApiObject): string[] => (Array.isArray(metaOf(obj).finalizers) ? (metaOf(obj).finalizers as Json[]).filter((f): f is string => typeof f === 'string') : []);

/** The merge patch equal in effect to ownerRefControllerPatch: the controller reference merged in on uid. */
export function adoptPatch(m: ControllerRefManager, obj: ApiObject): JsonObject {
  const ref: JsonObject = { apiVersion: m.apiVersion, kind: m.kind, name: nameOf(m.controller), uid: uidOf(m.controller), controller: true, blockOwnerDeletion: true };
  const refs = refsOf(obj).map((r) => cloneJson(r));
  const i = refs.findIndex((r) => r.uid === ref.uid);
  if (i >= 0) refs[i] = { ...refs[i], ...ref };
  else refs.push(ref);
  const metadata: JsonObject = { uid: uidOf(obj), ownerReferences: refs };
  const add = (m.finalizers ?? []).filter((f) => !finalizersOf(obj).includes(f));
  if (add.length > 0) metadata.finalizers = [...finalizersOf(obj), ...add];
  return { metadata };
}

/** The merge patch equal in effect to GenerateDeleteOwnerRefStrategicMergeBytes for the controller. */
export function releasePatch(m: ControllerRefManager, obj: ApiObject): JsonObject {
  const refs = refsOf(obj).filter((r) => r.uid !== uidOf(m.controller));
  const metadata: JsonObject = { uid: uidOf(obj), ownerReferences: refs.length > 0 ? refs.map((r) => cloneJson(r)) : null };
  const fin = m.finalizers ?? [];
  if (fin.length > 0 && finalizersOf(obj).some((f) => fin.includes(f))) {
    const rest = finalizersOf(obj).filter((f) => !fin.includes(f));
    metadata.finalizers = rest.length > 0 ? rest : null;
  }
  return { metadata };
}

function claim(m: ControllerRefManager, resource: string, objKind: string, objs: readonly ApiObject[], match: (o: ApiObject) => boolean): ClaimResult {
  const can = canAdopt(m);
  const patch = (obj: ApiObject, body: JsonObject): ApiError | undefined => apiError(m.client.resource(resource).patch(namespaceOf(obj), nameOf(obj), body));
  const adopt: Adopter = (obj) => {
    const err = can();
    if (err) return plainError(`can't adopt ${objKind} ${namespaceOf(obj)}/${nameOf(obj)} (${uidOf(obj)}): ${err.message}`);
    return patch(obj, adoptPatch(m, obj));
  };
  const release: Adopter = (obj) => {
    const err = patch(obj, releasePatch(m, obj));
    // The object is gone, or its UID changed (the patch's uid no longer matches): nothing to release.
    if (isNotFound(err) || isInvalid(err)) return undefined;
    return err;
  };
  const claimed: ApiObject[] = [];
  const errors: ApiError[] = [];
  for (const obj of objs) {
    const r = claimObject(m, obj, match, adopt, release);
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    if (r.ok) claimed.push(obj);
  }
  return errors.length === 0 ? { claimed } : { claimed, error: aggregate(errors) };
}

/** utilerrors.NewAggregate(...).Error(): one error as is, several as `[a, b]`. */
function aggregate(errors: ApiError[]): ApiError {
  if (errors.length === 1) return errors[0] as ApiError;
  return { ...(errors[0] as ApiError), message: `[${errors.map((e) => e.message).join(', ')}]` };
}

/** PodControllerRefManager.ClaimPods: the Pods (of those given) the controller owns after adopting and releasing. */
export function claimPods(m: ControllerRefManager, pods: readonly ApiObject[], ...filters: ((p: ApiObject) => boolean)[]): ClaimResult {
  return claim(m, 'v1/pods', 'Pod', pods, (p) => selectorMatches(m.selector, labelsOf(p)) && filters.every((f) => f(p)));
}

/** ReplicaSetControllerRefManager.ClaimReplicaSets. */
export function claimReplicaSets(m: ControllerRefManager, sets: readonly ApiObject[]): ClaimResult {
  return claim(m, 'apps/v1/replicasets', 'ReplicaSet', sets, (rs) => selectorMatches(m.selector, labelsOf(rs)));
}
