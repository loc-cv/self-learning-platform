// Lease validation.
// upstream: pkg/apis/coordination/validation/validation.go ValidateLease, ValidateLeaseUpdate,
// ValidateLeaseSpec. ValidateCoordinatedLeaseStrategy is unreachable here: the
// CoordinatedLeaderElection feature gate is off in v1.37.2, so the strategy drops
// spec.strategy and spec.preferredHolder before validation (checked against the v1.37.2 oracle:
// a Lease created with strategy "OldestEmulationVersion" and preferredHolder "x" came back
// with `spec: {}`), which also makes the preferredHolder rule unreachable.

import { invalid, newPath, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../../apimachinery/validation/objectmeta.ts';
import { nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';

const metaOf = (o: JsonObject): JsonObject => (isObject(o.metadata) ? o.metadata : {});

export function validateLeaseSpec(spec: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const duration = spec.leaseDurationSeconds;
  if (typeof duration === 'number' && duration <= 0) errs.push(invalid(path.child('leaseDurationSeconds'), duration, 'must be greater than 0'));
  const transitions = spec.leaseTransitions;
  if (typeof transitions === 'number' && transitions < 0) errs.push(invalid(path.child('leaseTransitions'), transitions, 'must be greater than or equal to 0'));
  return errs;
}

export function validateLease(lease: JsonObject): FieldError[] {
  const spec = isObject(lease.spec) ? lease.spec : {};
  return [...validateObjectMeta(metaOf(lease), true, nameIsDNSSubdomain, newPath('metadata')), ...validateLeaseSpec(spec, newPath('spec'))];
}

export function validateLeaseUpdate(lease: JsonObject, old: JsonObject): FieldError[] {
  const spec = isObject(lease.spec) ? lease.spec : {};
  return [...validateObjectMetaUpdate(metaOf(lease), metaOf(old), newPath('metadata')), ...validateLeaseSpec(spec, newPath('spec'))];
}
