// ServiceAccount. upstream: pkg/registry/core/serviceaccount/strategy.go (namespaced, no status,
// create on update not allowed, unconditional update allowed; cleanSecretReferences keeps only
// the name of each `secrets` reference; a warning for the deprecated
// kubernetes.io/enforce-mountable-secrets annotation, the constant from
// plugin/pkg/admission/serviceaccount/admission.go), pkg/registry/core/serviceaccount/storage/
// storage.go (ReturnDeletedObject). The token subresource is not simulated.

import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import { validateServiceAccount, validateServiceAccountUpdate } from '../../apis/core/validation/serviceaccount.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

const ENFORCE_MOUNTABLE_SECRETS_ANNOTATION = 'kubernetes.io/enforce-mountable-secrets';

/** cleanSecretReferences: each reference becomes ObjectReference{Name}. */
function cleanSecretReferences(sa: JsonObject): void {
  if (!Array.isArray(sa.secrets)) return;
  sa.secrets = sa.secrets.map((ref) => ({ name: isObject(ref) && typeof ref.name === 'string' ? ref.name : '' }));
}

const hasAnnotation = (o: JsonObject | undefined): boolean => {
  const m = o && isObject(o.metadata) ? o.metadata : {};
  return isObject(m.annotations) && ENFORCE_MOUNTABLE_SECRETS_ANNOTATION in m.annotations;
};

/** warnIfHasEnforceMountableSecretsAnnotation. */
function warnings(sa: JsonObject, old: JsonObject | undefined): string[] {
  if (old && hasAnnotation(old)) return [];
  if (!hasAnnotation(sa)) return [];
  return [`metadata.annotations[${ENFORCE_MOUNTABLE_SECRETS_ANNOTATION}]: deprecated in v1.32+; prefer separate namespaces to isolate access to mounted secrets`];
}

export const serviceAccountStrategy: Strategy = {
  group: '',
  resource: 'serviceaccounts',
  kind: 'ServiceAccount',
  storage: 'serviceaccounts',
  storageVersion: 'v1',
  prepareForCreate: (obj) => cleanSecretReferences(obj),
  prepareForUpdate: (obj) => cleanSecretReferences(obj),
  validate: (obj) => validateServiceAccount(obj),
  validateUpdate: (obj, old) => validateServiceAccountUpdate(obj, old),
  warningsOnCreate: (obj) => warnings(obj, undefined),
  warningsOnUpdate: (obj, old) => warnings(obj, old),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  returnDeletedObject: true,
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
};
