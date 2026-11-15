// Endpoints validation, and ValidateEndpointIP which Services and EndpointSlices use too.
// upstream: pkg/apis/core/validation/validation.go ValidateEndpoints, ValidateEndpointsCreate,
// ValidateEndpointsUpdate, ValidateEndpointsSpecificAnnotations (empty), validateEndpointSubsets,
// validateEndpointAddress, ValidateEndpointIP, validateEndpointPort, ValidateEndpointsName
// (NameIsDNSSubdomain), ValidateNodeName (NameIsDNSSubdomain), supportedPortProtocols.
// The declarative validation of Endpoints (zz_generated.validations.go) covers ObjectMeta only.

import { invalid, newPath, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { jsonEqual, type JsonObject } from '../../../apimachinery/json.ts';
import { ipEqual, parseIPSloppy, to4, type IP } from '../../../apimachinery/net.ts';
import { isValidIPForLegacyField } from '../../../apimachinery/validation/ip.ts';
import { isDNS1123Subdomain, isValidPortNum, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';
import { isSet, num, objs, str, validateDNS1123Label, validateQualifiedName } from './util.ts';

/** supportedPortProtocols, as sets.List gives them. */
export const SUPPORTED_PORT_PROTOCOLS = ['SCTP', 'TCP', 'UDP'];

/** ValidateNodeName: a DNS subdomain. */
export const validateNodeName = (name: string): string[] => isDNS1123Subdomain(name);

const isUnspecified = (ip: IP): boolean => ip.every((b) => b === 0) || ipEqual(ip, [0, 0, 0, 0]);
function isLoopback(ip: IP): boolean {
  const v4 = to4(ip);
  if (v4) return v4[0] === 127;
  return ip.slice(0, 15).every((b) => b === 0) && ip[15] === 1;
}
function isLinkLocalUnicast(ip: IP): boolean {
  const v4 = to4(ip);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  return ip[0] === 0xfe && ((ip[1] as number) & 0xc0) === 0x80;
}
function isLinkLocalMulticast(ip: IP): boolean {
  const v4 = to4(ip);
  if (v4) return v4[0] === 224 && v4[1] === 0 && v4[2] === 0;
  return ip[0] === 0xff && ((ip[1] as number) & 0x0f) === 0x02;
}

/** ValidateEndpointIP (net.IP.IsUnspecified, IsLoopback, IsLinkLocalUnicast, IsLinkLocalMulticast). */
export function validateEndpointIP(ipAddress: string, path: Path): FieldError[] {
  const ip = parseIPSloppy(ipAddress);
  if (!ip) return [invalid(path, ipAddress, 'must be a valid IP address')];
  const errs: FieldError[] = [];
  if (isUnspecified(ip)) errs.push(invalid(path, ipAddress, `may not be unspecified (${ipAddress})`));
  if (isLoopback(ip)) errs.push(invalid(path, ipAddress, 'may not be in the loopback range (127.0.0.0/8, ::1/128)'));
  if (isLinkLocalUnicast(ip)) errs.push(invalid(path, ipAddress, 'may not be in the link-local range (169.254.0.0/16, fe80::/10)'));
  if (isLinkLocalMulticast(ip)) errs.push(invalid(path, ipAddress, 'may not be in the link-local multicast range (224.0.0.0/24, ff02::/10)'));
  return errs;
}

function validateEndpointAddress(address: JsonObject, path: Path): FieldError[] {
  const ip = str(address.ip);
  const errs = isValidIPForLegacyField(path.child('ip'), ip);
  const hostname = str(address.hostname);
  if (hostname !== '') errs.push(...validateDNS1123Label(hostname, path.child('hostname')));
  if (isSet(address.nodeName)) {
    const nodeName = str(address.nodeName);
    for (const m of validateNodeName(nodeName)) errs.push(invalid(path.child('nodeName'), nodeName, m));
  }
  errs.push(...validateEndpointIP(ip, path.child('ip')));
  return errs;
}

function validateEndpointPort(port: JsonObject, requireName: boolean, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const name = str(port.name);
  if (requireName && name === '') errs.push(required(path.child('name')));
  else if (name !== '') errs.push(...validateDNS1123Label(name, path.child('name')));
  for (const m of isValidPortNum(num(port.port))) errs.push(invalid(path.child('port'), num(port.port), m));
  const protocol = str(port.protocol);
  if (protocol === '') errs.push(required(path.child('protocol')));
  else if (!SUPPORTED_PORT_PROTOCOLS.includes(protocol)) errs.push(notSupported(path.child('protocol'), protocol, SUPPORTED_PORT_PROTOCOLS));
  if (isSet(port.appProtocol)) errs.push(...validateQualifiedName(str(port.appProtocol), path.child('appProtocol')));
  return errs;
}

function validateEndpointSubsets(subsets: JsonObject[], path: Path): FieldError[] {
  const errs: FieldError[] = [];
  subsets.forEach((ss, i) => {
    const idx = path.index(i);
    const addresses = objs(ss.addresses);
    const notReady = objs(ss.notReadyAddresses);
    if (addresses.length === 0 && notReady.length === 0) errs.push(required(idx, 'must specify `addresses` or `notReadyAddresses`'));
    addresses.forEach((a, j) => errs.push(...validateEndpointAddress(a, idx.child('addresses').index(j))));
    notReady.forEach((a, j) => errs.push(...validateEndpointAddress(a, idx.child('notReadyAddresses').index(j))));
    const ports = objs(ss.ports);
    ports.forEach((p, j) => errs.push(...validateEndpointPort(p, ports.length > 1, idx.child('ports').index(j))));
  });
  return errs;
}

/** ValidateEndpoints; `old` on update (unchanged subsets are not revalidated). */
function validateEndpoints(ep: JsonObject, old: JsonObject | undefined): FieldError[] {
  const errs = validateObjectMeta(ep.metadata as JsonObject, true, nameIsDNSSubdomain, newPath('metadata'));
  let subsetErrs = validateEndpointSubsets(objs(ep.subsets), newPath('subsets'));
  if (subsetErrs.length > 0 && old && jsonEqual(old.subsets ?? null, ep.subsets ?? null)) subsetErrs = [];
  return [...errs, ...subsetErrs];
}

export const validateEndpointsCreate = (ep: JsonObject): FieldError[] => validateEndpoints(ep, undefined);

export function validateEndpointsUpdate(ep: JsonObject, old: JsonObject): FieldError[] {
  return [...validateObjectMetaUpdate(ep.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata')), ...validateEndpoints(ep, old)];
}
