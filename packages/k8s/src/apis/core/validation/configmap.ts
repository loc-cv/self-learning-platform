// ConfigMap validation.
// upstream: pkg/apis/core/validation/validation.go ValidateConfigMap, ValidateConfigMapUpdate,
// ValidateConfigMapName (NameIsDNSSubdomain). Go iterates the data maps in random order; this
// port goes in key order (D-040).

import { forbidden, invalid, newPath, tooLong, type FieldError } from '../../../apimachinery/field.ts';
import { isObject, jsonEqual, type JsonObject } from '../../../apimachinery/json.ts';
import { byteLength, isConfigMapKey, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';

/** core.MaxSecretSize, the limit of ConfigMap and Secret data (pkg/apis/core/types.go). */
export const MAX_SECRET_SIZE = 1 * 1024 * 1024;

const sorted = (o: JsonObject): string[] => Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function validateConfigMap(cm: JsonObject): FieldError[] {
  const errs = validateObjectMeta(cm.metadata as JsonObject, true, nameIsDNSSubdomain, newPath('metadata'));
  const data = isObject(cm.data) ? cm.data : {};
  const binary = isObject(cm.binaryData) ? cm.binaryData : {};
  let total = 0;
  for (const key of sorted(data)) {
    for (const m of isConfigMapKey(key)) errs.push(invalid(newPath('data').key(key), key, m));
    if (key in binary) errs.push(invalid(newPath('data').key(key), key, 'duplicate of key present in binaryData'));
    total += byteLength(String(data[key]));
  }
  for (const key of sorted(binary)) {
    for (const m of isConfigMapKey(key)) errs.push(invalid(newPath('binaryData').key(key), key, m));
    // The decoded length of the base64 value.
    const b64 = String(binary[key]);
    total += Math.floor((b64.replace(/=+$/, '').length * 3) / 4);
  }
  if (total > MAX_SECRET_SIZE) errs.push(tooLong(newPath(''), MAX_SECRET_SIZE));
  return errs;
}

export function validateConfigMapUpdate(cm: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(cm.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata'));
  if (old.immutable === true) {
    if (cm.immutable !== true) errs.push(forbidden(newPath('immutable'), 'field is immutable when `immutable` is set'));
    if (!jsonEqual(cm.data ?? null, old.data ?? null)) errs.push(forbidden(newPath('data'), 'field is immutable when `immutable` is set'));
    if (!jsonEqual(cm.binaryData ?? null, old.binaryData ?? null)) errs.push(forbidden(newPath('binaryData'), 'field is immutable when `immutable` is set'));
  }
  return [...errs, ...validateConfigMap(cm)];
}
