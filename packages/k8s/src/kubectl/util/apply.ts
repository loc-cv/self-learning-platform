// The kubectl.kubernetes.io/last-applied-configuration annotation: what kubectl apply (and
// create --save-config) records of the configuration it was given, and reads back as the
// "original" of its three-way merge. The value is the object encoded by UnstructuredJSONScheme
// (json.NewEncoder(w).Encode of the map: keys sorted, compact, a trailing newline), taken with the
// annotation itself removed, so `"annotations":{}` remains when it was the only one.
//   upstream: staging/src/k8s.io/kubectl/pkg/util/apply.go GetOriginalConfiguration,
//             setOriginalConfiguration, GetModifiedConfiguration, updateApplyAnnotation,
//             CreateApplyAnnotation, CreateOrUpdateAnnotation
//   upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/unstructured/helpers.go
//             unstructuredJSONScheme.doEncode; unstructured.go SetAnnotations (nil removes the
//             field, an empty map is kept)
//   fixtures/golden/v1.37.2/apply/created-configured-unchanged.yaml, apply/three-way.yaml

import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { marshalJson } from '../../apimachinery/yaml/jsonprint.ts';

/** corev1.LastAppliedConfigAnnotation */
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** UnstructuredJSONScheme's encoding of an object. */
export function encodeUnstructured(obj: JsonObject): string {
  return `${marshalJson(obj, { sortKeys: true })}\n`;
}

function annotationsOf(obj: JsonObject): Record<string, Json> {
  const md = obj.metadata;
  return isObject(md) && isObject(md.annotations) ? { ...md.annotations } : {};
}

function setAnnotations(obj: JsonObject, annots: Record<string, Json>): void {
  if (!isObject(obj.metadata)) obj.metadata = {};
  (obj.metadata as JsonObject).annotations = annots;
}

/** GetOriginalConfiguration: the annotation's value, or undefined without one. */
export function originalConfiguration(obj: JsonObject): string | undefined {
  const v = annotationsOf(obj)[LAST_APPLIED];
  return typeof v === 'string' ? v : undefined;
}

/**
 * GetModifiedConfiguration: the object's encoding without the annotation (with `annotate`, the
 * encoding of the object carrying that first encoding as its annotation). Leaves the object with
 * the annotation it had, or an empty one: Go sets the original value back unconditionally.
 */
export function modifiedConfiguration(obj: JsonObject, annotate: boolean): string {
  const annots = annotationsOf(obj);
  const original = typeof annots[LAST_APPLIED] === 'string' ? (annots[LAST_APPLIED] as string) : '';
  delete annots[LAST_APPLIED];
  setAnnotations(obj, { ...annots });
  let modified = encodeUnstructured(obj);
  if (annotate) {
    setAnnotations(obj, { ...annots, [LAST_APPLIED]: modified });
    modified = encodeUnstructured(obj);
  }
  setAnnotations(obj, { ...annots, [LAST_APPLIED]: original });
  return modified;
}

/** CreateApplyAnnotation: the annotation set to the object's modified configuration. */
export function createApplyAnnotation(obj: JsonObject): void {
  const modified = modifiedConfiguration(obj, false);
  if (modified.length < 1) return;
  setAnnotations(obj, { ...annotationsOf(obj), [LAST_APPLIED]: modified });
}

/** CreateOrUpdateAnnotation: always with --save-config, else only when the object carries one. */
export function createOrUpdateAnnotation(create: boolean, obj: JsonObject): void {
  if (create) {
    createApplyAnnotation(obj);
    return;
  }
  const original = originalConfiguration(obj);
  if (original === undefined || original.length <= 0) return;
  createApplyAnnotation(obj);
}

/** pruneNullsFromMap: apply drops null fields from what it creates (lists keep their nulls' maps pruned). */
export function pruneNulls(v: Json): void {
  if (Array.isArray(v)) {
    for (const x of v) pruneNulls(x);
    return;
  }
  if (!isObject(v)) return;
  for (const k of Object.keys(v)) {
    if (v[k] === null) delete v[k];
    else pruneNulls(v[k] as Json);
  }
}
