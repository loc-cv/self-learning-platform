// The API server's handling of a JSON patch (application/json-patch+json) before the patched
// object is decoded: strict decoding of the operations, json-patch v4's DecodePatch and Apply, and
// how their errors become statuses. The decoding of the result and the update that follows are the
// merge patch's (pipeline.ts patch).
//   upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go jsonPatcher.applyJSPatch
//             (with fieldValidation Strict or Warn: kjson.UnmarshalStrict into []jsonPatchOp, its
//             strict errors prefixed "json patch ", its other errors a 400 "error decoding patch: …";
//             DecodePatch errors a 400; more than maxJSONPatchOperations (10000) a 413; Apply errors
//             NewGenericServerResponse(422, …)), jsonPatcher.applyPatchToCurrentObject (the strict
//             errors join the result's: warnings with Warn, an Invalid on `patch` otherwise),
//             rest.go fieldValidation (unset means Warn)
//   upstream: staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go NewGenericServerResponse,
//             NewRequestEntityTooLargeError
//   upstream: vendor/sigs.k8s.io/json UnmarshalStrict (case-sensitive; unknown fields are strict
//             errors `unknown field "[<index>].<name>"`); Go encoding/json UnmarshalTypeError texts

import { genericServerResponse, badRequestError, type Status } from '../apimachinery/errors.ts';
import { isObject, type Json } from '../apimachinery/json.ts';
import { applyJsonPatch, decodeJsonPatch, type JsonPatchOperation } from '../apimachinery/jsonpatch.ts';

const MAX_JSON_PATCH_OPERATIONS = 10000;

/** jsonPatchOp's fields and their Go types (Value is interface{}). */
const OP_FIELDS: Record<string, 'string' | 'any'> = { op: 'string', path: 'string', from: 'string', value: 'any' };

function jsonKind(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v === 'boolean' ? 'bool' : typeof v;
}

/**
 * kjson.UnmarshalStrict(patch, &[]jsonPatchOp): the strict errors (unknown fields, in order), or the
 * decoding error. encoding/json reports the first type error after decoding the rest.
 */
function unmarshalStrict(body: Json): { strict: string[] } | { error: string } {
  if (body === null) return { strict: [] };
  if (!Array.isArray(body)) return { error: `json: cannot unmarshal ${jsonKind(body)} into Go value of type []handlers.jsonPatchOp` };
  const strict: string[] = [];
  let typeError: string | undefined;
  for (const [i, op] of body.entries()) {
    if (op === null) continue;
    if (!isObject(op)) {
      typeError ??= `json: cannot unmarshal ${jsonKind(op)} into Go value of type handlers.jsonPatchOp`;
      continue;
    }
    for (const [k, v] of Object.entries(op)) {
      const t = OP_FIELDS[k];
      if (t === undefined) {
        strict.push(`unknown field ${JSON.stringify(`[${i}].${k}`)}`);
        continue;
      }
      if (t === 'string' && v !== null && typeof v !== 'string') typeError ??= `json: cannot unmarshal ${jsonKind(v)} into Go struct field jsonPatchOp.${k} of type string`;
    }
  }
  return typeError !== undefined ? { error: typeError } : { strict };
}

export type JsonPatched =
  /** The patched document and the strict decoding errors of the operations. */
  | { ok: Json; strict: string[] }
  | { status: Status }
  /** An input that makes json-patch v4 panic: what the server's panic recovery answers is not grounded. */
  | { gap: string };

/** jsonPatcher.applyJSPatch on the current object (as the server encodes it). */
export function applyJsonPatchRequest(current: Json, body: Json, fieldValidation: string): JsonPatched {
  const directive = fieldValidation === '' ? 'Warn' : fieldValidation;
  let strict: string[] = [];
  if (directive === 'Strict' || directive === 'Warn') {
    const r = unmarshalStrict(body);
    if ('error' in r) return { status: badRequestError(`error decoding patch: ${r.error}`) };
    strict = r.strict.map((e) => `json patch ${e}`);
  }
  const decoded = decodeJsonPatch(body);
  if ('error' in decoded) return { status: badRequestError(decoded.error) };
  const ops: JsonPatchOperation[] = decoded.ops;
  if (ops.length > MAX_JSON_PATCH_OPERATIONS) {
    return {
      status: {
        kind: 'Status',
        apiVersion: 'v1',
        metadata: {},
        status: 'Failure',
        message: `Request entity too large: The allowed maximum operations in a JSON patch is ${MAX_JSON_PATCH_OPERATIONS}, got ${ops.length}`,
        reason: 'RequestEntityTooLarge',
        code: 413,
      },
    };
  }
  const r = applyJsonPatch(current, ops);
  if ('panic' in r) return { gap: `a JSON patch that makes the API server panic (${r.panic})` };
  if ('error' in r) return { status: genericServerResponse(422, r.error) };
  return { ok: r.ok, strict };
}
