// RepackSubsets and SortSubsets: the canonical form of Endpoints subsets (one subset per set of
// addresses sharing the same ports, addresses by IP then UID, ports and subsets by hash).
// upstream: pkg/api/v1/endpoints/util.go. Subsets are v1 JSON as the controller builds them:
// empty lists absent (nil), every EndpointAddress with nodeName and targetRef.

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import type { GoValue } from '../hash/spew.ts';
import { deepHash, goInt32, goPtr, goString, goStruct } from '../endpointslice/hash.ts';
import { objs, str } from '../endpointslice/util.ts';

const optStr = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function slice(t: string, elems: GoValue[] | null): GoValue {
  return { k: 'slice', t, elems };
}

/** A core/v1 EndpointPort (k8s.io/api/core/v1/types.go: Name, Port, Protocol, AppProtocol *string). */
function endpointPortValue(p: JsonObject): GoValue {
  const app = optStr(p.appProtocol);
  return goStruct('v1.EndpointPort', [
    ['Name', goString(str(p.name))],
    ['Port', goInt32(typeof p.port === 'number' ? p.port : 0)],
    ['Protocol', goString(str(p.protocol), 'v1.Protocol')],
    ['AppProtocol', goPtr('*string', app === undefined ? null : goString(app))],
  ]);
}

function objectReferenceValue(r: JsonObject): GoValue {
  return goStruct('v1.ObjectReference', [
    ['Kind', goString(str(r.kind))],
    ['Namespace', goString(str(r.namespace))],
    ['Name', goString(str(r.name))],
    ['UID', goString(str(r.uid), 'types.UID')],
    ['APIVersion', goString(str(r.apiVersion))],
    ['ResourceVersion', goString(str(r.resourceVersion))],
    ['FieldPath', goString(str(r.fieldPath))],
  ]);
}

function endpointAddressValue(a: JsonObject): GoValue {
  const node = optStr(a.nodeName);
  const ref = a.targetRef !== undefined && a.targetRef !== null ? (a.targetRef as JsonObject) : undefined;
  return goStruct('v1.EndpointAddress', [
    ['IP', goString(str(a.ip))],
    ['Hostname', goString(str(a.hostname))],
    ['NodeName', goPtr('*string', node === undefined ? null : goString(node))],
    ['TargetRef', goPtr('*v1.ObjectReference', ref ? objectReferenceValue(ref) : null)],
  ]);
}

const list = (v: Json | undefined): JsonObject[] | null => (Array.isArray(v) && v.length > 0 ? objs(v) : null);

function endpointSubsetValue(s: JsonObject): GoValue {
  const addrs = list(s.addresses);
  const notReady = list(s.notReadyAddresses);
  const ports = list(s.ports);
  return goStruct('v1.EndpointSubset', [
    ['Addresses', slice('[]v1.EndpointAddress', addrs ? addrs.map(endpointAddressValue) : null)],
    ['NotReadyAddresses', slice('[]v1.EndpointAddress', notReady ? notReady.map(endpointAddressValue) : null)],
    ['Ports', slice('[]v1.EndpointPort', ports ? ports.map(endpointPortValue) : null)],
  ]);
}

const uidOf = (a: JsonObject): string | undefined => (a.targetRef ? str((a.targetRef as JsonObject).uid) : undefined);

/** LessEndpointAddress: IP bytes, then a missing targetRef first, then UID. */
function lessEndpointAddress(a: JsonObject, b: JsonObject): boolean {
  const ai = str(a.ip);
  const bi = str(b.ip);
  if (ai !== bi) return ai < bi; // ASCII: byte order is code unit order
  if (b.targetRef === undefined || b.targetRef === null) return false;
  if (a.targetRef === undefined || a.targetRef === null) return true;
  return (uidOf(a) ?? '') < (uidOf(b) ?? '');
}

const byLess = <T>(less: (a: T, b: T) => boolean) => (a: T, b: T): number => (less(a, b) ? -1 : less(b, a) ? 1 : 0);
const byHash = <T>(hash: (v: T) => string) => {
  return (a: T, b: T): number => {
    const ha = hash(a);
    const hb = hash(b);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  };
};

/** SortSubsets. */
export function sortSubsets(subsets: JsonObject[]): JsonObject[] {
  for (const ss of subsets) {
    if (Array.isArray(ss.addresses)) ss.addresses = objs(ss.addresses).sort(byLess(lessEndpointAddress));
    if (Array.isArray(ss.notReadyAddresses)) ss.notReadyAddresses = objs(ss.notReadyAddresses).sort(byLess(lessEndpointAddress));
    if (Array.isArray(ss.ports)) ss.ports = objs(ss.ports).sort(byHash((p: JsonObject) => deepHash(endpointPortValue(p))));
  }
  return subsets.sort(byHash((s: JsonObject) => deepHash(endpointSubsetValue(s))));
}

/** Port identity: v1.EndpointPort as a map key (struct equality, AppProtocol by pointer value). */
const portKey = (p: JsonObject): string => JSON.stringify([str(p.name), p.port ?? 0, str(p.protocol), optStr(p.appProtocol) ?? null]);
/** addressKey: IP and targetRef UID. */
const addressKey = (a: JsonObject): string => JSON.stringify([str(a.ip), uidOf(a) ?? '']);

/**
 * RepackSubsets: regroups addresses by the set of ports they serve. An address that is ready on a
 * port in one subset and not ready in another is not ready. Map iteration order does not matter:
 * SortSubsets orders the result completely.
 */
export function repackSubsets(subsets: readonly JsonObject[]): JsonObject[] {
  const allAddrs = new Map<string, JsonObject>();
  // port key → { port (null for the no-port sentinel), address key → ready }
  const portToAddrReady = new Map<string, { port: JsonObject | null; addrs: Map<string, boolean> }>();
  const mapAddress = (addr: JsonObject, port: JsonObject | null, ready: boolean): void => {
    const ak = addressKey(addr);
    if (!allAddrs.has(ak)) allAddrs.set(ak, addr);
    const pk = port ? portKey(port) : 'sentinel';
    let entry = portToAddrReady.get(pk);
    if (!entry) portToAddrReady.set(pk, (entry = { port, addrs: new Map() }));
    const was = entry.addrs.get(ak);
    if (was === undefined || was) entry.addrs.set(ak, ready);
  };
  for (const ss of subsets) {
    const ports = objs(ss.ports);
    for (const port of ports.length === 0 ? [null] : ports) {
      for (const a of objs(ss.addresses)) mapAddress(a, port, true);
      for (const a of objs(ss.notReadyAddresses)) mapAddress(a, port, false);
    }
  }
  // Group the ports by their address set (hashAddresses; any injective key does).
  const groups = new Map<string, { addrs: Map<string, boolean>; ports: JsonObject[] }>();
  for (const { port, addrs } of portToAddrReady.values()) {
    const key = JSON.stringify([...addrs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { addrs, ports: [] }));
    // port.Port > 0: the sentinel adds no port.
    if (port && typeof port.port === 'number' && port.port > 0) g.ports.push(port);
  }
  const final: JsonObject[] = [];
  for (const g of groups.values()) {
    const ready: JsonObject[] = [];
    const notReady: JsonObject[] = [];
    for (const [ak, r] of g.addrs) (r ? ready : notReady).push({ ...(allAddrs.get(ak) as JsonObject) });
    const ss: JsonObject = {};
    if (ready.length > 0) ss.addresses = ready;
    if (notReady.length > 0) ss.notReadyAddresses = notReady;
    if (g.ports.length > 0) ss.ports = g.ports.map((p) => ({ ...p }));
    final.push(ss);
  }
  return sortSubsets(final);
}
