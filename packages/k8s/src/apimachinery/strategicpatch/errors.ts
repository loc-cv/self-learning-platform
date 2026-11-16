// The errors strategic merge patch returns, with upstream's texts.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/mergepatch/errors.go (the sentinel errors,
// ErrNoMergeKey, ErrBadArgType, ErrBadPatchType, ErrConflict); the fmt verbs print decoded JSON as
// Go does: %v of a map is `map[k:v …]` with sorted keys, %s of a non-string `%!s(int64=5)`, and a
// value's reflect.Type is `map[string]interface {}`, `[]interface {}`, `string`, `int64` (an
// integer: k8s.io/apimachinery/pkg/util/json and the unstructured converter decode integers to
// int64), `float64` or `bool` (nil's type prints as `%!s(<nil>)`).

import type { Json, JsonObject } from '../json.ts';
import { goSprint, goSprintS } from '../../kubectl/printers/gofmt.ts';

/**
 * The sentinel errors the API server maps to a status code (handlers/patch.go
 * interpretStrategicMergePatchError); other errors are plain (a 500 without a reason).
 */
export type Sentinel =
  | 'ErrBadJSONDoc'
  | 'ErrNoListOfLists'
  | 'ErrBadPatchFormatForPrimitiveList'
  | 'ErrBadPatchFormatForRetainKeys'
  | 'ErrBadPatchFormatForSetElementOrderList'
  | 'ErrPatchContentNotMatchRetainKeys'
  | 'ErrUnsupportedStrategicMergePatchFormat'
  | 'ErrConflict'
  | 'panic';

export class PatchError extends Error {
  readonly sentinel: Sentinel | undefined;
  constructor(message: string, sentinel?: Sentinel) {
    super(message);
    this.sentinel = sentinel;
  }
}

const sentinel = (s: Sentinel, text: string) => (): PatchError => new PatchError(text, s);

export const errBadJSONDoc = sentinel('ErrBadJSONDoc', 'invalid JSON document');
export const errNoListOfLists = sentinel('ErrNoListOfLists', 'lists of lists are not supported');
export const errBadPatchFormatForPrimitiveList = sentinel('ErrBadPatchFormatForPrimitiveList', 'invalid patch format of primitive list');
export const errBadPatchFormatForRetainKeys = sentinel('ErrBadPatchFormatForRetainKeys', 'invalid patch format of retainKeys');
export const errBadPatchFormatForSetElementOrderList = sentinel('ErrBadPatchFormatForSetElementOrderList', 'invalid patch format of setElementOrder list');

/** A nil pointer dereference inside upstream's code (reflect.TypeOf(nil).Kind() in sliceElementType). */
export const errNilDereference = (): PatchError => new PatchError('runtime error: invalid memory address or nil pointer dereference', 'panic');

/** reflect.TypeOf(v).String() of a decoded JSON value, as %s prints it. */
export function goTypeName(v: Json | undefined): string {
  if (v === null || v === undefined) return '%!s(<nil>)';
  if (Array.isArray(v)) return '[]interface {}';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(v) ? 'int64' : 'float64';
    default:
      return 'map[string]interface {}';
  }
}

export const MAP_TYPE = 'map[string]interface {}';
export const SLICE_TYPE = '[]interface {}';

/** mergepatch.ErrNoMergeKey. A failed type assertion passes a nil map, which prints as `map[]`. */
export function errNoMergeKey(m: JsonObject | null, k: string): PatchError {
  return new PatchError(`map: ${m === null ? 'map[]' : goSprint(m)} does not contain declared merge key: ${k}`);
}

/** mergepatch.ErrBadArgType: `expected` is the Go type the code asserted. */
export function errBadArgType(expected: string, actual: Json | undefined): PatchError {
  return new PatchError(`expected a ${expected}, but received a ${goTypeName(actual)}`);
}

/** mergepatch.ErrBadPatchType. */
export function errBadPatchType(t: Json, m: JsonObject): PatchError {
  return new PatchError(`unknown patch type: ${goSprintS(t)} in map: ${goSprint(m)}`);
}

/** mergepatch.NewErrConflict, with the two documents as YAML. */
export function errConflict(patch: string, current: string): PatchError {
  return new PatchError(`patch:\n${patch}\nconflicts with changes made from original to current:\n${current}\n`, 'ErrConflict');
}
