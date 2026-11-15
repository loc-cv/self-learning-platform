// EndpointSlice. upstream: pkg/registry/discovery/endpointslice/strategy.go (namespaced;
// PrepareForCreate sets generation 1 and drops deprecatedTopology on v1; PrepareForUpdate bumps
// the generation when anything but metadata changed or the labels did; create on update not
// allowed, unconditional update allowed; warnOnDeprecatedAddressType, warnOnBadIPs unless one of
// the two EndpointSlice controllers manages the slice), storage/storage.go (Status on delete; no
// field label conversion of its own). PreferSameTrafficDistribution is GA in v1.37, so the
// dropDisabledFields functions keep hints.forNodes.

import { newPath } from '../../apimachinery/field.ts';
import { isObject, jsonEqual, type JsonObject } from '../../apimachinery/json.ts';
import { getWarningsForIP } from '../../apimachinery/validation/ip.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { objs, str, strMap, strs } from '../../apis/core/validation/util.ts';
import { setObjectDefaultsEndpointSlice } from '../../apis/discovery/v1/defaults.ts';
import { validateEndpointSliceCreate, validateEndpointSliceUpdate } from '../../apis/discovery/validation/endpointslice.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

const LABEL_MANAGED_BY = 'endpointslice.kubernetes.io/managed-by';
const MANAGERS = ['endpointslice-controller.k8s.io', 'endpointslicemirroring-controller.k8s.io'];
const LABEL_HOSTNAME = 'kubernetes.io/hostname';

const meta = (o: JsonObject): JsonObject => (isObject(o.metadata) ? o.metadata : {});

function warnOnBadIPs(eps: JsonObject): string[] {
  if (MANAGERS.includes(strMap(meta(eps).labels)[LABEL_MANAGED_BY] ?? '')) return [];
  const w: string[] = [];
  objs(eps.endpoints).forEach((ep, i) => {
    strs(ep.addresses).forEach((addr, j) => w.push(...getWarningsForIP(newPath('endpoints').index(i).child('addresses').index(j), addr)));
  });
  return w;
}

/**
 * dropTopologyOnV1: a v1 request carries no deprecatedTopology; a kubernetes.io/hostname in it
 * becomes nodeName when the old slice named that node (and the name is valid).
 */
function dropTopologyOnV1(old: JsonObject | undefined, eps: JsonObject): void {
  if (old && jsonEqual(old.endpoints ?? null, eps.endpoints ?? null)) return;
  const prev = new Set<string>();
  for (const ep of old ? objs(old.endpoints) : []) {
    const n = strMap(ep.deprecatedTopology)[LABEL_HOSTNAME];
    if (n) prev.add(n);
  }
  for (const ep of Array.isArray(eps.endpoints) ? eps.endpoints.filter(isObject) : []) {
    const host = strMap(ep.deprecatedTopology)[LABEL_HOSTNAME];
    if ((ep.nodeName === undefined || ep.nodeName === null) && host !== undefined && prev.has(host) && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(host) && host.length <= 253) {
      ep.nodeName = host;
    }
    delete ep.deprecatedTopology;
  }
}

/** Everything but metadata, for the generation rule. */
const withoutMeta = (o: JsonObject): JsonObject => {
  const { metadata: _m, apiVersion: _a, kind: _k, ...rest } = o;
  return rest;
};

export const endpointSliceStrategy: Strategy = {
  group: 'discovery.k8s.io',
  resource: 'endpointslices',
  kind: 'EndpointSlice',
  storage: 'endpointslices.discovery.k8s.io',
  storageVersion: 'v1',
  defaults: (obj) => setObjectDefaultsEndpointSlice(obj),
  prepareForCreate(obj) {
    meta(obj).generation = 1;
    dropTopologyOnV1(undefined, obj);
  },
  prepareForUpdate(obj, old) {
    const m = meta(obj);
    const om = meta(old);
    if (!jsonEqual(withoutMeta(obj), withoutMeta(old)) || !jsonEqual(m.labels ?? null, om.labels ?? null)) m.generation = (typeof om.generation === 'number' ? om.generation : 0) + 1;
    dropTopologyOnV1(old, obj);
  },
  validate: (obj) => validateEndpointSliceCreate(obj),
  validateUpdate: (obj, old) => validateEndpointSliceUpdate(obj, old),
  warningsOnCreate: (obj) => [...(str(obj.addressType) === 'FQDN' ? ['spec.addressType: FQDN endpoints are deprecated'] : []), ...warnOnBadIPs(obj)],
  warningsOnUpdate: (obj) => warnOnBadIPs(obj),
  // Storage is protobuf: an empty list reads back as nil, which is `null` for these two
  // non-omitempty fields (checked against the v1.37.2 oracle: `endpoints: []` is returned as null).
  canonicalize(obj) {
    if (Array.isArray(obj.endpoints) && obj.endpoints.length === 0) delete obj.endpoints;
    if (Array.isArray(obj.ports) && obj.ports.length === 0) delete obj.ports;
  },
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
};
