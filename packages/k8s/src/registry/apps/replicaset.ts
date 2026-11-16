// ReplicaSet. upstream: pkg/registry/apps/replicaset/strategy.go (rsStrategy: PrepareForCreate,
// PrepareForUpdate (generation on spec change), Validate, WarningsOnCreate, ValidateUpdate, WarningsOnUpdate,
// DefaultGarbageCollectionPolicy DeleteDependents, ToSelectableFields; rsStatusStrategy:
// PrepareForUpdate keeps spec, ValidateUpdate), pkg/registry/apps/replicaset/storage/storage.go
// (status and scale subresources, Status on delete). ToSelectableFields has status.replicas, but no
// field label conversion is registered for apps/v1 ReplicaSet, so a selector can only name
// metadata.name and metadata.namespace.

import type { Strategy, StrategyCtx } from '../../apiserver/types.ts';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { defaultReplicaSet } from '../../apis/apps/v1/defaults.ts';
import { validateReplicaSet, validateReplicaSetStatusUpdate, validateReplicaSetUpdate } from '../../apis/apps/validation/replicaset.ts';
import type { PodValidationOptions } from '../../apis/core/validation/options.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';
import { podNamePrefixWarning, templateWarnings, templateWarningsOnUpdate } from './deployment.ts';
import { scaleOf } from './scale.ts';
import { dropDisabledTemplateFields } from './template.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const meta = (o: JsonObject): JsonObject => {
  if (!isObject(o.metadata)) o.metadata = {};
  return o.metadata as JsonObject;
};
const options = (s: StrategyCtx): PodValidationOptions => ({ resourceIsPod: false, notPorted: (what) => s.notPorted(what) });

export const replicaSetStrategy: Strategy = {
  group: 'apps',
  resource: 'replicasets',
  kind: 'ReplicaSet',
  storage: 'replicasets.apps',
  storageVersion: 'v1',
  defaults: (o) => defaultReplicaSet(o),
  prepareForCreate: (o) => {
    o.status = {};
    meta(o).generation = 1;
    dropDisabledTemplateFields(o, undefined);
  },
  prepareForUpdate: (o, old) => {
    o.status = old.status === undefined ? {} : cloneJson(old.status);
    dropDisabledTemplateFields(o, old);
    if (!jsonEqual(o.spec ?? null, old.spec ?? null)) {
      const oldGen = obj(old.metadata)?.generation;
      meta(o).generation = (typeof oldGen === 'number' ? oldGen : 0) + 1;
    }
  },
  validate: (o, s) => validateReplicaSet(o, options(s)),
  validateUpdate: (o, old, s) => validateReplicaSetUpdate(o, old, options(s)),
  warningsOnCreate: (o) => [...podNamePrefixWarning(o), ...templateWarnings(o)],
  warningsOnUpdate: (o, old) => templateWarningsOnUpdate(o, old),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  gcPolicy: 'DeleteDependents',
  fields: (o) => ({ ...objectMetaFields(o, true), 'status.replicas': String(typeof obj(o.status)?.replicas === 'number' ? obj(o.status)?.replicas : 0) }),
  convertFieldLabel: defaultFieldLabel,
  status: {
    prepareForUpdate: (o, old) => {
      o.spec = old.spec === undefined ? {} : cloneJson(old.spec);
    },
    validateUpdate: (o, old) => validateReplicaSetStatusUpdate(o, old),
  },
  scale: { get: scaleOf, replicasPath: ['spec', 'replicas'] },
};
