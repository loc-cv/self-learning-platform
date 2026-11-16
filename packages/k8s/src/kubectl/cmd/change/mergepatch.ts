// JSON merge patch creation (RFC 7386) between two documents, as kubectl label, annotate and edit
// compute it: keys gone become null, changed objects are diffed recursively, anything else that
// differs (arrays included) is replaced whole.
//   upstream: vendor/gopkg.in/evanphx/json-patch.v4/merge.go CreateMergePatch, getDiff

import { isObject, jsonEqual, type JsonObject } from '../../../apimachinery/json.ts';

/** getDiff */
function diff(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, bv] of Object.entries(b)) {
    const av = a[k];
    if (!(k in a)) {
      out[k] = bv;
      continue;
    }
    if (isObject(av) && isObject(bv)) {
      const d = diff(av, bv);
      if (Object.keys(d).length > 0) out[k] = d;
      continue;
    }
    if (!jsonEqual(av, bv)) out[k] = bv;
  }
  for (const k of Object.keys(a)) if (!(k in b)) out[k] = null;
  return out;
}

/** CreateMergePatch for two JSON objects. */
export function createMergePatch(original: JsonObject, modified: JsonObject): JsonObject {
  return diff(original, modified);
}

