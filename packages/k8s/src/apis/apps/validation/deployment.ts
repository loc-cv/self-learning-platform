// Deployment validation.
// upstream: pkg/apis/apps/validation/validation.go ValidateDeployment, ValidateDeploymentUpdate,
// ValidateDeploymentSpec, ValidateDeploymentStrategy, ValidateRollingUpdateDeployment,
// ValidatePositiveIntOrPercent, getPercentValue, getIntOrPercentValue, IsNotMoreThan100Percent,
// ValidateRollback, ValidateDeploymentStatus, ValidateDeploymentStatusUpdate; IsDecremented from
// pkg/apis/core/validation/validation.go.

import { forbidden, invalid, newPath, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { goJson, isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { isValidPercent, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateNonnegativeField } from '../../../apimachinery/validation/objectmeta.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../core/validation/objectmeta.ts';
import type { PodValidationOptions } from '../../core/validation/options.ts';
import { immutableSelector, validateSelectorAndTemplate } from './replicaset.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);

/** An IntOrString as the internal type holds it: a nil pointer converts to the int 0. */
type IntOrString = number | string;
const intOrString = (v: Json | undefined): IntOrString => (typeof v === 'string' ? v : num(v));

/** ValidatePositiveIntOrPercent. */
function validatePositiveIntOrPercent(v: IntOrString, path: Path): FieldError[] {
  if (typeof v === 'string') return isValidPercent(v).map((m) => invalid(path, v, m));
  return validateNonnegativeField(v, path);
}

/** getPercentValue: the number of a valid percent string. */
function percentValue(v: IntOrString): number | undefined {
  if (typeof v !== 'string' || isValidPercent(v).length > 0) return undefined;
  return Number(v.slice(0, -1));
}

/** getIntOrPercentValue: IntValue() of a non-percent string is strconv.Atoi's, 0 on error. */
function intOrPercentValue(v: IntOrString): number {
  const p = percentValue(v);
  if (p !== undefined) return p;
  if (typeof v === 'number') return v;
  return /^[+-]?[0-9]+$/.test(v) ? Number(v) : 0;
}

function validateRollingUpdateDeployment(ru: JsonObject, path: Path): FieldError[] {
  const maxUnavailable = intOrString(ru.maxUnavailable);
  const maxSurge = intOrString(ru.maxSurge);
  const errs = validatePositiveIntOrPercent(maxUnavailable, path.child('maxUnavailable'));
  errs.push(...validatePositiveIntOrPercent(maxSurge, path.child('maxSurge')));
  if (intOrPercentValue(maxUnavailable) === 0 && intOrPercentValue(maxSurge) === 0) errs.push(invalid(path.child('maxUnavailable'), maxUnavailable, 'may not be 0 when `maxSurge` is 0'));
  const p = percentValue(maxUnavailable);
  if (p !== undefined && p > 100) errs.push(invalid(path.child('maxUnavailable'), maxUnavailable, 'must not be greater than 100%'));
  return errs;
}

/** json.Marshal(*apps.DeploymentStrategy): Go field names (internal type), IntOrStrings as JSON. */
function strategyValue(s: JsonObject): { go: string } {
  const ru = obj(s.rollingUpdate);
  const out = {
    Type: typeof s.type === 'string' ? s.type : '',
    RollingUpdate: ru ? { MaxUnavailable: intOrString(ru.maxUnavailable), MaxSurge: intOrString(ru.maxSurge) } : null,
  };
  return { go: goJson(out) };
}

function validateDeploymentStrategy(s: JsonObject, path: Path): FieldError[] {
  switch (s.type) {
    case 'Recreate':
      return isObject(s.rollingUpdate) ? [forbidden(path.child('rollingUpdate'), "may not be specified when strategy `type` is 'Recreate'")] : [];
    case 'RollingUpdate': {
      const ru = obj(s.rollingUpdate);
      if (!ru) return [required(path.child('rollingUpdate'), 'this should be defaulted and never be nil')];
      return validateRollingUpdateDeployment(ru, path.child('rollingUpdate'));
    }
    default:
      return [notSupported(path, strategyValue(s), ['Recreate', 'RollingUpdate'])];
  }
}

/** ValidateDeploymentSpec. */
function validateDeploymentSpec(spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs = validateNonnegativeField(num(spec.replicas), path.child('replicas'));
  errs.push(...validateSelectorAndTemplate(spec, path, opts));
  errs.push(...validateDeploymentStrategy(obj(spec.strategy) ?? {}, path.child('strategy')));
  const minReady = num(spec.minReadySeconds);
  errs.push(...validateNonnegativeField(minReady, path.child('minReadySeconds')));
  if (typeof spec.revisionHistoryLimit === 'number') errs.push(...validateNonnegativeField(spec.revisionHistoryLimit, path.child('revisionHistoryLimit')));
  const rollbackTo = obj(spec.rollbackTo);
  if (rollbackTo) errs.push(...validateNonnegativeField(num(rollbackTo.revision), path.child('rollback').child('version')));
  if (typeof spec.progressDeadlineSeconds === 'number') {
    const pds = spec.progressDeadlineSeconds;
    errs.push(...validateNonnegativeField(pds, path.child('progressDeadlineSeconds')));
    if (pds <= minReady) errs.push(invalid(path.child('progressDeadlineSeconds'), pds, 'must be greater than minReadySeconds'));
  }
  return errs;
}

/** ValidateDeployment. */
export function validateDeployment(d: JsonObject, opts: PodValidationOptions): FieldError[] {
  const errs = validateObjectMeta(obj(d.metadata) ?? {}, true, nameIsDNSSubdomain, newPath('metadata'));
  errs.push(...validateDeploymentSpec(obj(d.spec) ?? {}, newPath('spec'), opts));
  return errs;
}

/** ValidateDeploymentUpdate. */
export function validateDeploymentUpdate(d: JsonObject, old: JsonObject, opts: PodValidationOptions): FieldError[] {
  const errs = validateObjectMetaUpdate(obj(d.metadata) ?? {}, obj(old.metadata) ?? {}, newPath('metadata'));
  errs.push(...validateDeploymentSpec(obj(d.spec) ?? {}, newPath('spec'), opts));
  errs.push(...immutableSelector(obj(d.spec)?.selector, obj(old.spec)?.selector));
  return errs;
}

/** ValidateDeploymentStatus. */
function validateDeploymentStatus(status: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  for (const f of ['observedGeneration', 'replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas', 'unavailableReplicas']) errs.push(...validateNonnegativeField(num(status[f]), path.child(f)));
  if (typeof status.terminatingReplicas === 'number') errs.push(...validateNonnegativeField(status.terminatingReplicas, path.child('terminatingReplicas')));
  if (typeof status.collisionCount === 'number') errs.push(...validateNonnegativeField(status.collisionCount, path.child('collisionCount')));
  const msg = 'cannot be greater than status.replicas';
  const replicas = num(status.replicas);
  if (num(status.updatedReplicas) > replicas) errs.push(invalid(path.child('updatedReplicas'), num(status.updatedReplicas), msg));
  if (num(status.readyReplicas) > replicas) errs.push(invalid(path.child('readyReplicas'), num(status.readyReplicas), msg));
  if (num(status.availableReplicas) > replicas) errs.push(invalid(path.child('availableReplicas'), num(status.availableReplicas), msg));
  if (num(status.availableReplicas) > num(status.readyReplicas)) errs.push(invalid(path.child('availableReplicas'), num(status.availableReplicas), 'cannot be greater than readyReplicas'));
  return errs;
}

/** ValidateDeploymentStatusUpdate. */
export function validateDeploymentStatusUpdate(d: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(obj(d.metadata) ?? {}, obj(old.metadata) ?? {}, newPath('metadata'));
  const path = newPath('status');
  const status = obj(d.status) ?? {};
  errs.push(...validateDeploymentStatus(status, path));
  // IsDecremented: an old count that goes away or down.
  const cc = status.collisionCount;
  const oldCC = obj(old.status)?.collisionCount;
  if (typeof oldCC === 'number' && (typeof cc !== 'number' || cc < oldCC)) errs.push(invalid(path.child('collisionCount'), typeof cc === 'number' ? cc : 0, 'cannot be decremented'));
  return errs;
}
