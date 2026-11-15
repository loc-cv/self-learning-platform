// The core group's ObjectMeta checks: apimachinery's, plus the finalizer name rule of core
// objects. upstream: pkg/apis/core/validation/validation.go ValidateObjectMeta,
// ValidateObjectMetaUpdate, validateKubeFinalizerName (helper.IsStandardFinalizerName: only
// `kubernetes` is a standard name without a domain).

import { invalid, newPath, type FieldError, type Path } from '../../../apimachinery/field.ts';
import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import type { NameFn } from '../../../apimachinery/validation/names.ts';
import * as generic from '../../../apimachinery/validation/objectmeta.ts';

export function validateKubeFinalizerName(name: string, path: Path): FieldError[] {
  if (name.split('/').length === 1 && name !== 'kubernetes') return [invalid(path, name, 'name is neither a standard finalizer name nor is it fully qualified')];
  return [];
}

function kubeFinalizers(finalizers: Json | undefined, path: Path): FieldError[] {
  if (!Array.isArray(finalizers)) return [];
  return finalizers.flatMap((f, i) => validateKubeFinalizerName(typeof f === 'string' ? f : '', path.child('finalizers').index(i)));
}

export function validateObjectMeta(meta: JsonObject, namespaced: boolean, nameFn: NameFn, path: Path = newPath('metadata')): FieldError[] {
  return [...generic.validateObjectMeta(meta, namespaced, nameFn, path), ...kubeFinalizers(meta.finalizers, path)];
}

export function validateObjectMetaUpdate(meta: JsonObject, old: JsonObject, path: Path = newPath('metadata')): FieldError[] {
  return [...generic.validateObjectMetaUpdate(meta, old, path), ...kubeFinalizers(meta.finalizers, path)];
}
