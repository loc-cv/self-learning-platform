// DaemonSet. upstream: pkg/registry/apps/daemonset/strategy.go (daemonSetStrategy: PrepareForCreate
// (generation 1, template generation at least 1), PrepareForUpdate (template generation and
// generation on template change, generation alone on another spec change; metadata changes bump
// neither), Validate, WarningsOnCreate, ValidateUpdate, WarningsOnUpdate,
// DefaultGarbageCollectionPolicy DeleteDependents, AllowUnconditionalUpdate;
// daemonSetStatusStrategy: PrepareForUpdate keeps spec, ValidateUpdate),
// pkg/registry/apps/daemonset/storage/storage.go (status subresource, Status on delete, no scale).
// Field selectors: metadata.name and metadata.namespace only (no ToSelectableFields, no conversion
// function registered for apps/v1 DaemonSet).
//
// The internal Spec.TemplateGeneration travels in apps/v1 as the annotation
// `deprecated.daemonset.template.generation` (pkg/apis/apps/v1/conversion.go
// Convert_v1_DaemonSet_To_apps_DaemonSet reads and removes it, failing on a value strconv.ParseInt
// refuses; Convert_apps_DaemonSet_To_v1_DaemonSet always writes it back). Objects stay in apps/v1
// here, so the strategy keeps the annotation itself: whatever the client sent is replaced by the
// value the internal object would hold.
// Its only warnings are the template's (GetWarningsForPodTemplate), on create and when the
// template generation changes.

import type { Strategy, StrategyCtx } from '../../apiserver/types.ts';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { parseInt64 } from '../../apimachinery/intstr.ts';
import { defaultDaemonSet } from '../../apis/apps/v1/defaults.ts';
import { validateDaemonSet, validateDaemonSetStatusUpdate, validateDaemonSetUpdate } from '../../apis/apps/validation/daemonset.ts';
import type { PodValidationOptions } from '../../apis/core/validation/options.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';
import { dropDisabledTemplateFields } from './template.ts';
import { templateWarnings } from './deployment.ts';

/** upstream: staging/src/k8s.io/api/apps/v1/types.go DeprecatedTemplateGeneration. */
export const TEMPLATE_GENERATION_ANNOTATION = 'deprecated.daemonset.template.generation';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const meta = (o: JsonObject): JsonObject => {
  if (!isObject(o.metadata)) o.metadata = {};
  return o.metadata as JsonObject;
};
const options = (s: StrategyCtx): PodValidationOptions => ({ resourceIsPod: false, notPorted: (what) => s.notPorted(what) });

/** The internal Spec.TemplateGeneration of an apps/v1 object: the annotation's value, 0 without one. */
export function templateGeneration(o: JsonObject): bigint {
  const v = obj(obj(o.metadata)?.annotations)?.[TEMPLATE_GENERATION_ANNOTATION];
  if (typeof v !== 'string') return 0n;
  const r = parseInt64(v);
  return 'error' in r ? 0n : r.value;
}

/** Convert_apps_DaemonSet_To_v1_DaemonSet: the annotation holds strconv.FormatInt of the generation. */
function setTemplateGeneration(o: JsonObject, tg: bigint): void {
  const m = meta(o);
  if (!isObject(m.annotations)) m.annotations = {};
  (m.annotations as JsonObject)[TEMPLATE_GENERATION_ANNOTATION] = tg.toString();
}

/**
 * The round trip through the internal type that decoding does after defaulting: the internal
 * RollingUpdateDaemonSet holds IntOrStrings, not pointers, so an absent maxUnavailable or maxSurge
 * comes back as 0 (zz_generated.conversion.go Convert_Pointer_intstr_IntOrString_To_intstr_IntOrString
 * and back). Only an OnDelete strategy can still have a rollingUpdate with a value missing here.
 */
function convertRollingUpdate(o: JsonObject): void {
  const ru = obj(obj(obj(o.spec)?.updateStrategy)?.rollingUpdate);
  if (!ru) return;
  if (ru.maxUnavailable === undefined || ru.maxUnavailable === null) ru.maxUnavailable = 0;
  if (ru.maxSurge === undefined || ru.maxSurge === null) ru.maxSurge = 0;
}

export const daemonSetStrategy: Strategy = {
  group: 'apps',
  resource: 'daemonsets',
  kind: 'DaemonSet',
  storage: 'daemonsets.apps',
  storageVersion: 'v1',
  defaults: (o) => {
    defaultDaemonSet(o);
    convertRollingUpdate(o);
  },
  conversionError: (o) => {
    const v = obj(obj(o.metadata)?.annotations)?.[TEMPLATE_GENERATION_ANNOTATION];
    if (typeof v !== 'string') return undefined;
    const r = parseInt64(v);
    return 'error' in r ? r.error : undefined;
  },
  prepareForCreate: (o) => {
    o.status = {};
    meta(o).generation = 1;
    const tg = templateGeneration(o);
    setTemplateGeneration(o, tg < 1n ? 1n : tg);
    dropDisabledTemplateFields(o, undefined);
  },
  prepareForUpdate: (o, old) => {
    dropDisabledTemplateFields(o, old);
    o.status = old.status === undefined ? {} : cloneJson(old.status);
    const oldTg = templateGeneration(old);
    const oldGen = obj(old.metadata)?.generation;
    const nextGen = (typeof oldGen === 'number' ? oldGen : 0) + 1;
    const spec = obj(o.spec);
    const oldSpec = obj(old.spec);
    if (!jsonEqual(spec?.template ?? null, oldSpec?.template ?? null)) {
      setTemplateGeneration(o, oldTg + 1n);
      meta(o).generation = nextGen;
      return;
    }
    setTemplateGeneration(o, oldTg);
    if (!jsonEqual(o.spec ?? null, old.spec ?? null)) meta(o).generation = nextGen;
  },
  validate: (o, s) => validateDaemonSet(o, Number(templateGeneration(o)), options(s)),
  validateUpdate: (o, old, s) => validateDaemonSetUpdate(o, Number(templateGeneration(o)), old, Number(templateGeneration(old)), options(s)),
  warningsOnCreate: (o) => templateWarnings(o),
  warningsOnUpdate: (o, old) => (templateGeneration(o) !== templateGeneration(old) ? templateWarnings(o) : []),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  gcPolicy: 'DeleteDependents',
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
  status: {
    prepareForUpdate: (o, old) => {
      // newDaemonSet.Spec = oldDaemonSet.Spec, the template generation included.
      o.spec = old.spec === undefined ? {} : cloneJson(old.spec);
      setTemplateGeneration(o, templateGeneration(old));
    },
    validateUpdate: (o, old) => validateDaemonSetStatusUpdate(o, old),
  },
};
