// ReplicaSet validation, and the pod template check Deployments share.
// upstream: pkg/apis/apps/validation/validation.go ValidateReplicaSet, ValidateReplicaSetUpdate,
// ValidateReplicaSetStatusUpdate, ValidateReplicaSetStatus, ValidateReplicaSetSpec,
// ValidatePodTemplateSpecForReplicaSet. apps validation calls the core group's ValidateObjectMeta
// (pkg/apis/core/validation, with the kube finalizer name rule), as upstream imports it.

import { forbidden, invalid, newPath, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { goJson, isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { labelSelectorAsSelector, selectorEmpty, selectorMatches, type Selector } from '../../../apimachinery/labels.ts';
import { nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateImmutableField, validateLabelSelector, validateNonnegativeField } from '../../../apimachinery/validation/objectmeta.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../core/validation/objectmeta.ts';
import type { PodValidationOptions } from '../../core/validation/options.ts';
import { validatePodTemplateSpec } from '../../core/validation/pod.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);
const strMap = (v: Json | undefined): Record<string, string> => (isObject(v) ? (v as Record<string, string>) : {});

/** The bad value of a *metav1.LabelSelector: its JSON (null when unset). */
export const selectorValue = (sel: Json | undefined): { go: string } => ({ go: sel === undefined ? 'null' : goJson(sel) });

/** ValidatePodTemplateSpecForReplicaSet. */
export function validatePodTemplateSpecForReplicaSet(template: JsonObject, selector: Selector, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  const labels = obj(obj(template.metadata)?.labels);
  if (!selectorEmpty(selector) && !selectorMatches(selector, strMap(labels))) {
    errs.push(invalid(path.child('metadata', 'labels'), labels ?? null, '`selector` does not match template `labels`'));
  }
  errs.push(...validatePodTemplateSpec(template, path, opts));
  const spec = obj(template.spec) ?? {};
  const restartPolicy = typeof spec.restartPolicy === 'string' ? spec.restartPolicy : '';
  if (restartPolicy !== 'Always') errs.push(notSupported(path.child('spec', 'restartPolicy'), restartPolicy, ['Always']));
  if (typeof spec.activeDeadlineSeconds === 'number') errs.push(forbidden(path.child('spec', 'activeDeadlineSeconds'), 'activeDeadlineSeconds in ReplicaSet is not Supported'));
  return errs;
}

/**
 * The selector part of ValidateReplicaSetSpec / ValidateDeploymentSpec: the selector itself, then
 * the template against it. `afterSelector` runs between the two (nothing for ReplicaSets).
 */
export function validateSelectorAndTemplate(spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  const sel = spec.selector;
  if (sel === undefined || sel === null) errs.push(required(path.child('selector')));
  else {
    errs.push(...validateLabelSelector(sel, {}, path.child('selector')));
    const s = obj(sel) ?? {};
    const n = Object.keys(strMap(s.matchLabels)).length + (Array.isArray(s.matchExpressions) ? s.matchExpressions.length : 0);
    if (n === 0) errs.push(invalid(path.child('selector'), selectorValue(sel), 'empty selector is invalid for deployment'));
  }
  const selector = labelSelectorAsSelector(sel ?? undefined);
  if ('error' in selector) errs.push(invalid(path.child('selector'), selectorValue(sel), 'invalid label selector'));
  else errs.push(...validatePodTemplateSpecForReplicaSet(obj(spec.template) ?? {}, selector, path.child('template'), opts));
  return errs;
}

/** ValidateReplicaSetSpec. */
function validateReplicaSetSpec(spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs = validateNonnegativeField(num(spec.replicas), path.child('replicas'));
  errs.push(...validateNonnegativeField(num(spec.minReadySeconds), path.child('minReadySeconds')));
  errs.push(...validateSelectorAndTemplate(spec, path, opts));
  return errs;
}

/** ValidateReplicaSet. */
export function validateReplicaSet(rs: JsonObject, opts: PodValidationOptions): FieldError[] {
  const errs = validateObjectMeta(obj(rs.metadata) ?? {}, true, nameIsDNSSubdomain, newPath('metadata'));
  errs.push(...validateReplicaSetSpec(obj(rs.spec) ?? {}, newPath('spec'), opts));
  return errs;
}

/** ValidateReplicaSetUpdate. */
export function validateReplicaSetUpdate(rs: JsonObject, old: JsonObject, opts: PodValidationOptions): FieldError[] {
  const errs = validateObjectMetaUpdate(obj(rs.metadata) ?? {}, obj(old.metadata) ?? {}, newPath('metadata'));
  errs.push(...validateReplicaSetSpec(obj(rs.spec) ?? {}, newPath('spec'), opts));
  errs.push(...immutableSelector(obj(rs.spec)?.selector, obj(old.spec)?.selector));
  return errs;
}

/** ValidateImmutableField(spec.selector): the new selector printed as JSON. */
export function immutableSelector(sel: Json | undefined, oldSel: Json | undefined): FieldError[] {
  const errs = validateImmutableField(sel ?? null, oldSel ?? null, newPath('spec').child('selector'));
  return errs.map((e) => ({ ...e, value: selectorValue(sel) }));
}

/** ValidateReplicaSetStatus. */
function validateReplicaSetStatus(status: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  for (const f of ['replicas', 'fullyLabeledReplicas', 'readyReplicas', 'availableReplicas', 'observedGeneration']) errs.push(...validateNonnegativeField(num(status[f]), path.child(f)));
  if (typeof status.terminatingReplicas === 'number') errs.push(...validateNonnegativeField(status.terminatingReplicas, path.child('terminatingReplicas')));
  const msg = 'cannot be greater than status.replicas';
  const replicas = num(status.replicas);
  if (num(status.fullyLabeledReplicas) > replicas) errs.push(invalid(path.child('fullyLabeledReplicas'), num(status.fullyLabeledReplicas), msg));
  if (num(status.readyReplicas) > replicas) errs.push(invalid(path.child('readyReplicas'), num(status.readyReplicas), msg));
  if (num(status.availableReplicas) > replicas) errs.push(invalid(path.child('availableReplicas'), num(status.availableReplicas), msg));
  if (num(status.availableReplicas) > num(status.readyReplicas)) errs.push(invalid(path.child('availableReplicas'), num(status.availableReplicas), 'cannot be greater than readyReplicas'));
  return errs;
}

/** ValidateReplicaSetStatusUpdate. */
export function validateReplicaSetStatusUpdate(rs: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(obj(rs.metadata) ?? {}, obj(old.metadata) ?? {}, newPath('metadata'));
  errs.push(...validateReplicaSetStatus(obj(rs.status) ?? {}, newPath('status')));
  return errs;
}
