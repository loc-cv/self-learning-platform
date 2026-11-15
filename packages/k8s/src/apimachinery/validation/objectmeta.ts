// ObjectMeta validation on create and update, label selector and label map validation.
// upstream: staging/src/k8s.io/apimachinery/pkg/api/validation/objectmeta.go
// (ValidateObjectMetaAccessor, validateObjectMetaAccessorWithOptsCommon, ValidateFinalizers,
// ValidateOwnerReferences, ValidateAnnotations, ValidateNoNewFinalizers,
// ValidateObjectMetaAccessorUpdate, ValidateImmutableField) and
// staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/validation/validation.go (ValidateLabels,
// ValidateLabelSelector, ValidateLabelSelectorRequirement).
//
// Go iterates label and annotation maps in random order; this port goes in key order (D-040).

import { forbidden, invalid, required, tooLong, type FieldError, type Path } from '../field.ts';
import { isObject, jsonEqual, type Json, type JsonObject } from '../json.ts';
import { byteLength, isDNS1123Label, isQualifiedName, isValidLabelValue, type NameFn } from './names.ts';

export const FIELD_IMMUTABLE = 'field is immutable';
const TOTAL_ANNOTATION_SIZE_LIMIT = 256 * (1 << 10);

const sortedKeys = (o: JsonObject): string[] => Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const strMap = (v: Json | undefined): Record<string, string> => (isObject(v) ? (v as Record<string, string>) : {});

export function validateNonnegativeField(value: number, path: Path): FieldError[] {
  return value < 0 ? [invalid(path, value, 'must be greater than or equal to 0')] : [];
}

export function validateLabelName(name: string, path: Path): FieldError[] {
  return isQualifiedName(name).map((m) => invalid(path, name, m));
}

export function validateLabels(labels: Record<string, string>, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  for (const k of sortedKeys(labels)) {
    errs.push(...validateLabelName(k, path));
    for (const m of isValidLabelValue(labels[k] as string)) errs.push(invalid(path, labels[k], m));
  }
  return errs;
}

export function validateAnnotations(annotations: Record<string, string>, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  let size = 0;
  for (const k of sortedKeys(annotations)) {
    for (const m of isQualifiedName(k.toLowerCase())) errs.push(invalid(path, k, m));
    size += byteLength(k) + byteLength(annotations[k] as string);
  }
  if (size > TOTAL_ANNOTATION_SIZE_LIMIT) errs.push(tooLong(path, TOTAL_ANNOTATION_SIZE_LIMIT));
  return errs;
}

function validateOwnerReference(ref: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const apiVersion = str(ref.apiVersion);
  const parts = apiVersion.split('/');
  const version = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : undefined;
  if (apiVersion === '') errs.push(required(path.child('apiVersion'), 'must not be empty'));
  else if (version === undefined || version === '') errs.push(invalid(path.child('apiVersion'), apiVersion, 'must be <group>/<version> or <version>'));
  if (str(ref.kind) === '') errs.push(required(path.child('kind'), 'must not be empty'));
  if (str(ref.name) === '') errs.push(required(path.child('name'), 'must not be empty'));
  if (str(ref.uid) === '') errs.push(required(path.child('uid'), 'must not be empty'));
  // BannedOwners: core/v1 Event. GroupVersionKind.String() is "/v1, Kind=Event".
  if (apiVersion === 'v1' && ref.kind === 'Event') errs.push(invalid(path, ref, '/v1, Kind=Event is disallowed from being an owner'));
  return errs;
}

export function validateOwnerReferences(refs: Json | undefined, path: Path): FieldError[] {
  if (!Array.isArray(refs)) return [];
  const errs: FieldError[] = [];
  let first = '';
  refs.forEach((r, i) => {
    if (!isObject(r)) return;
    errs.push(...validateOwnerReference(r, path.index(i)));
    if (r.controller === true) {
      const cur = `${str(r.kind)}/${str(r.name)}`;
      if (first !== '') errs.push(invalid(path, refs, `Only one reference can have Controller set to true. Found "true" in references for ${first} and ${cur}`));
      else first = cur;
    }
  });
  return errs;
}

export function validateFinalizers(finalizers: Json | undefined, path: Path): FieldError[] {
  if (!Array.isArray(finalizers)) return [];
  const errs: FieldError[] = [];
  for (const f of finalizers) for (const m of isQualifiedName(str(f))) errs.push(invalid(path, f, m));
  if (finalizers.includes('orphan') && finalizers.includes('foregroundDeletion')) {
    errs.push(invalid(path, finalizers, 'finalizer orphan and foregroundDeletion cannot be both set'));
  }
  return errs;
}

/** ValidateNamespaceName: a DNS-1123 label. */
export const validateNamespaceName: NameFn = (name, prefix) => isDNS1123Label(prefix && name.length > 1 && name.endsWith('-') ? `${name.slice(0, -2)}a` : name);

/** ValidateObjectMetaAccessor for a create. */
export function validateObjectMeta(meta: JsonObject, namespaced: boolean, nameFn: NameFn, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const generateName = str(meta.generateName);
  if (generateName !== '') for (const m of nameFn(generateName, true)) errs.push(invalid(path.child('generateName'), generateName, m));
  const name = str(meta.name);
  if (name === '') errs.push(required(path.child('name'), 'name or generateName is required'));
  else for (const m of nameFn(name, false)) errs.push(invalid(path.child('name'), name, m));
  return [...errs, ...validateCommon(meta, namespaced, path)];
}

function validateCommon(meta: JsonObject, namespaced: boolean, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const ns = str(meta.namespace);
  if (namespaced) {
    if (ns === '') errs.push(required(path.child('namespace')));
    else for (const m of validateNamespaceName(ns, false)) errs.push(invalid(path.child('namespace'), ns, m));
  } else if (ns !== '') errs.push(forbidden(path.child('namespace'), 'not allowed on this type'));
  errs.push(...validateNonnegativeField(typeof meta.generation === 'number' ? meta.generation : 0, path.child('generation')));
  errs.push(...validateLabels(strMap(meta.labels), path.child('labels')));
  errs.push(...validateAnnotations(strMap(meta.annotations), path.child('annotations')));
  errs.push(...validateOwnerReferences(meta.ownerReferences, path.child('ownerReferences')));
  errs.push(...validateFinalizers(meta.finalizers, path.child('finalizers')));
  return errs;
}

export function validateImmutableField(newVal: Json | undefined, oldVal: Json | undefined, path: Path): FieldError[] {
  return jsonEqual(newVal ?? null, oldVal ?? null) ? [] : [invalid(path, newVal ?? null, FIELD_IMMUTABLE)];
}

/** Go's %#v of a sorted []string, as ValidateNoNewFinalizers prints it. */
function goStringSlice(xs: string[]): string {
  return `[]string{${xs.map((x) => JSON.stringify(x)).join(', ')}}`;
}

/** ValidateObjectMetaAccessorUpdate. */
export function validateObjectMetaUpdate(meta: JsonObject, old: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (old.deletionTimestamp !== undefined && old.deletionTimestamp !== null) {
    const oldF = new Set(Array.isArray(old.finalizers) ? old.finalizers.map(str) : []);
    const extra = [...new Set(Array.isArray(meta.finalizers) ? meta.finalizers.map(str) : [])].filter((f) => !oldF.has(f)).sort();
    if (extra.length > 0) errs.push(forbidden(path.child('finalizers'), `no new finalizers can be added if the object is being deleted, found new finalizers ${goStringSlice(extra)}`));
  }
  const rv = str(meta.resourceVersion);
  if (rv === '') errs.push(invalid(path.child('resourceVersion'), rv, 'must be specified for an update'));
  const gen = typeof meta.generation === 'number' ? meta.generation : 0;
  errs.push(...validateNonnegativeField(gen, path.child('generation')));
  if (gen < (typeof old.generation === 'number' ? old.generation : 0)) errs.push(invalid(path.child('generation'), gen, 'must not be decremented'));
  errs.push(...validateImmutableField(str(meta.name), str(old.name), path.child('name')));
  errs.push(...validateImmutableField(str(meta.namespace), str(old.namespace), path.child('namespace')));
  errs.push(...validateImmutableField(str(meta.uid), str(old.uid), path.child('uid')));
  errs.push(...validateImmutableField(meta.creationTimestamp ?? null, old.creationTimestamp ?? null, path.child('creationTimestamp')));
  errs.push(...validateImmutableField(meta.deletionTimestamp ?? null, old.deletionTimestamp ?? null, path.child('deletionTimestamp')));
  errs.push(...validateImmutableField(meta.deletionGracePeriodSeconds ?? null, old.deletionGracePeriodSeconds ?? null, path.child('deletionGracePeriodSeconds')));
  errs.push(...validateLabels(strMap(meta.labels), path.child('labels')));
  errs.push(...validateAnnotations(strMap(meta.annotations), path.child('annotations')));
  errs.push(...validateOwnerReferences(meta.ownerReferences, path.child('ownerReferences')));
  return errs;
}

export interface LabelSelectorOptions {
  allowInvalidLabelValueInSelector?: boolean;
}

/** ValidateLabelSelector for a metav1.LabelSelector (JSON). */
export function validateLabelSelector(ps: Json | undefined, opts: LabelSelectorOptions, path: Path): FieldError[] {
  if (!isObject(ps)) return [];
  const errs = validateLabels(strMap(ps.matchLabels), path.child('matchLabels'));
  const exprs = Array.isArray(ps.matchExpressions) ? ps.matchExpressions : [];
  exprs.forEach((e, i) => {
    if (!isObject(e)) return;
    const p = path.child('matchExpressions').index(i);
    const values = Array.isArray(e.values) ? e.values.map(str) : [];
    switch (e.operator) {
      case 'In':
      case 'NotIn':
        if (values.length === 0) errs.push(required(p.child('values'), "must be specified when `operator` is 'In' or 'NotIn'"));
        break;
      case 'Exists':
      case 'DoesNotExist':
        if (values.length > 0) errs.push(forbidden(p.child('values'), "may not be specified when `operator` is 'Exists' or 'DoesNotExist'"));
        break;
      default:
        errs.push(invalid(p.child('operator'), str(e.operator), 'not a valid selector operator'));
    }
    errs.push(...validateLabelName(str(e.key), p.child('key')));
    if (!opts.allowInvalidLabelValueInSelector) {
      values.forEach((v, vi) => {
        for (const m of isValidLabelValue(v)) errs.push(invalid(p.child('values').index(vi), v, m));
      });
    }
  });
  return errs;
}
