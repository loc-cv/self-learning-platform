// Strategic merge patch (`application/strategic-merge-patch+json`): applying a patch, as the API
// server does for a PATCH, and computing two- and three-way patches, as kubectl apply does on the
// client. Patch strategies and merge keys come from the vendored Go types (openapi/schema.ts
// FieldSpec patchStrategy, patchMergeKey), the same struct tags upstream reads.
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go
//             StrategicMergePatch, StrategicMergeMapPatch, CreateTwoWayMergePatch,
//             CreateThreeWayMergePatch
//
// These entry points copy their inputs (the port works in place, like upstream) and return the
// document with keys sorted as json.Marshal writes a map.

import { cloneJson, isObject, type Json, type JsonObject } from '../json.ts';
import { compareGoStrings } from '../labels.ts';
import { PatchError, type Sentinel } from './errors.ts';
import { patchMetaFor, type LookupPatchMeta } from './meta.ts';
import { createThreeWayMergeMapPatch, createTwoWayMergeMapPatch, strategicMergeMapPatch } from './patch.ts';

export { PatchError, type Sentinel } from './errors.ts';
export { patchMetaFor, patchMetaFromType, type LookupPatchMeta, type PatchMeta, type TypeResolver } from './meta.ts';

/** `sentinel` names upstream's error variable where the error is one (ErrConflict for a conflict). */
export type PatchResult = { ok: JsonObject } | { error: string; sentinel?: Sentinel };

/** json.Marshal's key order: map keys sorted, at every level. */
export function sortKeysDeep<T extends Json>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => sortKeysDeep(x)) as T;
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v).sort(compareGoStrings)) out[k] = sortKeysDeep(v[k] as Json);
    return out as T;
  }
  return v;
}

function run(f: () => JsonObject): PatchResult {
  try {
    return { ok: sortKeysDeep(f()) };
  } catch (e) {
    if (e instanceof PatchError) return e.sentinel ? { error: e.message, sentinel: e.sentinel } : { error: e.message };
    throw e;
  }
}

/**
 * StrategicMergeMapPatch: `patch` applied to `original`. `typeId` is the schema id of the object's
 * Go type (`schema().kind(apiVersion, kind).id`).
 */
export function strategicMergePatch(original: JsonObject, patch: JsonObject, typeId: string): PatchResult {
  return strategicMergePatchUsing(original, patch, patchMetaFor(typeId));
}

/** StrategicMergePatchUsingLookupPatchMeta. */
export function strategicMergePatchUsing(original: JsonObject, patch: JsonObject, schema: LookupPatchMeta): PatchResult {
  return run(() => strategicMergeMapPatch(cloneJson(original), cloneJson(patch), schema));
}

/**
 * What the API server's smpPatcher does with a patch: the merged object, and the patch as the
 * merge left it (handlers/patch.go prints it in decoding errors). Works on `original` and
 * `patch` in place. The original's lists have no spare capacity, as the server's deep copies of
 * the cached object have none (patch.ts, Go slices).
 */
export function applyStrategicPatchInPlace(original: JsonObject, patch: JsonObject, typeId: string): { ok: JsonObject } | { error: string; sentinel?: Sentinel } {
  try {
    return { ok: strategicMergeMapPatch(original, patch, patchMetaFor(typeId), true) };
  } catch (e) {
    if (e instanceof PatchError) return e.sentinel ? { error: e.message, sentinel: e.sentinel } : { error: e.message };
    throw e;
  }
}

/** CreateTwoWayMergePatch: the patch that turns `original` into `modified`. */
export function createTwoWayMergePatch(original: JsonObject, modified: JsonObject, typeId: string): PatchResult {
  return createTwoWayMergePatchUsing(original, modified, patchMetaFor(typeId));
}

/** CreateTwoWayMergePatchUsingLookupPatchMeta. */
export function createTwoWayMergePatchUsing(original: JsonObject, modified: JsonObject, schema: LookupPatchMeta): PatchResult {
  return run(() => createTwoWayMergeMapPatch(cloneJson(original), cloneJson(modified), schema));
}

/**
 * CreateThreeWayMergePatch: the patch kubectl apply sends. `original` is the last-applied
 * configuration (undefined when the object has none), `modified` the new configuration, `current`
 * the live object; `overwrite` is apply's --overwrite. A conflict (overwrite false) is an error
 * with sentinel `ErrConflict`.
 */
export function createThreeWayMergePatch(original: JsonObject | undefined, modified: JsonObject, current: JsonObject, typeId: string, overwrite: boolean): PatchResult {
  return createThreeWayMergePatchUsing(original, modified, current, patchMetaFor(typeId), overwrite);
}

/** CreateThreeWayMergePatch with any LookupPatchMeta. */
export function createThreeWayMergePatchUsing(original: JsonObject | undefined, modified: JsonObject, current: JsonObject, schema: LookupPatchMeta, overwrite: boolean): PatchResult {
  return run(() => createThreeWayMergeMapPatch(original ? cloneJson(original) : {}, cloneJson(modified), cloneJson(current), schema, overwrite));
}
