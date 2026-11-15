// EndpointSlice validation.
// upstream: pkg/apis/discovery/validation/validation.go ValidateEndpointSlice,
// ValidateEndpointSliceCreate, ValidateEndpointSliceUpdate, validateEndpoints, validatePorts,
// validateAddressType, validateHints (ValidateEndpointSliceName: NameIsDNSSubdomain; the core
// group's ValidateObjectMeta wrapper); staging/src/k8s.io/apimachinery/pkg/util/validation
// IsFullyQualifiedDomainName.
// Declarative validation (pkg/apis/discovery/v1/zz_generated.validations.go, all +k8s:beta) is
// enforced with DeclarativeValidationBeta on (beta, default true in v1.37.2): the handwritten
// errors marked CoveredByDeclarative are dropped and the declarative ones appended after the
// others (staging/src/k8s.io/apiserver/pkg/registry/rest/validate.go
// ValidateDeclarativelyWithMigrationChecks). Checked against the v1.37.2 oracle: a slice with no
// addressType and an endpoint without addresses gets `[ports…, addressType: Required value,
// endpoints[0].addresses: Required value]`, without the handwritten "must contain at least 1
// address" detail.

import { duplicate, invalid, newPath, notSupported, required, tooMany, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { jsonEqual, type JsonObject } from '../../../apimachinery/json.ts';
import { parseIPSloppy, to4 } from '../../../apimachinery/net.ts';
import { isValidIP, isValidIPForLegacyField } from '../../../apimachinery/validation/ip.ts';
import { isDNS1123Label, isDNS1123Subdomain, isValidLabelValue, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateImmutableField, validateLabels } from '../../../apimachinery/validation/objectmeta.ts';
import { SUPPORTED_PORT_PROTOCOLS, validateEndpointIP, validateNodeName } from '../../core/validation/endpoints.ts';
import { validateObjectMeta } from '../../core/validation/objectmeta.ts';
import { isSet, obj, objs, str, strMap, strs, validateDNS1123Label, validateQualifiedName } from '../../core/validation/util.ts';

const SUPPORTED_ADDRESS_TYPES = ['FQDN', 'IPv4', 'IPv6'];
const MAX_TOPOLOGY_LABELS = 16;
const MAX_ADDRESSES = 100;
const MAX_PORTS = 20000;
const MAX_ENDPOINTS = 1000;
const MAX_ZONE_HINTS = 8;
const MAX_NODE_HINTS = 8;
const LABEL_TOPOLOGY_ZONE = 'topology.kubernetes.io/zone';

/** IsFullyQualifiedDomainName. */
function isFullyQualifiedDomainName(path: Path, name0: string): FieldError[] {
  if (name0.length === 0) return [required(path)];
  const name = name0.endsWith('.') ? name0.slice(0, -1) : name0;
  const errs = isDNS1123Subdomain(name);
  if (errs.length > 0) return [invalid(path, name, errs.join(','))];
  const labels = name.split('.');
  if (labels.length < 2) return [invalid(path, name, 'should be a domain with at least two segments separated by dots')];
  for (const label of labels) {
    const e = isDNS1123Label(label);
    if (e.length > 0) return [invalid(path, label, e.join(','))];
  }
  return [];
}

function validateHints(hints: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const fz = objs(hints.forZones);
  const fzPath = path.child('forZones');
  if (fz.length > MAX_ZONE_HINTS) return [tooMany(fzPath, fz.length, MAX_ZONE_HINTS)];
  const zones: string[] = [];
  fz.forEach((z, i) => {
    const p = fzPath.index(i).child('name');
    const name = str(z.name);
    if (zones.includes(name)) errs.push(duplicate(p, name));
    else zones.push(name);
    for (const m of isValidLabelValue(name)) errs.push(invalid(p, name, m));
  });
  const fn = objs(hints.forNodes);
  const fnPath = path.child('forNodes');
  if (fn.length > MAX_NODE_HINTS) return [...errs, tooMany(fnPath, fn.length, MAX_NODE_HINTS)];
  const nodes: string[] = [];
  fn.forEach((n, i) => {
    const p = fnPath.index(i).child('name');
    const name = str(n.name);
    if (nodes.includes(name)) errs.push(duplicate(p, name));
    else nodes.push(name);
    for (const m of validateNodeName(name)) errs.push(invalid(p, name, m));
  });
  return errs;
}

/** validateEndpoints without the errors declarative validation covers (addresses required, max 100). */
function validateEndpoints(endpoints: JsonObject[], addrType: string, path: Path): FieldError[] {
  if (endpoints.length > MAX_ENDPOINTS) return [tooMany(path, endpoints.length, MAX_ENDPOINTS)];
  const errs: FieldError[] = [];
  endpoints.forEach((ep, i) => {
    const idx = path.index(i);
    const addressPath = idx.child('addresses');
    strs(ep.addresses).forEach((address, j) => {
      const ap = addressPath.index(j);
      switch (addrType) {
        case 'IPv4': {
          const e = isValidIPForLegacyField(ap, address);
          if (e.length > 0) errs.push(...e);
          else {
            const ip = parseIPSloppy(address);
            if (!ip || !to4(ip)) errs.push(invalid(addressPath, address, 'must be an IPv4 address'));
            errs.push(...validateEndpointIP(address, ap));
          }
          break;
        }
        case 'IPv6': {
          const e = isValidIP(ap, address);
          if (e.length > 0) errs.push(...e);
          else {
            const ip = parseIPSloppy(address);
            if (!ip || to4(ip)) errs.push(invalid(addressPath, address, 'must be an IPv6 address'));
            errs.push(...validateEndpointIP(address, ap));
          }
          break;
        }
        case 'FQDN':
          errs.push(...isFullyQualifiedDomainName(ap, address));
          break;
      }
    });
    if (isSet(ep.nodeName)) {
      const nodeName = str(ep.nodeName);
      for (const m of validateNodeName(nodeName)) errs.push(invalid(idx.child('nodeName'), nodeName, m));
    }
    const topologyPath = idx.child('deprecatedTopology');
    const topology = strMap(ep.deprecatedTopology);
    if (Object.keys(topology).length > MAX_TOPOLOGY_LABELS) errs.push(tooMany(topologyPath, Object.keys(topology).length, MAX_TOPOLOGY_LABELS));
    errs.push(...validateLabels(topology, topologyPath));
    // The v1 → internal conversion moves a zone label into `zone`; v1 has no such check to fail.
    if (LABEL_TOPOLOGY_ZONE in topology) errs.push({ type: 'InternalError', field: topologyPath.key(LABEL_TOPOLOGY_ZONE).toString(), value: null, detail: 'reserved key was not removed in conversion' });
    if (isSet(ep.hostname)) errs.push(...validateDNS1123Label(str(ep.hostname), idx.child('hostname')));
    const hints = obj(ep.hints);
    if (hints) errs.push(...validateHints(hints, idx.child('hints')));
  });
  return errs;
}

function validatePorts(ports: JsonObject[], path: Path): FieldError[] {
  if (ports.length > MAX_PORTS) return [tooMany(path, ports.length, MAX_PORTS)];
  const errs: FieldError[] = [];
  const names: string[] = [];
  ports.forEach((p, i) => {
    const idx = path.index(i);
    const name = str(p.name);
    if (name.length > 0) errs.push(...validateDNS1123Label(name, idx.child('name')));
    if (names.includes(name)) errs.push(duplicate(idx.child('name'), name));
    else names.push(name);
    if (!isSet(p.protocol)) errs.push(required(idx.child('protocol')));
    else if (!SUPPORTED_PORT_PROTOCOLS.includes(str(p.protocol))) errs.push(notSupported(idx.child('protocol'), str(p.protocol), SUPPORTED_PORT_PROTOCOLS));
    if (isSet(p.appProtocol)) errs.push(...validateQualifiedName(str(p.appProtocol), idx.child('appProtocol')));
  });
  return errs;
}

/** A handwritten error, and whether it is marked CoveredByDeclarative. */
interface HvError {
  e: FieldError;
  covered: boolean;
}

/**
 * The declarative rules (Validate_EndpointSlice, Validate_Endpoint): addressType required, on
 * update immutable (validate.Immutable: Invalid with a null value), both evaluated before the
 * enum, which runs only when neither failed (validate.Enum lists the symbols sorted); each
 * endpoint's addresses required and at most 100 (no per-element ratcheting: EachValSliceVal has
 * no match function). Unchanged values are not revalidated on update.
 */
function declarative(eps: JsonObject, old: JsonObject | undefined): FieldError[] {
  const errs: FieldError[] = [];
  const addrType = str(eps.addressType);
  if (!(old && str(old.addressType) === addrType)) {
    let early = false;
    if (addrType === '') {
      errs.push(required(newPath('addressType')));
      early = true;
    }
    if (old) {
      errs.push(invalid(newPath('addressType'), null, 'field is immutable'));
      early = true;
    }
    if (!early && !SUPPORTED_ADDRESS_TYPES.includes(addrType)) errs.push(notSupported(newPath('addressType'), addrType, SUPPORTED_ADDRESS_TYPES));
  }
  if (old && jsonEqual(old.endpoints ?? null, eps.endpoints ?? null)) return errs;
  objs(eps.endpoints).forEach((ep, i) => {
    const addresses = strs(ep.addresses);
    const p = newPath('endpoints').index(i).child('addresses');
    if (addresses.length === 0) errs.push(required(p));
    if (addresses.length > MAX_ADDRESSES) errs.push(tooMany(p, addresses.length, MAX_ADDRESSES));
  });
  return errs;
}

/** ValidateEndpointSlice (and on update ValidateEndpointSliceUpdate's immutable addressType). */
function handwritten(eps: JsonObject, old: JsonObject | undefined): HvError[] {
  const out: HvError[] = validateObjectMeta(eps.metadata as JsonObject, true, nameIsDNSSubdomain, newPath('metadata')).map((e) => ({ e, covered: false }));
  const addrType = str(eps.addressType);
  if (addrType === '') out.push({ e: required(newPath('addressType')), covered: true });
  else if (!SUPPORTED_ADDRESS_TYPES.includes(addrType)) out.push({ e: notSupported(newPath('addressType'), addrType, SUPPORTED_ADDRESS_TYPES), covered: true });
  out.push(...validatePorts(objs(eps.ports), newPath('ports')).map((e) => ({ e, covered: false })));
  let endpointsErrs = validateEndpoints(objs(eps.endpoints), addrType, newPath('endpoints'));
  if (endpointsErrs.length > 0 && old && jsonEqual(old.endpoints ?? null, eps.endpoints ?? null)) endpointsErrs = [];
  out.push(...endpointsErrs.map((e) => ({ e, covered: false })));
  if (old) {
    for (const e of validateImmutableField(eps.addressType ?? '', old.addressType ?? '', newPath('addressType'))) out.push({ e, covered: true });
  }
  return out;
}

/**
 * ValidateDeclarativelyWithMigrationChecks with every rule beta and the beta gate on: a covered
 * handwritten error goes when a declarative error has its type and field (FilterCoveredHandwrittenErrors;
 * the origins of these pairs agree), and the declarative errors are appended.
 */
function withDeclarative(hv: HvError[], dv: FieldError[]): FieldError[] {
  const kept = hv.filter(({ e, covered }) => !covered || !dv.some((d) => d.type === e.type && d.field === e.field)).map(({ e }) => e);
  return [...kept, ...dv];
}

export function validateEndpointSliceCreate(eps: JsonObject): FieldError[] {
  return withDeclarative(handwritten(eps, undefined), declarative(eps, undefined));
}

export function validateEndpointSliceUpdate(eps: JsonObject, old: JsonObject): FieldError[] {
  return withDeclarative(handwritten(eps, old), declarative(eps, old));
}
