// Deployment. upstream: pkg/registry/apps/deployment/strategy.go (deploymentStrategy: PrepareForCreate,
// PrepareForUpdate (generation on spec or annotation change), Validate, WarningsOnCreate, ValidateUpdate,
// DefaultGarbageCollectionPolicy DeleteDependents; deploymentStatusStrategy: PrepareForUpdate keeps
// spec and labels, ValidateUpdate), pkg/registry/apps/deployment/storage/storage.go (status and
// scale subresources, Status on delete). Field selectors: metadata.name and metadata.namespace only
// (no conversion function is registered for apps/v1 Deployment).
//
// Not ported: podutil.GetWarningsForPodTemplate (pkg/api/pod/warnings.go is not in the sparse
// checkout) and DropDisabledTemplateFields (lifecycle.stopSignal is dropped as for Pods).

import type { Strategy, StrategyCtx } from '../../apiserver/types.ts';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { isDNS1123Label } from '../../apimachinery/validation/names.ts';
import { defaultDeployment } from '../../apis/apps/v1/defaults.ts';
import { validateDeployment, validateDeploymentStatusUpdate, validateDeploymentUpdate } from '../../apis/apps/validation/deployment.ts';
import type { PodValidationOptions } from '../../apis/core/validation/options.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';
import { dropDisabledTemplateFields } from './template.ts';
import { scaleOf } from './scale.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const meta = (o: JsonObject): JsonObject => {
  if (!isObject(o.metadata)) o.metadata = {};
  return o.metadata as JsonObject;
};
const options = (s: StrategyCtx): PodValidationOptions => ({ resourceIsPod: false, notPorted: (what) => s.notPorted(what) });

/** WarningsOnCreate of Deployments and ReplicaSets: a name that is not a DNS label. */
export function podNamePrefixWarning(o: JsonObject): string[] {
  const name = typeof meta(o).name === 'string' ? (meta(o).name as string) : '';
  const msgs = isDNS1123Label(name);
  return msgs.length === 0 ? [] : [`metadata.name: this is used in Pod names and hostnames, which can result in surprising behavior; a DNS label is recommended: [${msgs.join(' ')}]`];
}

export const deploymentStrategy: Strategy = {
  group: 'apps',
  resource: 'deployments',
  kind: 'Deployment',
  storage: 'deployments.apps',
  storageVersion: 'v1',
  defaults: (o) => defaultDeployment(o),
  prepareForCreate: (o) => {
    o.status = {};
    meta(o).generation = 1;
    dropDisabledTemplateFields(o, undefined);
  },
  prepareForUpdate: (o, old) => {
    o.status = old.status === undefined ? {} : cloneJson(old.status);
    dropDisabledTemplateFields(o, old);
    const m = meta(o);
    const oldMeta = obj(old.metadata) ?? {};
    if (!jsonEqual(o.spec ?? null, old.spec ?? null) || !jsonEqual(m.annotations ?? null, oldMeta.annotations ?? null)) {
      m.generation = (typeof oldMeta.generation === 'number' ? oldMeta.generation : 0) + 1;
    }
  },
  validate: (o, s) => validateDeployment(o, options(s)),
  validateUpdate: (o, old, s) => validateDeploymentUpdate(o, old, options(s)),
  warningsOnCreate: (o) => podNamePrefixWarning(o),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  gcPolicy: 'DeleteDependents',
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
  status: {
    prepareForUpdate: (o, old) => {
      o.spec = old.spec === undefined ? {} : cloneJson(old.spec);
      const m = meta(o);
      const oldLabels = obj(old.metadata)?.labels;
      if (oldLabels === undefined) delete m.labels;
      else m.labels = cloneJson(oldLabels);
      // dropDisabledStatusFields: DeploymentReplicaSetTerminatingReplicas is on, nothing to drop.
    },
    validateUpdate: (o, old) => validateDeploymentStatusUpdate(o, old),
  },
  scale: { get: scaleOf, replicasPath: ['spec', 'replicas'] },
};
