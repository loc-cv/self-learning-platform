// Pod. upstream: pkg/registry/core/pod/strategy.go (podStrategy: PrepareForCreate, PrepareForUpdate,
// Validate, WarningsOnCreate, ValidateUpdate, CheckGracefulDelete, ToSelectableFields,
// applySchedulingGatedCondition, updatePodGeneration; podStatusStrategy: PrepareForUpdate,
// preserveOldObservedGeneration, ValidateUpdate), pkg/registry/core/pod/storage/storage.go
// (ReturnDeletedObject, the status subresource), pkg/apis/core/v1/conversion.go (the Pod field
// label conversion).
//
// WarningsOnCreate adds podutil.GetWarningsForPod (apis/core/validation/podwarnings.ts);
// WarningsOnUpdate has none (upstream skips them on the Pod update path); the status strategy's
// WarningsOnUpdate checks status.podIPs and status.hostIPs.
//
// Not ported: the matchLabelKeys merges of mutatePodAffinity / mutateTopologySpreadConstraints and
// DefaultPodLevelResources (logged by validation when the fields are used), the AppArmor version
// skew (annotations, logged), and podutil.DropDisabledPodFields apart from lifecycle.stopSignal.

import type { Strategy, StrategyCtx } from '../../apiserver/types.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { isDNS1123Label } from '../../apimachinery/validation/names.ts';
import { defaultPod } from '../../apis/core/v1/defaults/pod.ts';
import { getPodQOS } from '../../apis/core/helper/qos.ts';
import { validatePodCreate, validatePodStatusUpdate, validatePodUpdate } from '../../apis/core/validation/pod.ts';
import type { PodValidationOptions } from '../../apis/core/validation/options.ts';
import { getWarningsForPod } from '../../apis/core/validation/podwarnings.ts';
import { newPath } from '../../apimachinery/field.ts';
import { getWarningsForIP } from '../../apimachinery/validation/ip.ts';
import { objectMetaFields } from '../meta.ts';
import { dropDisabledPodSpecFields } from '../apps/template.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const meta = (o: JsonObject): JsonObject => {
  if (!isObject(o.metadata)) o.metadata = {};
  return o.metadata as JsonObject;
};

const options = (s: StrategyCtx): PodValidationOptions => ({ resourceIsPod: true, notPorted: (what) => s.notPorted(what) });

/**
 * podutil.DropDisabledPodFields: lifecycle.stopSignal (ContainerStopSignals, alpha). checked
 * against the v1.37.2 oracle: a Pod created with only `lifecycle: {stopSignal: SIGUSR1}` came back
 * without `lifecycle`.
 */
function dropDisabledPodFields(pod: JsonObject, old: JsonObject | undefined): void {
  dropDisabledPodSpecFields(obj(pod.spec), old ? obj(old.spec) : undefined);
}

/** applySchedulingGatedCondition: a gated Pod starts with PodScheduled=False, SchedulingGated. */
function applySchedulingGatedCondition(pod: JsonObject, s: StrategyCtx): void {
  const gates = obj(pod.spec)?.schedulingGates;
  if (!Array.isArray(gates) || gates.length === 0) return;
  const status = obj(pod.status) as JsonObject;
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  if (conditions.some((c) => obj(c)?.type === 'PodScheduled')) return;
  // podutil.UpdatePodCondition sets lastTransitionTime to now. checked against the v1.37.2 oracle.
  status.conditions = [
    ...conditions,
    { type: 'PodScheduled', status: 'False', lastProbeTime: null, lastTransitionTime: s.now(), reason: 'SchedulingGated', message: 'Scheduling is blocked due to non-empty scheduling gates' },
  ];
}

/** preserveOldObservedGeneration: a status write that clears observedGeneration keeps the old one. */
function preserveOldObservedGeneration(status: JsonObject, oldStatus: JsonObject): void {
  if (!status.observedGeneration) {
    if (oldStatus.observedGeneration !== undefined) status.observedGeneration = oldStatus.observedGeneration;
  }
  const oldGens = new Map<string, Json[]>();
  for (const c of Array.isArray(oldStatus.conditions) ? oldStatus.conditions : []) {
    const type = str(obj(c)?.type);
    oldGens.set(type, [...(oldGens.get(type) ?? []), obj(c)?.observedGeneration ?? 0]);
  }
  for (const c of Array.isArray(status.conditions) ? status.conditions : []) {
    const co = obj(c);
    if (!co) continue;
    const gens = oldGens.get(str(co.type)) ?? [];
    const oldGen = gens.length > 0 ? gens[0] : 0;
    oldGens.set(str(co.type), gens.slice(1));
    if (!co.observedGeneration && typeof oldGen === 'number' && oldGen !== 0) co.observedGeneration = oldGen;
  }
}

/** The Pod field label conversion (pkg/apis/core/v1/conversion.go). */
const POD_FIELD_LABELS = [
  'metadata.name',
  'metadata.namespace',
  'spec.nodeName',
  'spec.restartPolicy',
  'spec.schedulerName',
  'spec.serviceAccountName',
  'spec.hostNetwork',
  'status.phase',
  'status.podIP',
  'status.podIPs',
  'status.nominatedNodeName',
];

export const podStrategy: Strategy = {
  group: '',
  resource: 'pods',
  kind: 'Pod',
  storage: 'pods',
  storageVersion: 'v1',
  defaults: (o) => defaultPod(o),
  prepareForCreate: (o, s) => {
    meta(o).generation = 1;
    o.status = { phase: 'Pending' };
    dropDisabledPodFields(o, undefined);
    applySchedulingGatedCondition(o, s);
    (o.status as JsonObject).qosClass = getPodQOS(o);
  },
  prepareForUpdate: (o, old) => {
    o.status = old.status === undefined ? {} : cloneJson(old.status);
    const spec = obj(o.spec);
    const oldSpec = obj(old.spec);
    // PodLevelResourcesFixDefaulting: a client that dropped spec.resources keeps the old ones.
    if (spec && spec.resources === undefined && oldSpec?.resources !== undefined) spec.resources = cloneJson(oldSpec.resources);
    dropDisabledPodFields(o, old);
    // updatePodGeneration
    if (!jsonEqual(o.spec ?? null, old.spec ?? null)) {
      const m = meta(o);
      m.generation = (typeof m.generation === 'number' ? m.generation : 0) + 1;
    }
  },
  validate: (o, s) => validatePodCreate(o, options(s)),
  validateUpdate: (o, old, s) => validatePodUpdate(o, old, options(s)),
  warningsOnCreate: (o) => {
    const msgs = isDNS1123Label(str(meta(o).name));
    const name = msgs.length === 0 ? [] : [`metadata.name: this is used in the Pod's hostname, which can result in surprising behavior; a DNS label is recommended: [${msgs.join(' ')}]`];
    return [...name, ...getWarningsForPod(o)];
  },
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  returnDeletedObject: true,
  gracePeriod: (pod: ApiObject, requested: number | undefined) => {
    // CheckGracefulDelete: always graceful, with 0 for unbound and finished Pods.
    const spec = obj(pod.spec) ?? {};
    let period = requested ?? (typeof spec.terminationGracePeriodSeconds === 'number' ? spec.terminationGracePeriodSeconds : 0);
    if (str(spec.nodeName) === '') period = 0;
    const phase = str(obj(pod.status)?.phase);
    if (phase === 'Failed' || phase === 'Succeeded') period = 0;
    if (period < 0) period = 1;
    return period;
  },
  fields: (o) => {
    // ToSelectableFields
    const spec = obj(o.spec) ?? {};
    const status = obj(o.status) ?? {};
    const podIPs = Array.isArray(status.podIPs) ? status.podIPs : [];
    return {
      'spec.nodeName': str(spec.nodeName),
      'spec.restartPolicy': str(spec.restartPolicy),
      'spec.schedulerName': str(spec.schedulerName),
      'spec.serviceAccountName': str(spec.serviceAccountName),
      'spec.hostNetwork': spec.hostNetwork === true ? 'true' : 'false',
      'status.phase': str(status.phase),
      'status.podIP': podIPs.length > 0 ? str(obj(podIPs[0])?.ip) : '',
      'status.nominatedNodeName': str(status.nominatedNodeName),
      ...objectMetaFields(o, true),
    };
  },
  convertFieldLabel: (label, value) => {
    if (POD_FIELD_LABELS.includes(label)) return { label, value };
    // Backwards compatibility with old v1 clients that send spec.host.
    if (label === 'spec.host') return { label: 'spec.nodeName', value };
    return { error: `field label not supported: ${label}` };
  },
  status: {
    prepareForUpdate: (o, old) => {
      o.spec = old.spec === undefined ? {} : cloneJson(old.spec);
      const m = meta(o);
      delete m.deletionTimestamp;
      const oldMeta = obj(old.metadata) ?? {};
      if (oldMeta.ownerReferences === undefined) delete m.ownerReferences;
      else m.ownerReferences = cloneJson(oldMeta.ownerReferences);
      if (!isObject(o.status)) o.status = {};
      const status = o.status as JsonObject;
      const oldStatus = obj(old.status) ?? {};
      if (str(status.qosClass) === '' && oldStatus.qosClass !== undefined) status.qosClass = oldStatus.qosClass;
      for (const f of ['resourceClaimStatuses', 'extendedResourceClaimStatus', 'nodeAllocatableResourceClaimStatuses']) {
        if (status[f] === undefined && oldStatus[f] !== undefined) status[f] = cloneJson(oldStatus[f] as Json);
      }
      preserveOldObservedGeneration(status, oldStatus);
    },
    validateUpdate: (o, old, s) => validatePodStatusUpdate(o, old, options(s)),
    warningsOnUpdate: (o) => {
      const status = obj(o.status) ?? {};
      const ips = (field: string) => (Array.isArray(status[field]) ? (status[field] as Json[]) : []);
      return [
        ...ips('podIPs').flatMap((ip, i) => getWarningsForIP(newPath('status', 'podIPs').index(i).child('ip'), str(obj(ip)?.ip))),
        ...ips('hostIPs').flatMap((ip, i) => getWarningsForIP(newPath('status', 'hostIPs').index(i).child('ip'), str(obj(ip)?.ip))),
      ];
    },
  },
};
