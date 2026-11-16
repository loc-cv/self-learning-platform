// Service validation and warnings.
// upstream: pkg/apis/core/validation/validation.go validateService, validateServicePort,
// validateServiceExternalTrafficPolicy, validateServiceExternalTrafficFieldsUpdate,
// validateServiceInternalTrafficFieldsValue, validateServiceTrafficDistribution,
// ValidateServiceCreate, ValidateServiceUpdate, ValidateServiceStatusUpdate,
// ValidateServiceClusterIPsRelatedFields, validateUpgradeDowngradeClusterIPs,
// validateUpgradeDowngradeIPFamilies, isHeadlessService, validateLoadBalancerClassField,
// validateClientIPAffinityConfig, validateAffinityTimeout, ValidatePortNumOrName,
// ValidateLoadBalancerStatus. The declarative validation of Service covers ObjectMeta only.
// Feature gates (GA, locked on in v1.37.2: absent from kube-apiserver --help):
// RelaxedServiceNameValidation (names are DNS-1123 labels; checked against the v1.37.2 oracle:
// a Service named "1svc-dry" is accepted), PreferSameTrafficDistribution.
// Warnings: pkg/api/service/warnings.go GetWarningsForService, isHeadlessService (first written
// from oracle probes, then checked against the source).

import { duplicate, forbidden, invalid, newPath, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { goJson, type JsonObject } from '../../../apimachinery/json.ts';
import { parseIPSloppy, to4 } from '../../../apimachinery/net.ts';
import { getWarningsForCIDR, getWarningsForIP, isValidCIDRForLegacyField, isValidIPForLegacyField } from '../../../apimachinery/validation/ip.ts';
import { isDNS1123Subdomain, isValidPortName, isValidPortNum, nameIsDNSLabel } from '../../../apimachinery/validation/names.ts';
import { validateLabels } from '../../../apimachinery/validation/objectmeta.ts';
import { externallyAccessible, needsHealthCheck } from '../v1/defaults/service.ts';
import { SUPPORTED_PORT_PROTOCOLS, validateEndpointIP } from './endpoints.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';
import { isSet, num, obj, objs, str, strMap, strs, validateDNS1123Label, validateQualifiedName } from './util.ts';

const SUPPORTED_SESSION_AFFINITY = ['ClientIP', 'None'];
const SUPPORTED_SERVICE_TYPES = ['ClusterIP', 'ExternalName', 'LoadBalancer', 'NodePort'];
const SUPPORTED_INTERNAL_TRAFFIC_POLICY = ['Cluster', 'Local'];
const SUPPORTED_EXTERNAL_TRAFFIC_POLICY = ['Cluster', 'Local'];
const SUPPORTED_IP_FAMILIES = ['IPv4', 'IPv6'];
const SUPPORTED_IP_FAMILY_POLICIES = ['PreferDualStack', 'RequireDualStack', 'SingleStack'];
const SUPPORTED_LOAD_BALANCER_IP_MODES = ['Proxy', 'VIP'];
/** With PreferSameTrafficDistribution on, in upstream's order (not sorted). */
const SUPPORTED_TRAFFIC_DISTRIBUTION = ['PreferClose', 'PreferSameZone', 'PreferSameNode'];
/** core.MaxClientIPServiceAffinitySeconds (1 day). */
const MAX_CLIENT_IP_SERVICE_AFFINITY_SECONDS = 86400;

const ANNOTATION_TOPOLOGY_AWARE_HINTS = 'service.kubernetes.io/topology-aware-hints';
const ANNOTATION_TOPOLOGY_MODE = 'service.kubernetes.io/topology-mode';
const ANNOTATION_LB_SOURCE_RANGES = 'service.beta.kubernetes.io/load-balancer-source-ranges';

export const specOf = (svc: JsonObject): JsonObject => obj(svc.spec) ?? {};
const annotationsOf = (svc: JsonObject): Record<string, string> => strMap(obj(svc.metadata)?.annotations);
/** A pointer field read as Go renders it in an error: the value, or null when nil. */
const ptrStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** netutils.IsIPv6String / IsIPv4String. */
export const isIPv6String = (ip: string): boolean => {
  const p = parseIPSloppy(ip);
  return p !== undefined && to4(p) === undefined;
};
export const isIPv4String = (ip: string): boolean => {
  const p = parseIPSloppy(ip);
  return p !== undefined && to4(p) !== undefined;
};

/** isHeadlessService: clusterIPs is exactly ["None"]. */
export function isHeadlessService(spec: JsonObject): boolean {
  const ips = strs(spec.clusterIPs);
  return ips.length === 1 && ips[0] === 'None';
}

/** ValidatePortNumOrName. */
export function validatePortNumOrName(port: unknown, path: Path): FieldError[] {
  if (typeof port === 'string') return isValidPortName(port).map((m) => invalid(path, port, m));
  const n = typeof port === 'number' ? port : 0;
  return isValidPortNum(n).map((m) => invalid(path, n, m));
}

function validateServicePort(sp: JsonObject, requireName: boolean, allNames: Set<string>, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const name = str(sp.name);
  if (requireName && name === '') errs.push(required(path.child('name')));
  else if (name !== '') {
    errs.push(...validateDNS1123Label(name, path.child('name')));
    if (allNames.has(name)) errs.push(duplicate(path.child('name'), name));
    else allNames.add(name);
  }
  for (const m of isValidPortNum(num(sp.port))) errs.push(invalid(path.child('port'), num(sp.port), m));
  const protocol = str(sp.protocol);
  if (protocol === '') errs.push(required(path.child('protocol')));
  else if (!SUPPORTED_PORT_PROTOCOLS.includes(protocol)) errs.push(notSupported(path.child('protocol'), protocol, SUPPORTED_PORT_PROTOCOLS));
  errs.push(...validatePortNumOrName(sp.targetPort, path.child('targetPort')));
  if (isSet(sp.appProtocol)) errs.push(...validateQualifiedName(str(sp.appProtocol), path.child('appProtocol')));
  return errs;
}

function validateClientIPAffinityConfig(config: JsonObject | undefined, path: Path): FieldError[] {
  const when = 'when session affinity type is ClientIP';
  if (!config) return [required(path, when)];
  const clientIP = obj(config.clientIP);
  if (!clientIP) return [required(path.child('clientIP'), when)];
  if (!isSet(clientIP.timeoutSeconds)) return [required(path.child('clientIP').child('timeoutSeconds'), when)];
  const t = num(clientIP.timeoutSeconds);
  if (t <= 0 || t > MAX_CLIENT_IP_SERVICE_AFFINITY_SECONDS) {
    return [invalid(path.child('clientIP').child('timeoutSeconds'), t, `must be greater than 0 and less than ${MAX_CLIENT_IP_SERVICE_AFFINITY_SECONDS}`)];
  }
  return [];
}

/** ValidateServiceClusterIPsRelatedFields (also the allocator's pre-validation). */
export function validateServiceClusterIPsRelatedFields(svc: JsonObject, old: JsonObject | undefined): FieldError[] {
  const spec = specOf(svc);
  if (str(spec.type) === 'ExternalName') return [];
  const errs: FieldError[] = [];
  let hasInvalidIPs = false;
  const clusterIPsField = newPath('spec', 'clusterIPs');
  const ipFamiliesField = newPath('spec', 'ipFamilies');
  const clusterIP = str(spec.clusterIP);
  const clusterIPs = strs(spec.clusterIPs);
  const families = strs(spec.ipFamilies);
  const ipsValue = Array.isArray(spec.clusterIPs) ? clusterIPs : null;
  if (clusterIP !== '') {
    if (clusterIPs.length === 0) errs.push(required(clusterIPsField));
    else if (clusterIPs[0] !== clusterIP) errs.push(invalid(clusterIPsField, ipsValue, 'first value must match `clusterIP`'));
  } else if (clusterIPs.length !== 0) {
    errs.push(invalid(clusterIPsField, ipsValue, 'must be empty when `clusterIP` is not specified'));
  }
  const seen = new Set<string>();
  families.forEach((f, i) => {
    if (!SUPPORTED_IP_FAMILIES.includes(f)) errs.push(notSupported(ipFamiliesField.index(i), f, SUPPORTED_IP_FAMILIES));
    if (seen.has(f)) errs.push(duplicate(ipFamiliesField.index(i), f));
    seen.add(f);
  });
  const policy = ptrStr(spec.ipFamilyPolicy);
  if (policy !== undefined && !SUPPORTED_IP_FAMILY_POLICIES.includes(policy)) {
    errs.push(notSupported(newPath('spec', 'ipFamilyPolicy'), policy, SUPPORTED_IP_FAMILY_POLICIES));
  }
  const existing = old ? strs(specOf(old).clusterIPs) : [];
  clusterIPs.forEach((ip, i) => {
    if (i === 0 && ip === 'None') {
      if (clusterIPs.length > 1) {
        hasInvalidIPs = true;
        errs.push(invalid(clusterIPsField, ipsValue, "'None' must be the first and only value"));
      }
      return;
    }
    const e = isValidIPForLegacyField(clusterIPsField.index(i), ip, existing);
    if (e.length > 0) hasInvalidIPs = true;
    errs.push(...e);
  });
  if (clusterIPs.length > 2) errs.push(invalid(clusterIPsField, ipsValue, 'may only hold up to 2 values'));
  if (hasInvalidIPs) return errs;
  if (clusterIPs.length > 1) {
    // netutils.IsDualStackIPStrings: one IPv4 and one IPv6.
    const v6 = clusterIPs.filter(isIPv6String).length;
    const dualStack = v6 > 0 && v6 < clusterIPs.length;
    if (!dualStack) errs.push(invalid(clusterIPsField, ipsValue, 'may specify no more than one IP for each IP family'));
  }
  if (!isHeadlessService(spec) && clusterIPs.length > 0 && families.length > 0) {
    for (const [i, ip] of clusterIPs.entries()) {
      if (i > families.length - 1) break;
      if (families[i] === 'IPv4' && isIPv6String(ip)) errs.push(invalid(clusterIPsField.index(i), ip, `expected an IPv4 value as indicated by \`ipFamilies[${i}]\``));
      if (families[i] === 'IPv6' && !isIPv6String(ip)) errs.push(invalid(clusterIPsField.index(i), ip, `expected an IPv6 value as indicated by \`ipFamilies[${i}]\``));
    }
  }
  return errs;
}

function validateLoadBalancerClassField(old: JsonObject | undefined, svc: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  const spec = specOf(svc);
  const cls = ptrStr(spec.loadBalancerClass);
  const isLB = str(spec.type) === 'LoadBalancer';
  if (old) {
    const ospec = specOf(old);
    if (str(ospec.type) === 'LoadBalancer' && isLB && ptrStr(ospec.loadBalancerClass) !== cls) {
      errs.push(invalid(newPath('spec', 'loadBalancerClass'), cls, 'may not change once set'));
    }
  }
  if (isLB) {
    if (cls !== undefined) errs.push(...validateQualifiedName(cls, newPath('spec', 'loadBalancerClass')));
  } else if (cls !== undefined) {
    errs.push(forbidden(newPath('spec', 'loadBalancerClass'), "may only be used when `type` is 'LoadBalancer'"));
  }
  return errs;
}

function validateServiceExternalTrafficPolicy(spec: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  const etp = str(spec.externalTrafficPolicy);
  const path = newPath('spec', 'externalTrafficPolicy');
  if (!externallyAccessible(spec)) {
    if (etp !== '') errs.push(invalid(path, etp, 'may only be set for externally-accessible services'));
  } else if (etp === '') errs.push(required(path));
  else if (!SUPPORTED_EXTERNAL_TRAFFIC_POLICY.includes(etp)) errs.push(notSupported(path, etp, SUPPORTED_EXTERNAL_TRAFFIC_POLICY));
  const hc = num(spec.healthCheckNodePort);
  const hcPath = newPath('spec', 'healthCheckNodePort');
  if (!needsHealthCheck(spec)) {
    if (hc !== 0) errs.push(invalid(hcPath, hc, "may only be set when `type` is 'LoadBalancer' and `externalTrafficPolicy` is 'Local'"));
  } else if (hc === 0) errs.push(required(hcPath));
  else for (const m of isValidPortNum(hc)) errs.push(invalid(hcPath, hc, m));
  return errs;
}

function validateServiceInternalTrafficFieldsValue(spec: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  const itp = ptrStr(spec.internalTrafficPolicy);
  const type = str(spec.type);
  if (itp === undefined && (type === 'NodePort' || type === 'LoadBalancer' || type === 'ClusterIP')) errs.push(required(newPath('spec', 'internalTrafficPolicy')));
  if (itp !== undefined && !SUPPORTED_INTERNAL_TRAFFIC_POLICY.includes(itp)) errs.push(notSupported(newPath('spec', 'internalTrafficPolicy'), itp, SUPPORTED_INTERNAL_TRAFFIC_POLICY));
  return errs;
}

function validateServiceTrafficDistribution(spec: JsonObject): FieldError[] {
  const td = ptrStr(spec.trafficDistribution);
  if (td === undefined || SUPPORTED_TRAFFIC_DISTRIBUTION.includes(td)) return [];
  return [notSupported(newPath('spec', 'trafficDistribution'), td, SUPPORTED_TRAFFIC_DISTRIBUTION)];
}

/** The internal core.ServicePort{Protocol, Port} as the duplicate-port error prints it (json.Marshal, Go field names). */
const internalServicePortKey = (protocol: string, port: number): { go: string } => ({
  go: `{"Name":"","Protocol":${goJson(protocol)},"AppProtocol":null,"Port":${port},"TargetPort":0,"NodePort":0}`,
});

/** validateService: everything but ObjectMeta. */
function validateService(svc: JsonObject, old: JsonObject | undefined): FieldError[] {
  const errs: FieldError[] = [];
  const spec = specOf(svc);
  const annotations = annotationsOf(svc);
  const metaPath = newPath('metadata');
  if (ANNOTATION_TOPOLOGY_MODE in annotations && ANNOTATION_TOPOLOGY_AWARE_HINTS in annotations && annotations[ANNOTATION_TOPOLOGY_MODE] !== annotations[ANNOTATION_TOPOLOGY_AWARE_HINTS]) {
    errs.push(invalid(metaPath.child('annotations').key(ANNOTATION_TOPOLOGY_MODE), annotations[ANNOTATION_TOPOLOGY_MODE], `must match annotations[${ANNOTATION_TOPOLOGY_AWARE_HINTS}] when both are specified`));
  }
  const specPath = newPath('spec');
  const type = str(spec.type);
  const ports = objs(spec.ports);
  const headless = isHeadlessService(spec);
  const clusterIPs = strs(spec.clusterIPs);
  if (ports.length === 0 && !headless && type !== 'ExternalName') errs.push(required(specPath.child('ports')));
  switch (type) {
    case 'LoadBalancer':
      if (headless) errs.push(invalid(specPath.child('clusterIPs').index(0), clusterIPs[0], "may not be set to 'None' for LoadBalancer services"));
      break;
    case 'NodePort':
      if (headless) errs.push(invalid(specPath.child('clusterIPs').index(0), clusterIPs[0], "may not be set to 'None' for NodePort services"));
      break;
    case 'ExternalName': {
      if (clusterIPs.length > 0) errs.push(forbidden(specPath.child('clusterIPs'), 'may not be set for ExternalName services'));
      if (strs(spec.ipFamilies).length > 0) errs.push(forbidden(specPath.child('ipFamilies'), 'may not be set for ExternalName services'));
      if (isSet(spec.ipFamilyPolicy)) errs.push(forbidden(specPath.child('ipFamilyPolicy'), 'may not be set for ExternalName services'));
      // The value (a CNAME) may have a trailing dot to denote it as fully qualified.
      const name = str(spec.externalName);
      const cname = name.endsWith('.') ? name.slice(0, -1) : name;
      if (cname.length > 0) for (const m of isDNS1123Subdomain(cname)) errs.push(invalid(specPath.child('externalName'), cname, m));
      else errs.push(required(specPath.child('externalName')));
      break;
    }
  }
  const allPortNames = new Set<string>();
  ports.forEach((p, i) => errs.push(...validateServicePort(p, ports.length > 1, allPortNames, specPath.child('ports').index(i))));
  if (isSet(spec.selector)) errs.push(...validateLabels(strMap(spec.selector), specPath.child('selector')));
  const affinity = str(spec.sessionAffinity);
  if (affinity === '') errs.push(required(specPath.child('sessionAffinity')));
  else if (!SUPPORTED_SESSION_AFFINITY.includes(affinity)) errs.push(notSupported(specPath.child('sessionAffinity'), affinity, SUPPORTED_SESSION_AFFINITY));
  if (affinity === 'ClientIP') errs.push(...validateClientIPAffinityConfig(obj(spec.sessionAffinityConfig), specPath.child('sessionAffinityConfig')));
  else if (affinity === 'None' && isSet(spec.sessionAffinityConfig)) errs.push(forbidden(specPath.child('sessionAffinityConfig'), 'must not be set when session affinity is None'));
  errs.push(...validateServiceClusterIPsRelatedFields(svc, old));
  // New external IPs must be valid and "non-special"; existing ones are accepted as they are.
  const existingExternalIPs = old ? strs(specOf(old).externalIPs) : [];
  strs(spec.externalIPs).forEach((ip, i) => {
    const p = specPath.child('externalIPs').index(i);
    const e = isValidIPForLegacyField(p, ip, existingExternalIPs);
    errs.push(...(e.length > 0 ? e : validateEndpointIP(ip, p)));
  });
  if (type === '') errs.push(required(specPath.child('type')));
  else if (!SUPPORTED_SERVICE_TYPES.includes(type)) errs.push(notSupported(specPath.child('type'), type, SUPPORTED_SERVICE_TYPES));
  if (type === 'ClusterIP') {
    ports.forEach((p, i) => {
      if (num(p.nodePort) !== 0) errs.push(forbidden(specPath.child('ports').index(i).child('nodePort'), "may not be used when `type` is 'ClusterIP'"));
    });
  }
  // Duplicate NodePorts, per (protocol, nodePort).
  const nodePorts = new Set<string>();
  ports.forEach((p, i) => {
    const np = num(p.nodePort);
    if (np === 0) return;
    const key = `${str(p.protocol)}/${np}`;
    if (nodePorts.has(key)) errs.push(duplicate(specPath.child('ports').index(i).child('nodePort'), np));
    nodePorts.add(key);
  });
  // Duplicate ports, per (protocol, port).
  const seenPorts = new Set<string>();
  ports.forEach((p, i) => {
    const key = `${str(p.protocol)}/${num(p.port)}`;
    if (seenPorts.has(key)) errs.push(duplicate(specPath.child('ports').index(i), internalServicePortKey(str(p.protocol), num(p.port))));
    seenPorts.add(key);
  });
  const sourceRanges = strs(spec.loadBalancerSourceRanges);
  if (sourceRanges.length > 0) {
    // upstream spells this path with a capital L.
    const fieldPath = specPath.child('LoadBalancerSourceRanges');
    if (type !== 'LoadBalancer') errs.push(forbidden(fieldPath, "may only be used when `type` is 'LoadBalancer'"));
    const existing = old ? strs(specOf(old).loadBalancerSourceRanges).map((v) => v.trim()) : [];
    sourceRanges.forEach((v, i) => errs.push(...isValidCIDRForLegacyField(fieldPath.index(i), v.trim(), existing)));
  } else if (ANNOTATION_LB_SOURCE_RANGES in annotations) {
    const fieldPath = newPath('metadata', 'annotations').key(ANNOTATION_LB_SOURCE_RANGES);
    if (type !== 'LoadBalancer') errs.push(forbidden(fieldPath, "may only be used when `type` is 'LoadBalancer'"));
    const val = annotations[ANNOTATION_LB_SOURCE_RANGES] as string;
    if (!old || annotationsOf(old)[ANNOTATION_LB_SOURCE_RANGES] !== val) {
      const trimmed = val.trim();
      if (trimmed !== '') for (const v of trimmed.split(',')) errs.push(...isValidCIDRForLegacyField(fieldPath, v.trim()));
    }
  }
  if (isSet(spec.allocateLoadBalancerNodePorts) && type !== 'LoadBalancer') {
    errs.push(forbidden(specPath.child('allocateLoadBalancerNodePorts'), "may only be used when `type` is 'LoadBalancer'"));
  }
  // upstream reports this one without the `spec.` prefix.
  if (type === 'LoadBalancer' && !isSet(spec.allocateLoadBalancerNodePorts)) errs.push(required(newPath('allocateLoadBalancerNodePorts')));
  errs.push(...validateLoadBalancerClassField(undefined, svc));
  errs.push(...validateServiceExternalTrafficPolicy(spec));
  errs.push(...validateServiceInternalTrafficFieldsValue(spec));
  errs.push(...validateServiceTrafficDistribution(spec));
  return errs;
}

/** ValidateServiceCreate (RelaxedServiceNameValidation: NameIsDNSLabel). */
export function validateServiceCreate(svc: JsonObject): FieldError[] {
  return [...validateObjectMeta(svc.metadata as JsonObject, true, nameIsDNSLabel, newPath('metadata')), ...validateService(svc, undefined)];
}

function validateUpgradeDowngradeClusterIPs(old: JsonObject, svc: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  const spec = specOf(svc);
  const ospec = specOf(old);
  if (str(spec.type) === 'ExternalName' || str(ospec.type) === 'ExternalName') return errs;
  if (isHeadlessService(ospec) && isHeadlessService(spec)) return errs;
  const oldIPs = strs(ospec.clusterIPs);
  const newIPs = strs(spec.clusterIPs);
  const value = Array.isArray(spec.clusterIPs) ? newIPs : null;
  const ip0 = newPath('spec', 'clusterIPs').index(0);
  if (oldIPs.length === newIPs.length) {
    oldIPs.forEach((ip, i) => {
      if (ip !== newIPs[i]) errs.push(invalid(newPath('spec', 'clusterIPs').index(i), value, 'may not change once set'));
    });
  } else if (oldIPs.length > newIPs.length) {
    if (newIPs.length === 0) errs.push(invalid(ip0, value, 'primary clusterIP can not be unset'));
    if (oldIPs.length > 0 && newIPs.length > 0 && newIPs[0] !== oldIPs[0]) errs.push(invalid(ip0, value, 'may not change once set'));
    if (newIPs.length === 1 && ptrStr(spec.ipFamilyPolicy) !== 'SingleStack') {
      errs.push(invalid(newPath('spec', 'ipFamilyPolicy'), ptrStr(spec.ipFamilyPolicy), "must be set to 'SingleStack' when releasing the secondary clusterIP"));
    }
  } else if (oldIPs.length > 0 && newIPs[0] !== oldIPs[0]) {
    errs.push(invalid(ip0, value, 'may not change once set'));
  }
  return errs;
}

function validateUpgradeDowngradeIPFamilies(old: JsonObject, svc: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  const spec = specOf(svc);
  const ospec = specOf(old);
  if (str(spec.type) === 'ExternalName' || str(ospec.type) === 'ExternalName') return errs;
  const oldHeadless = isHeadlessService(ospec);
  const newHeadless = isHeadlessService(spec);
  if (newHeadless !== oldHeadless || newHeadless) return errs;
  const oldF = strs(ospec.ipFamilies);
  const newF = strs(spec.ipFamilies);
  const famValue = Array.isArray(spec.ipFamilies) ? newF : null;
  const ipsValue = Array.isArray(spec.clusterIPs) ? strs(spec.clusterIPs) : null;
  const f0 = newPath('spec', 'ipFamilies').index(0);
  if (oldF.length === newF.length) {
    oldF.forEach((f, i) => {
      if (f !== newF[i]) errs.push(invalid(f0, famValue, 'may not change once set'));
    });
  } else if (oldF.length > newF.length) {
    if (strs(spec.clusterIPs).length === 0) errs.push(invalid(f0, famValue, 'primary ipFamily can not be unset'));
    if (newF.length > 0 && newF[0] !== oldF[0]) errs.push(invalid(f0, ipsValue, 'may not change once set'));
    if (newF.length === 1 && ptrStr(spec.ipFamilyPolicy) !== 'SingleStack') {
      errs.push(invalid(newPath('spec', 'ipFamilyPolicy'), ptrStr(spec.ipFamilyPolicy), "must be set to 'SingleStack' when releasing the secondary ipFamily"));
    }
  } else if (oldF.length > 0 && newF.length > 0 && newF[0] !== oldF[0]) {
    errs.push(invalid(f0, ipsValue, 'may not change once set'));
  }
  return errs;
}

/** ValidateServiceUpdate. */
export function validateServiceUpdate(svc: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(svc.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata'));
  errs.push(...validateUpgradeDowngradeClusterIPs(old, svc));
  errs.push(...validateUpgradeDowngradeIPFamilies(old, svc));
  errs.push(...validateLoadBalancerClassField(old, svc));
  // validateServiceExternalTrafficFieldsUpdate
  if (needsHealthCheck(specOf(old)) && needsHealthCheck(specOf(svc)) && num(specOf(svc).healthCheckNodePort) !== num(specOf(old).healthCheckNodePort)) {
    errs.push(forbidden(newPath('spec', 'healthCheckNodePort'), 'field is immutable'));
  }
  return [...errs, ...validateService(svc, old)];
}

/** ValidateLoadBalancerStatus. */
function validateLoadBalancerStatus(status: JsonObject, oldStatus: JsonObject, path: Path, spec: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  const ingrPath = path.child('ingress');
  const ingress = objs(status.ingress);
  if (str(spec.type) !== 'LoadBalancer' && ingress.length !== 0) return [forbidden(ingrPath, "may only be used when `spec.type` is 'LoadBalancer'")];
  const existing = objs(oldStatus.ingress).map((i) => str(i.ip)).filter((ip) => ip !== '');
  ingress.forEach((ing, i) => {
    const idx = ingrPath.index(i);
    const ip = str(ing.ip);
    if (ip !== '') errs.push(...isValidIPForLegacyField(idx.child('ip'), ip, existing));
    const mode = ptrStr(ing.ipMode);
    if (mode === undefined) {
      if (ip !== '') errs.push(required(idx.child('ipMode'), 'must be specified when `ip` is set'));
    } else if (ip === '') errs.push(forbidden(idx.child('ipMode'), 'may not be specified when `ip` is not set'));
    else if (!SUPPORTED_LOAD_BALANCER_IP_MODES.includes(mode)) errs.push(notSupported(idx.child('ipMode'), mode, SUPPORTED_LOAD_BALANCER_IP_MODES));
    const hostname = str(ing.hostname);
    if (hostname !== '') {
      for (const m of isDNS1123Subdomain(hostname)) errs.push(invalid(idx.child('hostname'), hostname, m));
      if (parseIPSloppy(hostname)) errs.push(invalid(idx.child('hostname'), hostname, 'must be a DNS name, not an IP address'));
    }
  });
  return errs;
}

const lbStatusOf = (svc: JsonObject): JsonObject => obj(obj(svc.status)?.loadBalancer) ?? {};

/** ValidateServiceStatusUpdate. */
export function validateServiceStatusUpdate(svc: JsonObject, old: JsonObject): FieldError[] {
  return [
    ...validateObjectMetaUpdate(svc.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata')),
    ...validateLoadBalancerStatus(lbStatusOf(svc), lbStatusOf(old), newPath('status', 'loadBalancer'), specOf(svc)),
  ];
}

/** serviceStatusStrategy.WarningsOnUpdate: GetWarningsForIP of every ingress IP. */
export function serviceStatusWarnings(svc: JsonObject): string[] {
  const path = newPath('status', 'loadBalancer', 'ingress');
  return objs(lbStatusOf(svc).ingress).flatMap((ing, i) => (str(ing.ip) !== '' ? getWarningsForIP(path.index(i), str(ing.ip)) : []));
}

/**
 * upstream: pkg/api/service/warnings.go isHeadlessService, which differs from validation's (type
 * ClusterIP and spec.clusterIP None, not spec.clusterIPs).
 */
function isHeadlessForWarnings(spec: JsonObject): boolean {
  return str(spec.type) === 'ClusterIP' && str(spec.clusterIP) === 'None';
}

/**
 * GetWarningsForService (upstream: pkg/api/service/warnings.go), in its order: the deprecated
 * topology annotation; the cluster IPs (helper.IsServiceIPSet); for a headless Service,
 * loadBalancerIP, externalIPs and session affinity being ignored; each external IP; external IPs
 * being deprecated (neither headless nor ExternalName); loadBalancerIP; each source range;
 * external IPs on an ExternalName Service; externalName on another type; trafficDistribution
 * PreferClose. Also checked against the v1.37.2 oracle.
 */
export function getWarningsForService(svc: JsonObject): string[] {
  const w: string[] = [];
  const spec = specOf(svc);
  const specPath = newPath('spec');
  if (ANNOTATION_TOPOLOGY_AWARE_HINTS in annotationsOf(svc)) {
    w.push(`annotation ${ANNOTATION_TOPOLOGY_AWARE_HINTS} is deprecated, please use ${ANNOTATION_TOPOLOGY_MODE} instead`);
  }
  const clusterIP = str(spec.clusterIP);
  if (clusterIP !== 'None' && clusterIP !== '') {
    strs(spec.clusterIPs).forEach((ip, i) => w.push(...getWarningsForIP(specPath.child('clusterIPs').index(i), ip)));
  }
  const headless = isHeadlessForWarnings(spec);
  const externalIPs = strs(spec.externalIPs);
  const lbIP = str(spec.loadBalancerIP);
  if (headless) {
    if (lbIP !== '') w.push('spec.loadBalancerIP is ignored for headless services');
    if (externalIPs.length > 0) w.push('spec.externalIPs is ignored for headless services');
    if (str(spec.sessionAffinity) !== 'None') w.push('spec.SessionAffinity is ignored for headless services');
  }
  const type = str(spec.type);
  externalIPs.forEach((ip, i) => w.push(...getWarningsForIP(specPath.child('externalIPs').index(i), ip)));
  if (externalIPs.length > 0 && !headless && type !== 'ExternalName') w.push('spec.externalIPs is deprecated and may no longer be implemented in some clusters');
  if (lbIP !== '') w.push(...getWarningsForIP(specPath.child('loadBalancerIP'), lbIP));
  strs(spec.loadBalancerSourceRanges).forEach((c, i) => w.push(...getWarningsForCIDR(specPath.child('loadBalancerSourceRanges').index(i), c)));
  if (type === 'ExternalName' && externalIPs.length > 0) w.push('spec.externalIPs is ignored when spec.type is "ExternalName"');
  if (type !== 'ExternalName' && str(spec.externalName) !== '') w.push('spec.externalName is ignored when spec.type is not "ExternalName"');
  if (ptrStr(spec.trafficDistribution) === 'PreferClose') w.push('spec.trafficDistribution: "PreferClose" is deprecated; use "PreferSameZone"');
  return w;
}
