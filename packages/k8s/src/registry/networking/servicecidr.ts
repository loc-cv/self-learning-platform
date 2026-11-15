// ServiceCIDR: the ranges Service ClusterIPs come from (the `kubernetes` one mirrors
// --service-cluster-ip-range).
// upstream: pkg/registry/networking/servicecidr/strategy.go (cluster-scoped; with
// ServiceCIDRStatusFieldWiping, GA in v1.37, PrepareForCreate clears the status and
// PrepareForUpdate keeps the old one; status strategy: ResetObjectMetaForStatus and the old spec;
// create on update not allowed, unconditional update allowed), pkg/apis/networking/validation
// ValidateServiceCIDR, validateServiceCIDRSpec, ValidateServiceCIDRUpdate,
// ValidateServiceCIDRStatusUpdate.
// Left out: what kube-controller-manager's servicecidrs controller does (the
// networking.k8s.io/service-cidr-finalizer, its Ready condition, deletion while IPs are in use).

import { invalid, newPath, required, type FieldError } from '../../apimachinery/field.ts';
import { cloneJson, goJson, isObject, type JsonObject } from '../../apimachinery/json.ts';
import { isValidCIDR } from '../../apimachinery/validation/ip.ts';
import { nameIsDNSSubdomain } from '../../apimachinery/validation/names.ts';
import { FIELD_IMMUTABLE } from '../../apimachinery/validation/objectmeta.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../apis/core/validation/objectmeta.ts';
import { familyOfCIDR } from '../core/service-ipallocator.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

const cidrsOf = (o: JsonObject): string[] => {
  const spec = isObject(o.spec) ? o.spec : {};
  return Array.isArray(spec.cidrs) ? spec.cidrs.map((c) => (typeof c === 'string' ? c : '')) : [];
};

function validateSpec(cidrs: string[]): FieldError[] {
  const path = newPath('spec', 'cidrs');
  if (cidrs.length === 0) return [required(path, 'at least one CIDR required')];
  // The internal ServiceCIDRSpec has no JSON tags: Go field names.
  if (cidrs.length > 2) return [invalid(path, { go: `{"CIDRs":${goJson(cidrs)}}` }, 'may only hold up to 2 values')];
  const errs = cidrs.flatMap((c, i) => isValidCIDR(path.index(i), c));
  const f0 = familyOfCIDR(cidrs[0] as string);
  if (cidrs.length === 2 && f0 !== undefined && f0 === familyOfCIDR(cidrs[1] as string)) {
    errs.push(invalid(path, cidrs, 'may specify no more than one IP for each IP family, i.e 192.168.0.0/24 and 2001:db8::/64'));
  }
  return errs;
}

function validateServiceCIDR(sc: JsonObject): FieldError[] {
  return [...validateObjectMeta(sc.metadata as JsonObject, false, nameIsDNSSubdomain, newPath('metadata')), ...validateSpec(cidrsOf(sc))];
}

function validateServiceCIDRUpdate(sc: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(sc.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata'));
  const oldC = cidrsOf(old);
  const newC = cidrsOf(sc);
  const p = newPath('spec').child('cidrs');
  if (oldC.length === newC.length) {
    oldC.forEach((c, i) => {
      if (c !== newC[i]) errs.push(invalid(p.index(i), newC[i], FIELD_IMMUTABLE));
    });
  } else if (oldC.length === 1 && newC.length === 2) {
    if (newC[0] !== oldC[0]) errs.push(invalid(p.index(0), newC[0], FIELD_IMMUTABLE));
    errs.push(...validateSpec(newC));
  } else {
    errs.push(invalid(p, newC, FIELD_IMMUTABLE));
  }
  return errs;
}

/** ResetObjectMetaForStatus: a status write keeps these metadata fields as they were. */
function resetObjectMetaForStatus(m: JsonObject, old: JsonObject): void {
  for (const k of ['deletionTimestamp', 'generation', 'selfLink', 'labels', 'annotations', 'finalizers', 'ownerReferences']) {
    if (old[k] === undefined) delete m[k];
    else m[k] = cloneJson(old[k]);
  }
}

export const serviceCIDRStrategy: Strategy = {
  group: 'networking.k8s.io',
  resource: 'servicecidrs',
  kind: 'ServiceCIDR',
  storage: 'servicecidrs.networking.k8s.io',
  storageVersion: 'v1',
  prepareForCreate(obj) {
    obj.status = {};
  },
  prepareForUpdate(obj, old) {
    obj.status = cloneJson(old.status ?? {});
  },
  validate: (obj) => validateServiceCIDR(obj),
  validateUpdate: (obj, old) => [...validateServiceCIDR(obj), ...validateServiceCIDRUpdate(obj, old)],
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  fields: (o) => objectMetaFields(o, false),
  convertFieldLabel: defaultFieldLabel,
  status: {
    prepareForUpdate(obj, old) {
      if (!isObject(obj.metadata)) obj.metadata = {};
      resetObjectMetaForStatus(obj.metadata as JsonObject, isObject(old.metadata) ? old.metadata : {});
      obj.spec = cloneJson(old.spec ?? {});
    },
    validateUpdate: (obj, old) => validateObjectMetaUpdate(obj.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata')),
  },
};
