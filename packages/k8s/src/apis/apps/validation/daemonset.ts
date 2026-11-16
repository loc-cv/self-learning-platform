// DaemonSet validation.
// upstream: pkg/apis/apps/validation/validation.go ValidateDaemonSet, ValidateDaemonSetUpdate,
// ValidateDaemonSetSpecUpdate, validateDaemonSetStatus, ValidateDaemonSetStatusUpdate,
// ValidateDaemonSetSpec, ValidateRollingUpdateDaemonSet, ValidateDaemonSetUpdateStrategy,
// IsNotMoreThan100Percent; IsDecremented from pkg/apis/core/validation/validation.go.
//
// The internal DaemonSetSpec has TemplateGeneration, which apps/v1 carries in the annotation
// `deprecated.daemonset.template.generation` (pkg/apis/apps/v1/conversion.go); the callers pass it
// in. The internal ObjectMeta lacks that annotation, so the annotation size limit counts its few
// bytes here and not upstream.

import { forbidden, invalid, newPath, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { goJson, isObject, jsonEqual, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { labelSelectorAsSelector, selectorMatches } from '../../../apimachinery/labels.ts';
import { nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateImmutableField, validateLabelSelector, validateNonnegativeField } from '../../../apimachinery/validation/objectmeta.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../core/validation/objectmeta.ts';
import type { PodValidationOptions } from '../../core/validation/options.ts';
import { validatePodTemplateSpec } from '../../core/validation/pod.ts';
import { intOrPercentValue, intOrString, percentValue, validatePositiveIntOrPercent, type IntOrString } from './deployment.ts';
import { selectorValue } from './replicaset.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);
const strMap = (v: Json | undefined): Record<string, string> => (isObject(v) ? (v as Record<string, string>) : {});

/** IsNotMoreThan100Percent. */
function notMoreThan100Percent(v: IntOrString, path: Path): FieldError[] {
  const p = percentValue(v);
  return p === undefined || p <= 100 ? [] : [invalid(path, v, 'must not be greater than 100%')];
}

/** ValidateRollingUpdateDaemonSet. */
function validateRollingUpdateDaemonSet(ru: JsonObject, path: Path): FieldError[] {
  const maxUnavailable = intOrString(ru.maxUnavailable);
  const maxSurge = intOrString(ru.maxSurge);
  const errs = validatePositiveIntOrPercent(maxUnavailable, path.child('maxUnavailable'));
  errs.push(...validatePositiveIntOrPercent(maxSurge, path.child('maxSurge')));
  errs.push(...notMoreThan100Percent(maxUnavailable, path.child('maxUnavailable')));
  errs.push(...notMoreThan100Percent(maxSurge, path.child('maxSurge')));
  const hasUnavailable = intOrPercentValue(maxUnavailable) !== 0;
  const hasSurge = intOrPercentValue(maxSurge) !== 0;
  if (hasUnavailable && hasSurge) errs.push(invalid(path.child('maxSurge'), maxSurge, 'may not be set when maxUnavailable is non-zero'));
  else if (!hasUnavailable && !hasSurge) errs.push(required(path.child('maxUnavailable'), 'cannot be 0 when maxSurge is 0'));
  return errs;
}

/** json.Marshal(*apps.DaemonSetUpdateStrategy): Go field names (internal type), IntOrStrings as JSON. */
function strategyValue(s: JsonObject): { go: string } {
  const ru = obj(s.rollingUpdate);
  const out = {
    Type: typeof s.type === 'string' ? s.type : '',
    RollingUpdate: ru ? { MaxUnavailable: intOrString(ru.maxUnavailable), MaxSurge: intOrString(ru.maxSurge) } : null,
  };
  return { go: goJson(out) };
}

/** ValidateDaemonSetUpdateStrategy. */
function validateDaemonSetUpdateStrategy(s: JsonObject, path: Path): FieldError[] {
  switch (s.type) {
    case 'OnDelete':
      return [];
    case 'RollingUpdate': {
      const ru = obj(s.rollingUpdate);
      if (!ru) return [required(path.child('rollingUpdate'), '')];
      return validateRollingUpdateDaemonSet(ru, path.child('rollingUpdate'));
    }
    default:
      return [notSupported(path, strategyValue(s), ['RollingUpdate', 'OnDelete'])];
  }
}

/** ValidateDaemonSetSpec. `templateGeneration` is the internal Spec.TemplateGeneration. */
function validateDaemonSetSpec(spec: JsonObject, templateGeneration: number, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  const sel = spec.selector;
  errs.push(...validateLabelSelector(sel ?? undefined, {}, path.child('selector')));
  const template = obj(spec.template) ?? {};
  const labels = obj(obj(template.metadata)?.labels);
  // Unlike ReplicaSets, no Empty() check: a missing selector is labels.Nothing() and matches nothing.
  const selector = labelSelectorAsSelector(sel ?? undefined);
  if (!('error' in selector) && !selectorMatches(selector, strMap(labels))) {
    errs.push(invalid(path.child('template', 'metadata', 'labels'), labels ?? null, '`selector` does not match template `labels`'));
  }
  const s = obj(sel);
  if (s && Object.keys(strMap(s.matchLabels)).length + (Array.isArray(s.matchExpressions) ? s.matchExpressions.length : 0) === 0) {
    errs.push(invalid(path.child('selector'), selectorValue(sel), 'empty selector is invalid for daemonset'));
  }
  errs.push(...validatePodTemplateSpec(template, path.child('template'), opts));
  const podSpec = obj(template.spec) ?? {};
  const restartPolicy = typeof podSpec.restartPolicy === 'string' ? podSpec.restartPolicy : '';
  if (restartPolicy !== 'Always') errs.push(notSupported(path.child('template', 'spec', 'restartPolicy'), restartPolicy, ['Always']));
  if (typeof podSpec.activeDeadlineSeconds === 'number') errs.push(forbidden(path.child('template', 'spec', 'activeDeadlineSeconds'), 'activeDeadlineSeconds in DaemonSet is not Supported'));
  errs.push(...validateNonnegativeField(num(spec.minReadySeconds), path.child('minReadySeconds')));
  errs.push(...validateNonnegativeField(templateGeneration, path.child('templateGeneration')));
  errs.push(...validateDaemonSetUpdateStrategy(obj(spec.updateStrategy) ?? {}, path.child('updateStrategy')));
  if (typeof spec.revisionHistoryLimit === 'number') errs.push(...validateNonnegativeField(spec.revisionHistoryLimit, path.child('revisionHistoryLimit')));
  return errs;
}

/** ValidateDaemonSet. */
export function validateDaemonSet(ds: JsonObject, templateGeneration: number, opts: PodValidationOptions): FieldError[] {
  const errs = validateObjectMeta(obj(ds.metadata) ?? {}, true, nameIsDNSSubdomain, newPath('metadata'));
  errs.push(...validateDaemonSetSpec(obj(ds.spec) ?? {}, templateGeneration, newPath('spec'), opts));
  return errs;
}

/** ValidateDaemonSetSpecUpdate. */
function validateDaemonSetSpecUpdate(spec: JsonObject, tg: number, oldSpec: JsonObject, oldTg: number, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (tg < oldTg) errs.push(invalid(path.child('templateGeneration'), tg, 'must not be decremented'));
  const templateUpdated = !jsonEqual(spec.template ?? null, oldSpec.template ?? null);
  if (tg === oldTg && templateUpdated) errs.push(invalid(path.child('templateGeneration'), tg, 'must be incremented upon template update'));
  else if (tg > oldTg && !templateUpdated) errs.push(invalid(path.child('templateGeneration'), tg, 'must not be incremented without template update'));
  // ValidateImmutableField(newSpec.Selector, …): the new selector printed as JSON.
  const immutable = validateImmutableField(spec.selector ?? null, oldSpec.selector ?? null, newPath('spec').child('selector'));
  errs.push(...immutable.map((e) => ({ ...e, value: selectorValue(spec.selector) })));
  return errs;
}

/** ValidateDaemonSetUpdate: the spec update rules come before the spec itself. */
export function validateDaemonSetUpdate(ds: JsonObject, tg: number, old: JsonObject, oldTg: number, opts: PodValidationOptions): FieldError[] {
  const errs = validateObjectMetaUpdate(obj(ds.metadata) ?? {}, obj(old.metadata) ?? {}, newPath('metadata'));
  const spec = obj(ds.spec) ?? {};
  errs.push(...validateDaemonSetSpecUpdate(spec, tg, obj(old.spec) ?? {}, oldTg, newPath('spec')));
  errs.push(...validateDaemonSetSpec(spec, tg, newPath('spec'), opts));
  return errs;
}

/** validateDaemonSetStatus. */
function validateDaemonSetStatus(status: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  for (const f of ['currentNumberScheduled', 'numberMisscheduled', 'desiredNumberScheduled', 'numberReady', 'observedGeneration', 'updatedNumberScheduled', 'numberAvailable', 'numberUnavailable']) {
    errs.push(...validateNonnegativeField(num(status[f]), path.child(f)));
  }
  if (typeof status.collisionCount === 'number') errs.push(...validateNonnegativeField(status.collisionCount, path.child('collisionCount')));
  return errs;
}

/** ValidateDaemonSetStatusUpdate. */
export function validateDaemonSetStatusUpdate(ds: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(obj(ds.metadata) ?? {}, obj(old.metadata) ?? {}, newPath('metadata'));
  const path = newPath('status');
  const status = obj(ds.status) ?? {};
  errs.push(...validateDaemonSetStatus(status, path));
  // IsDecremented: an old count that goes away or down.
  const cc = status.collisionCount;
  const oldCC = obj(old.status)?.collisionCount;
  if (typeof oldCC === 'number' && (typeof cc !== 'number' || cc < oldCC)) errs.push(invalid(path.child('collisionCount'), typeof cc === 'number' ? cc : 0, 'cannot be decremented'));
  return errs;
}
