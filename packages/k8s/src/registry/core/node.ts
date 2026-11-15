// Node. upstream: pkg/registry/core/node/strategy.go (cluster-scoped; create on update not
// allowed, unconditional update allowed; PrepareForUpdate keeps the old status;
// dropDisabledFields; nodeWarnings; the status strategy keeps the old spec;
// NodeToSelectableFields: metadata.name and spec.unschedulable, no metadata.namespace),
// pkg/registry/core/node/storage/storage.go (Status on delete; the status subresource; the
// proxy subresource is not simulated), pkg/apis/core/v1/conversion.go (field labels
// metadata.name and spec.unschedulable). Feature gates at their v1.37.2 defaults, checked
// against the v1.37.2 oracle with a dry-run create: spec.podPreemptionPolicy
// (InPlacePodVerticalScalingSchedulerPreemption, off), spec.configSource and status.config are
// dropped; status.declaredFeatures (NodeDeclaredFeatures), status.runtimeHandlers and
// status.features stay. The node.kubernetes.io/not-ready taint the real server adds on create
// comes from the TaintNodesByCondition admission plugin (phase 20b).

import { cloneJson, isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { getWarningsForCIDR } from '../../apimachinery/validation/ip.ts';
import { newPath } from '../../apimachinery/field.ts';
import { convertNodeSpecPodCIDRs, setObjectDefaultsNode } from '../../apis/core/v1/defaults/node.ts';
import { validateNode, validateNodeUpdate } from '../../apis/core/validation/node.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { objectMetaFields } from '../meta.ts';

const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});

/** dropDisabledFields; `old` is undefined on create. */
function dropDisabledFields(node: JsonObject, old: JsonObject | undefined): void {
  const spec = obj(node.spec);
  const status = obj(node.status);
  const oldSpec = old ? obj(old.spec) : undefined;
  if (!old) {
    delete spec.configSource;
    delete status.config;
  }
  if (oldSpec && oldSpec.configSource === undefined) delete spec.configSource;
  // InPlacePodVerticalScalingSchedulerPreemption is off: kept only when the old Node has it.
  if (!oldSpec || oldSpec.podPreemptionPolicy === undefined) delete spec.podPreemptionPolicy;
}

/** nodeWarnings. */
function nodeWarnings(node: JsonObject): string[] {
  const spec = obj(node.spec);
  const warnings: string[] = [];
  if (spec.configSource !== undefined) warnings.push('spec.configSource: the feature is removed');
  if (typeof spec.externalID === 'string' && spec.externalID !== '') warnings.push('spec.externalID: this field is deprecated, and is unused by Kubernetes');
  const cidrs = Array.isArray(spec.podCIDRs) ? spec.podCIDRs : [];
  cidrs.forEach((c, i) => warnings.push(...getWarningsForCIDR(newPath('spec', 'podCIDRs').index(i), typeof c === 'string' ? c : '')));
  return warnings;
}

export const nodeStrategy: Strategy = {
  group: '',
  resource: 'nodes',
  kind: 'Node',
  storage: 'nodes',
  storageVersion: 'v1',
  defaults(node) {
    setObjectDefaultsNode(node);
    convertNodeSpecPodCIDRs(node);
  },
  prepareForCreate: (node) => dropDisabledFields(node, undefined),
  prepareForUpdate(node, old) {
    if (old.status !== undefined) node.status = cloneJson(old.status);
    else delete node.status;
    dropDisabledFields(node, old);
  },
  validate: (node, s) => validateNode(node, s.notPorted),
  validateUpdate: (node, old, s) => [...validateNode(node, s.notPorted), ...validateNodeUpdate(node, old, s.notPorted)],
  warningsOnCreate: (node) => nodeWarnings(node),
  warningsOnUpdate: (node) => nodeWarnings(node),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  fields(o: ApiObject) {
    return { ...objectMetaFields(o, false), 'spec.unschedulable': String(obj(o.spec).unschedulable === true) };
  },
  convertFieldLabel(label, value) {
    if (label === 'metadata.name' || label === 'spec.unschedulable') return { label, value };
    return { error: `field label not supported: ${label}` };
  },
  status: {
    prepareForUpdate(node, old) {
      if (old.spec !== undefined) node.spec = cloneJson(old.spec);
      else delete node.spec;
      const status = obj(node.status);
      if (obj(old.status).config === undefined) delete status.config;
      // KubeletInUserNamespace is off: kept only when the old Node reports it.
      if (obj(obj(old.status).nodeInfo).runningInUserNamespace === undefined) delete obj(status.nodeInfo).runningInUserNamespace;
    },
    validateUpdate: (node, old, s) => validateNodeUpdate(node, old, s.notPorted),
  },
};
