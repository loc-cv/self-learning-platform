// ServiceAccount validation.
// upstream: pkg/apis/core/validation/validation.go ValidateServiceAccount,
// ValidateServiceAccountUpdate, ValidateServiceAccountName
// (staging/src/k8s.io/apimachinery/pkg/api/validation/generic.go: NameIsDNSSubdomain). The
// secrets and imagePullSecrets references are not validated by the API server.

import { newPath, type FieldError } from '../../../apimachinery/field.ts';
import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import { nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';

const metaOf = (o: JsonObject): JsonObject => (isObject(o.metadata) ? o.metadata : {});

export function validateServiceAccount(sa: JsonObject): FieldError[] {
  return validateObjectMeta(metaOf(sa), true, nameIsDNSSubdomain, newPath('metadata'));
}

export function validateServiceAccountUpdate(sa: JsonObject, old: JsonObject): FieldError[] {
  return [...validateObjectMetaUpdate(metaOf(sa), metaOf(old), newPath('metadata')), ...validateServiceAccount(sa)];
}
