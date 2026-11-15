// The ClusterIP allocator of v1.37: one allocator per ServiceCIDR, an IPAddress object per
// allocated address (MultiCIDRServiceAllocator and DisableAllocatorDualWrite are GA: no bitmap).
// upstream: pkg/registry/core/service/ipallocator/cidrallocator.go (MetaAllocator: allocators
// from the ServiceCIDRs, ready unless their Ready condition is false or they are being deleted;
// getAllocator → ErrMismatchedNetwork; AllocateNextService tries each allocator of the family;
// DryRun returns one of them), ipallocator.go (Allocator: first = network + 1, last = broadcast − 1
// for IPv4, the broadcast address for IPv6; allocateNextService: a random offset in the upper
// sub-range [first + rangeOffset, last], then a random offset in the lower one; createIPAddress;
// dry run: Allocate checks the range only, AllocateNext returns the network address),
// bitmap.go calculateRangeOffset (min(max(16, size/16), 256)), interfaces.go (the errors).
// pkg/api/servicecidr PrefixContainsIP is not in the sparse checkout: checked against the v1.37.2
// oracle: 10.96.0.0 and 10.111.255.255 give "the provided network does not match the current
// range" with 10.96.0.0/12 (the network and IPv4 broadcast addresses are not contained).
// Go iterates the allocators of a map; this port goes in CIDR order. Randomness comes from the
// `k8s.ipallocator` stream.

import type { Random } from '@simlab/kernel';
import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import { ipString, parseCIDRSloppy, parseIPSloppy, to4 } from '../../apimachinery/net.ts';
import { handle } from '../../apiserver/pipeline.ts';
import { storeGet, storeList } from '../../apiserver/store.ts';
import type { StrategyCtx } from '../../apiserver/types.ts';

export type IPFamily = 'IPv4' | 'IPv6';

export const ERR_IP_FULL = 'range is full';
export const ERR_IP_ALLOCATED = 'provided IP is already allocated';
export const ERR_MISMATCHED_NETWORK = 'the provided network does not match the current range';
export const ERR_NOT_READY = 'allocator not ready';

const LABEL_IP_FAMILY = 'ipaddress.kubernetes.io/ip-family';
const LABEL_MANAGED_BY = 'ipaddress.kubernetes.io/managed-by';
const CONTROLLER_NAME = 'ipallocator.k8s.io';

interface CidrAllocator {
  /** netip.Prefix.String of the CIDR. */
  prefix: string;
  family: IPFamily;
  bytes: 4 | 16;
  network: bigint;
  first: bigint;
  last: bigint;
  broadcast: bigint;
  rangeOffset: bigint;
  offsetAddress: bigint;
  size: bigint;
  ready: boolean;
}

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_INT64 = (1n << 63n) - 1n;

const toBig = (bytes: readonly number[]): bigint => bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
function fromBig(n: bigint, len: 4 | 16): number[] {
  const out: number[] = [];
  let v = n;
  for (let i = 0; i < len; i++) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}
const addrString = (n: bigint, len: 4 | 16): string => ipString(fromBig(n, len));

/** An address as a number in its family, or undefined. */
function parseAddress(ip: string): { n: bigint; family: IPFamily } | undefined {
  const p = parseIPSloppy(ip);
  if (!p) return undefined;
  const v4 = to4(p);
  return v4 ? { n: toBig(v4), family: 'IPv4' } : { n: toBig(p), family: 'IPv6' };
}

/** netutils.IPFamilyOf a CIDR string. */
export function familyOfCIDR(cidr: string): IPFamily | undefined {
  const r = parseCIDRSloppy(cidr);
  if ('error' in r) return undefined;
  return to4(r.net.ip) ? 'IPv4' : 'IPv6';
}

/** NewIPAllocator's arithmetic. */
function newAllocator(cidr: string, ready: boolean): CidrAllocator | undefined {
  const r = parseCIDRSloppy(cidr);
  if ('error' in r) return undefined;
  const v4 = to4(r.net.ip);
  const bytes: 4 | 16 = v4 ? 4 : 16;
  const ones = v4 && r.net.bits === 128 ? r.net.ones - 96 : r.net.ones;
  const bits = bytes * 8;
  const hostBits = bits - ones;
  if (bytes === 16 && ones < 64) return undefined; // shortest allowed prefix length for service CIDR is 64
  const network = toBig(v4 ?? r.net.ip);
  const broadcast = network | ((1n << BigInt(hostBits)) - 1n);
  // hostsPerNetwork
  let size: bigint;
  if (hostBits >= 64) size = MAX_UINT64;
  else {
    size = (1n << BigInt(hostBits)) - 1n;
    if (bytes === 4) size = size === 0n ? 0n : size - 1n;
  }
  // calculateRangeOffset over netutils.RangeSize
  const rangeSize = hostBits >= 63 ? MAX_INT64 : 1n << BigInt(hostBits);
  let rangeOffset: bigint;
  if (rangeSize <= 16n) rangeOffset = 0n;
  else {
    const o = rangeSize / 16n;
    rangeOffset = o < 16n ? 16n : o > 256n ? 256n : o;
  }
  const first = network + 1n;
  const last = bytes === 4 ? broadcast - 1n : broadcast;
  return { prefix: `${addrString(network, bytes)}/${ones}`, family: bytes === 4 ? 'IPv4' : 'IPv6', bytes, network, first, last, broadcast, rangeOffset, offsetAddress: first + rangeOffset, size, ready };
}

/** isReady: the Ready condition, true when there is none (kube-controller-manager may not run). */
function isReady(cidr: JsonObject): boolean {
  const status = isObject(cidr.status) ? cidr.status : {};
  const conds = Array.isArray(status.conditions) ? status.conditions : [];
  for (const c of conds) if (isObject(c) && c.type === 'Ready') return c.status === 'True';
  return true;
}

/** The families of --service-cluster-ip-range, primary first. */
export function configuredFamilies(s: StrategyCtx): IPFamily[] {
  const out: IPFamily[] = [];
  for (const c of s.server.serviceClusterIPRange.split(',')) {
    const f = familyOfCIDR(c.trim());
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** The allocators of one family, from the ServiceCIDR objects (the flag's range when there are none). */
function allocators(s: StrategyCtx, family: IPFamily): CidrAllocator[] {
  const byCidr = new Map<string, boolean>();
  const cidrs = storeList(s.etcd, 'servicecidrs.networking.k8s.io');
  for (const sc of cidrs) {
    const spec = isObject(sc.spec) ? sc.spec : {};
    const meta = isObject(sc.metadata) ? sc.metadata : {};
    const ready = isReady(sc) && (meta.deletionTimestamp === undefined || meta.deletionTimestamp === null);
    for (const c of Array.isArray(spec.cidrs) ? spec.cidrs : []) {
      if (typeof c !== 'string' || familyOfCIDR(c) !== family) continue;
      byCidr.set(c, (byCidr.get(c) ?? false) || ready);
    }
  }
  if (cidrs.length === 0) {
    for (const c of s.server.serviceClusterIPRange.split(',')) if (familyOfCIDR(c.trim()) === family) byCidr.set(c.trim(), true);
  }
  return [...byCidr.keys()]
    .sort()
    .map((c) => newAllocator(c, byCidr.get(c) ?? false))
    .filter((a): a is CidrAllocator => a !== undefined);
}

/** PrefixContainsIP: inside the prefix, not the network address, not the IPv4 broadcast address. */
const prefixContains = (a: CidrAllocator, n: bigint): boolean => n > a.network && n <= a.broadcast && !(a.bytes === 4 && n === a.broadcast);

const ipAddressTaken = (s: StrategyCtx, name: string): boolean => storeGet(s.etcd, 'ipaddresses.networking.k8s.io', name) !== undefined;

/**
 * Allocate (AllocateService) checked without writing: the error message, or undefined. Dry run:
 * the dry-run allocator checks only that the address is in its range (ErrNotInRange).
 */
export function checkAllocate(s: StrategyCtx, family: IPFamily, ip: string): string | undefined {
  const addr = parseAddress(ip);
  if (!addr) return `failed to parse service IP ${JSON.stringify(ip)}`;
  if (s.dryRun) {
    const a = allocators(s, family)[0];
    if (!a) return undefined;
    if (!a.ready) return ERR_NOT_READY;
    if (addr.n < a.first || addr.n > a.last) return `the provided IP (${addrString(addr.n, addr.family === 'IPv4' ? 4 : 16)}) is not in the valid range. The range of valid IPs is ${a.prefix}`;
    return undefined;
  }
  const a = allocators(s, family).find((x) => x.ready && x.bytes === (addr.family === 'IPv4' ? 4 : 16) && prefixContains(x, addr.n));
  if (!a) return ERR_MISMATCHED_NETWORK;
  if (ipAddressTaken(s, addrString(addr.n, a.bytes))) return ERR_IP_ALLOCATED;
  return undefined;
}

/** A uniform-enough draw in [0, n) for n up to 2^64 (two 32-bit draws above 2^32). */
function randomBelow(r: Random, n: bigint): bigint {
  if (n <= 0x1_0000_0000n) return BigInt(r.int(Number(n)));
  const hi = BigInt(r.int(0x1_0000_0000));
  const lo = BigInt(r.int(0x1_0000_0000));
  return ((hi << 32n) | lo) % n;
}

/** ipIterator + allocateFromRange: the first free address from first + offset, wrapping at last. */
function scan(s: StrategyCtx, a: CidrAllocator, first: bigint, last: bigint, offset: bigint): string | undefined {
  let start = first + offset;
  if (start > last) start = first;
  let ip = start;
  for (;;) {
    const name = addrString(ip, a.bytes);
    if (!ipAddressTaken(s, name)) return name;
    ip = ip + 1n > last ? first : ip + 1n;
    if (ip === start) return undefined;
  }
}

/** AllocateNextService: an address, or the error (ERR_IP_FULL). Dry run: the network address. */
export function allocateNext(s: StrategyCtx, family: IPFamily): { ip: string } | { error: string } {
  const all = allocators(s, family);
  if (s.dryRun) {
    const a = all[0];
    if (!a) return { error: ERR_IP_FULL };
    return a.ready ? { ip: addrString(a.network, a.bytes) } : { error: ERR_NOT_READY };
  }
  const r = s.ctx.random('k8s.ipallocator');
  for (const a of all) {
    if (!a.ready) continue;
    const rangeSize = a.size - a.rangeOffset;
    if (rangeSize === 0n) continue;
    let offset: bigint;
    if (rangeSize >= MAX_INT64) {
      offset = randomBelow(r, MAX_UINT64);
      if (MAX_UINT64 - offset < a.rangeOffset) offset -= a.rangeOffset;
    } else offset = randomBelow(r, rangeSize);
    const upper = scan(s, a, a.offsetAddress, a.last, offset);
    if (upper) return { ip: upper };
    if (a.rangeOffset !== 0n) {
      const lower = scan(s, a, a.first, a.offsetAddress - 1n, randomBelow(r, a.rangeOffset));
      if (lower) return { ip: lower };
    }
  }
  return { error: ERR_IP_FULL };
}

/** createIPAddress through the API, as the allocator's client does. The error message, if any. */
export function createIPAddress(s: StrategyCtx, ip: string, family: IPFamily, svc: { namespace: string; name: string }): string | undefined {
  const body: JsonObject = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'IPAddress',
    metadata: { name: ip, labels: { [LABEL_IP_FAMILY]: family, [LABEL_MANAGED_BY]: CONTROLLER_NAME } },
    spec: { parentRef: { group: '', resource: 'services', namespace: svc.namespace, name: svc.name } },
  };
  const r = handle(s.ctx, s.server, { verb: 'create', group: 'networking.k8s.io', version: 'v1', resource: 'ipaddresses', body });
  if (r.ok) return undefined;
  if (r.code === 409) return ERR_IP_ALLOCATED;
  return 'status' in r ? String(r.status.message ?? '') : r.notSimulated;
}

/** Release: delete the IPAddress; errors are ignored, as upstream does. */
export function releaseIP(s: StrategyCtx, ip: string): void {
  const addr = parseAddress(ip);
  if (!addr) return;
  handle(s.ctx, s.server, { verb: 'delete', group: 'networking.k8s.io', version: 'v1', resource: 'ipaddresses', name: addrString(addr.n, addr.family === 'IPv4' ? 4 : 16) });
}

/** familyOf: IPv4, IPv6 or unknown. */
export function familyOf(ip: string): IPFamily | 'unknown' {
  return parseAddress(ip)?.family ?? 'unknown';
}

/** The first address of the primary range (the `kubernetes` Service's ClusterIP). */
export function firstServiceIP(range: string): string | undefined {
  const a = newAllocator(range.split(',')[0]?.trim() ?? '', true);
  return a ? addrString(a.first, a.bytes) : undefined;
}
