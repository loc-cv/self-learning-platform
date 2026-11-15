// Service storage: IP family defaulting, ClusterIP and NodePort allocation, and the linked-field
// fix-ups of the REST storage.
// upstream: pkg/registry/core/service/storage/alloc.go (allocateCreate, initIPFamilyFields,
// allocClusterIPs, allocIPs, txnAllocNodePorts, initNodePorts, allocHealthCheckNodePort,
// allocateUpdate, updateClusterIPs, txnUpdateNodePorts, updateNodePorts,
// updateHealthCheckNodePort, releaseAllocatedResources, isMatchingPreferDualStackClusterIPFields,
// shouldAllocateNodePorts), storage.go (beginCreate, beginUpdate, afterDelete, defaultOnReadService,
// defaultOnReadIPFamilies, defaultOnReadInternalTrafficPolicy, normalizeClusterIPs,
// patchAllocatedValues, needsClusterIP, needsNodePort, needsHCNodePort).
//
// Upstream allocates in BeginCreate/BeginUpdate, before PrepareForCreate and validation, and
// reverts when a later step fails. Here the strategy's validate plans the allocation on the object
// (choosing addresses and ports, consuming randomness, writing nothing) and returns its errors
// alone, as BeginCreate would; beforePersist then writes what was planned (IPAddress objects,
// the NodePort RangeAllocation) and afterDelete releases it. Two differences remain: a full range
// is reported after validation (it is an internal error, which validate cannot return), and on
// update the planning runs after PrepareForUpdate (its type-dependent field drops) instead of before.

import { invalid, newPath, type FieldError } from '../../apimachinery/field.ts';
import { cloneJson, isObject, type JsonObject } from '../../apimachinery/json.ts';
import { internalError, type Status } from '../../apimachinery/errors.ts';
import type { StrategyCtx } from '../../apiserver/types.ts';
import { needsHealthCheck } from '../../apis/core/v1/defaults/service.ts';
import { isIPv6String, validateServiceClusterIPsRelatedFields } from '../../apis/core/validation/service.ts';
import { allocateNext, checkAllocate, configuredFamilies, createIPAddress, familyOf, releaseIP, type IPFamily } from './service-ipallocator.ts';
import { commitPorts, opAllocate, opAllocateNext, startPortOp, type PortOp } from './service-portallocator.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);
const ports = (spec: JsonObject): JsonObject[] => (Array.isArray(spec.ports) ? spec.ports.filter(isObject) : []);
export const specOf = (svc: JsonObject): JsonObject => {
  if (!isObject(svc.spec)) svc.spec = {};
  return svc.spec as JsonObject;
};
const nameOf = (svc: JsonObject): string => str(isObject(svc.metadata) ? svc.metadata.name : undefined);
const namespaceOf = (svc: JsonObject): string => str(isObject(svc.metadata) ? svc.metadata.namespace : undefined);

/** Sets a []string field; nil (absent) when empty, as omitempty encodes it. */
function setList(spec: JsonObject, key: string, list: readonly string[] | undefined): void {
  if (list === undefined || list.length === 0) delete spec[key];
  else spec[key] = [...list];
}

const policyOf = (spec: JsonObject): string => str(spec.ipFamilyPolicy);
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const needsClusterIP = (spec: JsonObject): boolean => str(spec.type) !== 'ExternalName';
export function needsNodePort(spec: JsonObject): boolean {
  const type = str(spec.type);
  return type === 'NodePort' || (type === 'LoadBalancer' && spec.allocateLoadBalancerNodePorts !== false);
}
const needsHCNodePort = (spec: JsonObject): boolean => str(spec.type) === 'LoadBalancer' && str(spec.externalTrafficPolicy) === 'Local';
function shouldAllocateNodePorts(spec: JsonObject): boolean {
  const type = str(spec.type);
  if (type === 'NodePort') return true;
  // *AllocateLoadBalancerNodePorts: defaulting always sets it for LoadBalancer.
  if (type === 'LoadBalancer') return spec.allocateLoadBalancerNodePorts !== false;
  return false;
}
const collectNodePorts = (spec: JsonObject): number[] => ports(spec).map((p) => num(p.nodePort)).filter((n) => n !== 0);

// ---- storage.go fix-ups ----

/** normalizeClusterIPs: keep clusterIP and clusterIPs in step (`old` on update). */
export function normalizeClusterIPs(spec: JsonObject, old: JsonObject | undefined): void {
  const clusterIP = str(spec.clusterIP);
  if (!old) {
    if (clusterIP !== '' && strs(spec.clusterIPs).length === 0) spec.clusterIPs = [clusterIP];
    return;
  }
  const oldIPs = strs(old.clusterIPs);
  if (oldIPs.length > 0 && strs(spec.clusterIPs).length === 0 && str(old.clusterIP) === clusterIP) setList(spec, 'clusterIPs', oldIPs);
  if (str(old.clusterIP) !== clusterIP) {
    if (str(old.clusterIP) !== '' && clusterIP === '') {
      if (sameList(oldIPs, strs(spec.clusterIPs))) delete spec.clusterIPs;
    } else if (sameList(oldIPs, strs(spec.clusterIPs))) {
      spec.clusterIPs = [clusterIP];
    }
  }
}

/** patchAllocatedValues: values the server allocated that a resubmitted object left out. */
export function patchAllocatedValues(spec: JsonObject, old: JsonObject): void {
  if (needsClusterIP(old) && needsClusterIP(spec)) {
    if (str(spec.clusterIP) === '') {
      if (str(old.clusterIP) === '') delete spec.clusterIP;
      else spec.clusterIP = old.clusterIP as string;
    }
    if (strs(spec.clusterIPs).length === 0 && strs(old.clusterIPs).length > 0) setList(spec, 'clusterIPs', strs(old.clusterIPs));
  }
  if (needsNodePort(old) && needsNodePort(spec)) {
    const oldUsed = new Set(collectNodePorts(old));
    const used = new Set(collectNodePorts(spec).filter((p) => oldUsed.has(p)));
    // NodePorts by port name: the user may have changed other properties of the port.
    const byName = new Map<string, number>();
    for (const p of ports(old)) byName.set(str(p.name), num(p.nodePort));
    for (const p of ports(spec)) {
      if (num(p.nodePort) !== 0) continue;
      const oldVal = byName.get(str(p.name)) ?? 0;
      if (!used.has(oldVal) && oldVal !== 0) p.nodePort = oldVal;
    }
  }
  if (needsHCNodePort(old) && needsHCNodePort(spec) && num(spec.healthCheckNodePort) === 0 && num(old.healthCheckNodePort) !== 0) {
    spec.healthCheckNodePort = old.healthCheckNodePort as number;
  }
}

/** defaultOnReadService: what the Decorator fills on read (objects written before these fields). */
export function defaultOnReadService(svc: JsonObject, primary: IPFamily): void {
  const spec = specOf(svc);
  normalizeClusterIPs(spec, undefined);
  if (needsClusterIP(spec) && strs(spec.ipFamilies).length === 0) {
    const other: IPFamily = primary === 'IPv4' ? 'IPv6' : 'IPv4';
    if (str(spec.clusterIP) === 'None') {
      const selector = isObject(spec.selector) ? Object.keys(spec.selector) : [];
      if (selector.length === 0) {
        spec.ipFamilyPolicy = 'RequireDualStack';
        spec.ipFamilies = [primary, other];
      } else {
        spec.ipFamilyPolicy = 'SingleStack';
        spec.ipFamilies = [primary];
      }
    } else {
      const fams = strs(spec.clusterIPs).map((ip) => (isIPv6String(ip) ? 'IPv6' : 'IPv4'));
      setList(spec, 'ipFamilies', fams);
      if (fams.length === 1) spec.ipFamilyPolicy = 'SingleStack';
      else if (fams.length === 2) spec.ipFamilyPolicy = 'RequireDualStack';
    }
  }
  if (str(spec.type) === 'ExternalName') delete spec.internalTrafficPolicy;
}

// ---- alloc.go ----

function isMatchingPreferDualStackClusterIPFields(spec: JsonObject, old: JsonObject | undefined): boolean {
  if (!old) return false;
  if (spec.ipFamilyPolicy === undefined || spec.ipFamilyPolicy === null) return false;
  if (str(old.type) !== str(spec.type)) return false;
  if (!['ClusterIP', 'NodePort', 'LoadBalancer'].includes(str(spec.type))) return false;
  if (policyOf(spec) !== 'PreferDualStack') return false;
  if (old.ipFamilyPolicy !== undefined && old.ipFamilyPolicy !== null && policyOf(old) !== 'PreferDualStack') return false;
  return sameList(strs(old.clusterIPs), strs(spec.clusterIPs)) && sameList(strs(old.ipFamilies), strs(spec.ipFamilies));
}

/** initIPFamilyFields: the errors (an Invalid of their own), or none. */
function initIPFamilyFields(svc: JsonObject, oldSvc: JsonObject | undefined, s: StrategyCtx): FieldError[] {
  const spec = specOf(svc);
  const old = oldSvc ? specOf(oldSvc) : undefined;
  if (str(spec.type) === 'ExternalName') return [];
  if (isMatchingPreferDualStackClusterIPFields(spec, old)) return [];
  const families = configuredFamilies(s);
  const primary = families[0] ?? 'IPv4';
  if (spec.ipFamilyPolicy === undefined || spec.ipFamilyPolicy === null) {
    if (old && old.ipFamilyPolicy !== undefined && old.ipFamilyPolicy !== null) spec.ipFamilyPolicy = old.ipFamilyPolicy;
    else if (str(spec.clusterIP) === 'None' && !(isObject(spec.selector) && Object.keys(spec.selector).length > 0)) spec.ipFamilyPolicy = 'RequireDualStack';
    else spec.ipFamilyPolicy = 'SingleStack';
  }
  const pre = validateServiceClusterIPsRelatedFields(svc, oldSvc);
  if (pre.length > 0) return pre;
  const el: FieldError[] = [];
  const policyValue = str(spec.ipFamilyPolicy);
  if (old) {
    if (policyValue === 'SingleStack') {
      if (sameList(strs(old.clusterIPs), strs(spec.clusterIPs)) && strs(spec.clusterIPs).length > 1) spec.clusterIPs = strs(spec.clusterIPs).slice(0, 1);
      if (sameList(strs(old.ipFamilies), strs(spec.ipFamilies)) && strs(spec.ipFamilies).length > 1) spec.ipFamilies = strs(spec.ipFamilies).slice(0, 1);
    } else {
      const newIPs = strs(spec.clusterIPs);
      if (newIPs.length > 0 && newIPs.length < strs(old.clusterIPs).length) el.push(invalid(newPath('spec', 'ipFamilyPolicy'), policyValue, "must be 'SingleStack' to release the secondary cluster IP"));
      const newF = strs(spec.ipFamilies);
      if (newF.length > 0 && newF.length < strs(old.ipFamilies).length) el.push(invalid(newPath('spec', 'ipFamilyPolicy'), policyValue, "must be 'SingleStack' to release the secondary IP family"));
    }
  }
  if (policyValue === 'SingleStack') {
    if (strs(spec.clusterIPs).length === 2) el.push(invalid(newPath('spec', 'ipFamilyPolicy'), policyValue, "must be 'RequireDualStack' or 'PreferDualStack' when multiple cluster IPs are specified"));
    if (strs(spec.ipFamilies).length === 2) el.push(invalid(newPath('spec', 'ipFamilyPolicy'), policyValue, "must be 'RequireDualStack' or 'PreferDualStack' when multiple IP families are specified"));
  }
  // Infer ipFamilies from clusterIPs.
  const clusterIPs = strs(spec.clusterIPs);
  for (const [i, ip] of clusterIPs.entries()) {
    if (ip === 'None') break;
    const fam = familyOf(ip);
    if (i >= strs(spec.ipFamilies).length) {
      if (fam === 'unknown' || !families.includes(fam)) el.push(invalid(newPath('spec', 'clusterIPs').index(i), clusterIPs, `${fam} is not configured on this cluster`));
      else spec.ipFamilies = [...strs(spec.ipFamilies), fam];
    }
  }
  if (el.length > 0) return el;
  // Headless and selectorless: combinations that would otherwise be errors are allowed.
  if (str(spec.clusterIP) === 'None' && !(isObject(spec.selector) && Object.keys(spec.selector).length > 0)) {
    if (strs(spec.ipFamilies).length === 0) spec.ipFamilies = [primary];
    const fams = strs(spec.ipFamilies);
    if (fams.length < 2 && policyValue !== 'SingleStack') spec.ipFamilies = [...fams, fams[0] === 'IPv4' ? 'IPv6' : 'IPv4'];
    return [];
  }
  if (policyValue === 'RequireDualStack' && families.length < 2) el.push(invalid(newPath('spec', 'ipFamilyPolicy'), policyValue, 'this cluster is not configured for dual-stack services'));
  strs(spec.ipFamilies).forEach((f, i) => {
    if (!families.includes(f as IPFamily)) el.push(invalid(newPath('spec', 'ipFamilies').index(i), f, 'not configured on this cluster'));
  });
  if (el.length > 0) return el;
  if (strs(spec.ipFamilies).length === 0) spec.ipFamilies = [primary];
  const fams = strs(spec.ipFamilies);
  if (policyValue !== 'SingleStack' && fams.length === 1 && families.length === 2) spec.ipFamilies = [...fams, fams[0] === 'IPv4' ? 'IPv6' : 'IPv4'];
  return [];
}

/** An allocation failure that upstream reports as an internal error (after validation here). */
type Outcome = FieldError[] | { internal: string };

/** allocIPs for the families in `toAlloc` (in ipFamilies order); sets clusterIPs on success. */
function allocIPs(svc: JsonObject, toAlloc: [IPFamily, string][], s: StrategyCtx): Outcome {
  const spec = specOf(svc);
  const allocated: [IPFamily, string][] = [];
  for (const [family, ip] of toAlloc) {
    if (ip === '') {
      const r = allocateNext(s, family);
      if ('error' in r) {
        if (r.error !== 'range is full') return [invalid(newPath('spec', 'clusterIPs'), strs(spec.clusterIPs), `failed to allocate IP: ${r.error}`)];
        return { internal: `failed to allocate a serviceIP for Service ${JSON.stringify(nameOf(svc))}: ${r.error}` };
      }
      allocated.push([family, r.ip]);
    } else {
      const err = checkAllocate(s, family, ip);
      if (err?.startsWith('failed to parse')) return { internal: err };
      if (err) return [invalid(newPath('spec', 'clusterIPs'), strs(spec.clusterIPs), `failed to allocate IP ${ip}: ${err}`)];
      allocated.push([family, ip]);
    }
  }
  const ips = strs(spec.clusterIPs);
  const fams = strs(spec.ipFamilies);
  for (const [family, ip] of allocated) {
    fams.forEach((f, i) => {
      if (f !== family) return;
      ips[i] = ip;
      if (i === 0) spec.clusterIP = ip;
    });
  }
  setList(spec, 'clusterIPs', ips);
  return [];
}

/** allocClusterIPs. On a full range the "" markers are taken back, so validation sees no bogus IP. */
function allocClusterIPs(svc: JsonObject, s: StrategyCtx): Outcome {
  const spec = specOf(svc);
  if (str(spec.type) === 'ExternalName') return [];
  if (strs(spec.clusterIPs)[0] === 'None') return [];
  const before = strs(spec.clusterIPs);
  const ips = [...before];
  const toAlloc: [IPFamily, string][] = [];
  strs(spec.ipFamilies).forEach((f, i) => {
    if (i > ips.length - 1) ips.push('');
    toAlloc.push([f as IPFamily, ips[i] as string]);
  });
  spec.clusterIPs = ips;
  const r = allocIPs(svc, toAlloc, s);
  if (!Array.isArray(r) || r.length > 0) setList(spec, 'clusterIPs', before);
  return r;
}

const nodePortInvalid = (svc: JsonObject, i: number, port: number, err: string): FieldError[] => [invalid(newPath('spec', 'ports').index(i).child('nodePort'), port, err)];

/** initNodePorts. */
function initNodePorts(svc: JsonObject, op: PortOp): Outcome {
  const spec = specOf(svc);
  const svcPortToNodePort = new Map<number, number>();
  const list = ports(spec);
  for (const [i, sp] of list.entries()) {
    if (num(sp.nodePort) === 0 && !shouldAllocateNodePorts(spec)) continue;
    const port = num(sp.port);
    const allocatedNodePort = svcPortToNodePort.get(port) ?? 0;
    if (allocatedNodePort === 0) {
      // Any user-provided value for this port number, scanning forward.
      const np = list.find((p) => num(p.port) === port && num(p.nodePort) !== 0);
      if (np) {
        const n = num(np.nodePort);
        const err = opAllocate(op, n);
        if (err) return nodePortInvalid(svc, i, n, err);
        sp.nodePort = n;
        svcPortToNodePort.set(port, n);
      } else {
        const n = opAllocateNext(op);
        if (n === undefined) return { internal: 'failed to allocate a nodePort: range is full' };
        sp.nodePort = n;
        svcPortToNodePort.set(port, n);
      }
    } else if (num(sp.nodePort) !== allocatedNodePort) {
      if (num(sp.nodePort) === 0) sp.nodePort = allocatedNodePort;
      else {
        const err = opAllocate(op, num(sp.nodePort));
        if (err) return nodePortInvalid(svc, i, num(sp.nodePort), err);
      }
    }
  }
  return [];
}

/** allocHealthCheckNodePort. */
function allocHealthCheckNodePort(spec: JsonObject, op: PortOp): string | undefined {
  const hc = num(spec.healthCheckNodePort);
  if (hc !== 0) {
    const err = opAllocate(op, hc);
    return err ? `failed to allocate requested HealthCheck NodePort ${hc}: ${err}` : undefined;
  }
  const n = opAllocateNext(op);
  if (n === undefined) return 'failed to allocate a HealthCheck NodePort 0: range is full';
  spec.healthCheckNodePort = n;
  return undefined;
}

/** The internal errors a create or update plan hit: reported by beforePersist (see the header). */
const outcomeErrors = (o: Outcome): FieldError[] => (Array.isArray(o) ? o : []);

/** beginCreate + allocateCreate, planned (see the header): the errors, returned alone. */
export function planCreate(svc: JsonObject, s: StrategyCtx): FieldError[] {
  const spec = specOf(svc);
  normalizeClusterIPs(spec, undefined);
  const fam = initIPFamilyFields(svc, undefined, s);
  if (fam.length > 0) return fam;
  const ips = outcomeErrors(allocClusterIPs(svc, s));
  if (ips.length > 0) return ips;
  const op = startPortOp(s);
  if (str(spec.type) === 'NodePort' || str(spec.type) === 'LoadBalancer') {
    const np = outcomeErrors(initNodePorts(svc, op));
    if (np.length > 0) return np;
  }
  // A failed health check port is an internal error: left for beforePersist.
  if (needsHealthCheck(spec)) allocHealthCheckNodePort(spec, op);
  return [];
}

/** updateClusterIPs, planned. */
function updateClusterIPs(svc: JsonObject, oldSvc: JsonObject, s: StrategyCtx): Outcome {
  const spec = specOf(svc);
  const old = specOf(oldSvc);
  if (isMatchingPreferDualStackClusterIPFields(spec, old)) return [];
  if (str(old.type) === 'ExternalName' && str(spec.type) !== 'ExternalName') return allocClusterIPs(svc, s);
  if (strs(old.clusterIPs)[0] === 'None') return [];
  if (str(old.type) !== 'ExternalName' && str(spec.type) === 'ExternalName') return [];
  const upgraded = strs(old.ipFamilies).length === 1 && strs(spec.ipFamilies).length === 2;
  if (upgraded) {
    const before = strs(spec.clusterIPs);
    const ips = [...before];
    if (ips.length < 2) ips.push('');
    spec.clusterIPs = ips;
    const r = allocIPs(svc, [[strs(spec.ipFamilies)[1] as IPFamily, ips[1] as string]], s);
    if (!Array.isArray(r) || r.length > 0) setList(spec, 'clusterIPs', before);
    return r;
  }
  return [];
}

/**
 * updateNodePorts, planned. Two ports with the same protocol and NodePort make upstream fail with
 * an internal error (`duplicate nodePort: {TCP 30080}`); here planning stops and validation
 * reports the duplicate (spec.ports[i].nodePort: Duplicate value) instead.
 */
function updateNodePorts(svc: JsonObject, oldSvc: JsonObject, op: PortOp): Outcome {
  const spec = specOf(svc);
  const oldNumbers = collectNodePorts(specOf(oldSvc));
  const seen: string[] = [];
  const portAllocated = new Set<number>();
  for (const [i, sp] of ports(spec).entries()) {
    if (num(sp.nodePort) === 0 && !shouldAllocateNodePorts(spec)) continue;
    let np = num(sp.nodePort);
    if (np !== 0) {
      if (!oldNumbers.includes(np) && !portAllocated.has(np)) {
        const err = opAllocate(op, np);
        if (err) return nodePortInvalid(svc, i, np, err);
        portAllocated.add(np);
      }
    } else {
      const n = opAllocateNext(op);
      if (n === undefined) return { internal: 'failed to allocate a nodePort: range is full' };
      sp.nodePort = n;
      np = n;
    }
    const key = `{${str(sp.protocol)} ${np}}`;
    if (seen.includes(key)) return [];
    seen.push(key);
  }
  return [];
}

/** beginUpdate + allocateUpdate, planned: the errors, returned alone. */
export function planUpdate(svc: JsonObject, oldSvc: JsonObject, s: StrategyCtx): FieldError[] {
  const spec = specOf(svc);
  const old = specOf(oldSvc);
  patchAllocatedValues(spec, old);
  normalizeClusterIPs(spec, old);
  const fam = initIPFamilyFields(svc, oldSvc, s);
  if (fam.length > 0) return fam;
  const ips = outcomeErrors(updateClusterIPs(svc, oldSvc, s));
  if (ips.length > 0) return ips;
  const op = startPortOp(s);
  if (str(spec.type) === 'NodePort' || str(spec.type) === 'LoadBalancer') {
    const np = outcomeErrors(updateNodePorts(svc, oldSvc, op));
    if (np.length > 0) return np;
  }
  if (!needsHealthCheck(old) && needsHealthCheck(spec)) allocHealthCheckNodePort(spec, op);
  return [];
}

// ---- writing the plan ----

/** The allocated IPs of a Service (none for ExternalName and headless ones). */
function allocatedIPs(spec: JsonObject): string[] {
  if (!needsClusterIP(spec)) return [];
  const ips = strs(spec.clusterIPs);
  if (ips[0] === 'None') return [];
  return ips.filter((ip) => ip !== '');
}

/** NodePorts in use, with the health check port when one is needed. */
function usedPorts(spec: JsonObject): number[] {
  const out = collectNodePorts(spec);
  if (needsHealthCheck(spec) && num(spec.healthCheckNodePort) > 0) out.push(num(spec.healthCheckNodePort));
  return out;
}

/** A needed allocation that the plan could not make: the range was full. */
function fullRangeError(svc: JsonObject): Status | undefined {
  const spec = specOf(svc);
  if (needsClusterIP(spec) && strs(spec.clusterIPs)[0] !== 'None' && strs(spec.clusterIPs).filter((ip) => ip !== '').length < strs(spec.ipFamilies).length) {
    return internalError(`failed to allocate a serviceIP for Service ${JSON.stringify(nameOf(svc))}: range is full`);
  }
  if ((str(spec.type) === 'NodePort' || str(spec.type) === 'LoadBalancer') && shouldAllocateNodePorts(spec) && ports(spec).some((p) => num(p.nodePort) === 0)) {
    return internalError('failed to allocate a nodePort: range is full');
  }
  if (needsHealthCheck(spec) && num(spec.healthCheckNodePort) === 0) return internalError('failed to allocate a HealthCheck NodePort 0: range is full');
  return undefined;
}

/** Writes the planned allocations (nothing in dry run): IPAddress objects first, then ports. */
export function commitCreate(svc: JsonObject, s: StrategyCtx): FieldError[] | Status | undefined {
  const full = fullRangeError(svc);
  if (full) return full;
  if (s.dryRun) return undefined;
  const spec = specOf(svc);
  const ref = { namespace: namespaceOf(svc), name: nameOf(svc) };
  const created: string[] = [];
  for (const ip of allocatedIPs(spec)) {
    const fam = familyOf(ip);
    const err = createIPAddress(s, ip, fam === 'unknown' ? 'IPv4' : fam, ref);
    if (err) {
      for (const c of created) releaseIP(s, c);
      return [invalid(newPath('spec', 'clusterIPs'), strs(spec.clusterIPs), `failed to allocate IP ${ip}: ${err}`)];
    }
    created.push(ip);
  }
  commitPorts(s, usedPorts(spec), []);
  return undefined;
}

/** Writes an update's plan: new IPs and ports allocated, the ones no longer used released. */
export function commitUpdate(svc: JsonObject, oldSvc: JsonObject, s: StrategyCtx): FieldError[] | Status | undefined {
  const full = fullRangeError(svc);
  if (full) return full;
  if (s.dryRun) return undefined;
  const spec = specOf(svc);
  const old = specOf(oldSvc);
  const newIPs = allocatedIPs(spec);
  const oldIPs = allocatedIPs(old);
  const ref = { namespace: namespaceOf(svc), name: nameOf(svc) };
  const created: string[] = [];
  for (const ip of newIPs.filter((x) => !oldIPs.includes(x))) {
    const fam = familyOf(ip);
    const err = createIPAddress(s, ip, fam === 'unknown' ? 'IPv4' : fam, ref);
    if (err) {
      for (const c of created) releaseIP(s, c);
      return [invalid(newPath('spec', 'clusterIPs'), strs(spec.clusterIPs), `failed to allocate IP ${ip}: ${err}`)];
    }
    created.push(ip);
  }
  for (const ip of oldIPs.filter((x) => !newIPs.includes(x))) releaseIP(s, ip);
  const newPorts = usedPorts(spec);
  const oldPorts = usedPorts(old);
  commitPorts(s, newPorts.filter((p) => !oldPorts.includes(p)), oldPorts.filter((p) => !newPorts.includes(p)));
  return undefined;
}

/** releaseAllocatedResources (afterDelete). */
export function releaseAllocated(svc: JsonObject, s: StrategyCtx): void {
  const spec = specOf(svc);
  for (const ip of allocatedIPs(spec)) releaseIP(s, ip);
  commitPorts(s, [], usedPorts(spec));
}

/** The stored old object as BeginUpdate sees it (defaultOnReadService applied to a copy). */
export function decoratedOld(old: JsonObject, s: StrategyCtx): JsonObject {
  const copy = cloneJson(old);
  defaultOnReadService(copy, configuredFamilies(s)[0] ?? 'IPv4');
  return copy;
}
