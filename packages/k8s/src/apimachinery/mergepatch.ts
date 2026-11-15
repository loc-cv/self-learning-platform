// JSON merge patch (`application/merge-patch+json`) as the API server applies it.
// upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go (jsonPatcher.applyPatch
// calls gopkg.in/evanphx/json-patch.v4 v4.13.0 MergePatch, which is not in the checkout). The
// semantics are RFC 7386's, in json-patch v4's implementation:
//
// - an object patch merges: a null member deletes the key, an object member merges into an object
//   (or replaces a non-object), any other member replaces;
// - nulls are pruned from the members a patch inserts (`pruneNulls`), recursively, and also from
//   objects inside inserted arrays (RFC 7386 would keep those); a non-object member that replaces
//   an object member is inserted unpruned, as v4's `merge` returns it as is;
// - a top-level array patch replaces the document (pruned as above);
// - a top-level null or scalar patch is rejected: `Invalid JSON Patch` (ErrBadJSONPatch), which
//   the handler returns as a 400 BadRequest. See mergePatchError.
//
// Key order. v4 decodes documents into `map[string]*lazyNode`, where a lazyNode keeps its raw
// bytes until something parses it, and json.Marshal writes Go maps with sorted keys. So the
// result's top level, every object the merge descended into, and every object the patch inserted
// (parsed by pruneNulls) come out with sorted keys; subtrees of the target the patch did not touch
// keep their bytes, so their original order. That matters only where the merged JSON shows
// through: the decode error that quotes the whole merged document, and the order of strict
// decoding's unknown-field warnings. (JS objects put integer-like keys first whatever the
// insertion order, so an untouched subtree with such keys cannot keep Go's byte order.)

import { cloneJson, isObject, type Json, type JsonObject } from './json.ts';
import { compareGoStrings } from './labels.ts';

/** jsonpatch.ErrBadJSONPatch's text. */
export const BAD_JSON_PATCH = 'Invalid JSON Patch';

/**
 * The error MergePatch returns for a patch that parses but is neither an object nor an array
 * (null, a string, a number, a boolean); null for a patch it accepts.
 */
export function mergePatchError(patch: Json): string | null {
  return patch !== null && typeof patch === 'object' ? null : BAD_JSON_PATCH;
}

function sortedObject(o: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(o).sort(compareGoStrings)) out[k] = o[k] as Json;
  return out;
}

/** pruneNulls / pruneDocNulls / pruneAryNulls: objects lose null members and get sorted keys; arrays keep null elements. */
function pruneNulls(v: Json): Json {
  if (Array.isArray(v)) return v.map((x) => (x === null ? null : pruneNulls(x)));
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v).sort(compareGoStrings)) {
      const x = v[k] as Json;
      if (x !== null) out[k] = pruneNulls(x);
    }
    return out;
  }
  return v;
}

/** mergeDocs: the patch's members applied to a copy of the document; sorted keys. */
function mergeDocs(doc: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(doc)) out[k] = cloneJson(doc[k] as Json);
  for (const k of Object.keys(patch)) {
    const v = patch[k] as Json;
    if (v === null) {
      delete out[k];
      continue;
    }
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
    out[k] = cur === undefined || cur === null ? pruneNulls(v) : merge(cur, v);
  }
  return sortedObject(out);
}

/** merge: a member of both the document and the patch. */
function merge(cur: Json, patch: Json): Json {
  if (!isObject(cur)) return pruneNulls(patch);
  if (!isObject(patch)) return cloneJson(patch);
  return mergeDocs(cur, patch);
}

/**
 * MergePatch(target, patch). The inputs are not modified. For a patch mergePatchError rejects,
 * this returns the patch itself (RFC 7386's answer), which the API server never reaches.
 */
export function mergePatch(target: Json, patch: Json): Json {
  if (Array.isArray(patch)) return pruneNulls(patch);
  if (!isObject(patch)) return cloneJson(patch);
  // A target that is not an object is replaced by the pruned patch (doMergePatch's docErr branch).
  if (!isObject(target)) return pruneNulls(patch);
  return mergeDocs(target, patch);
}
