// The NodePort allocator: --service-node-port-range as a bitmap kept in etcd.
// upstream: pkg/registry/core/service/portallocator/allocator.go (PortAllocator, ErrNotInRange,
// ErrAllocated, ErrFull, calculateRangeOffset: min(max(16, size/32), 128)),
// portallocator/operation.go (PortAllocationOperation: allocations of one request, and its
// dry-run behavior), allocator/bitmap.go (randomScanStrategyWithOffset: a random start in the
// upper sub-range first, then the lower one), portallocator/storage (the RangeAllocation at
// /registry/ranges/servicenodeports).
// The state is the sorted list of allocated ports under that key (upstream stores the bitmap's
// bytes); randomness comes from the `k8s.portallocator` stream.
// A request plans its allocations while it is validated (portOp) and the store changes only when
// the object is persisted (commitPorts), which is what upstream's operation Commit/Rollback amount to.

import { rangeGet, rangePut } from '../../apiserver/store.ts';
import type { StrategyCtx } from '../../apiserver/types.ts';
import { isObject } from '../../apimachinery/json.ts';

export const NODE_PORTS_KEY = '/registry/ranges/servicenodeports';

export const ERR_PORT_FULL = 'range is full';
export const ERR_PORT_ALLOCATED = 'provided port is already allocated';

interface PortRange {
  base: number;
  size: number;
}

const rangeOf = (s: StrategyCtx): PortRange => {
  const [lo, hi] = s.server.serviceNodePortRange;
  return { base: lo, size: hi - lo + 1 };
};

/** net.PortRange.String. */
const rangeString = (r: PortRange): string => `${r.base}-${r.base + r.size - 1}`;

/** ErrNotInRange.Error. */
const notInRange = (r: PortRange): string => `provided port is not in the valid range. The range of valid ports is ${rangeString(r)}`;

function calculateRangeOffset(r: PortRange): number {
  const min = 16;
  const max = 128;
  const step = 32;
  if (r.size <= min) return 0;
  const offset = Math.floor(r.size / step);
  if (offset < min) return min;
  if (offset > max) return max;
  return offset;
}

/** The allocated ports in the store. */
export function allocatedNodePorts(s: StrategyCtx): number[] {
  const v = rangeGet(s.etcd, NODE_PORTS_KEY);
  return isObject(v) && Array.isArray(v.ports) ? v.ports.filter((p): p is number => typeof p === 'number') : [];
}

/** The allocations of one request (PortAllocationOperation). */
export interface PortOp {
  readonly s: StrategyCtx;
  readonly dryRun: boolean;
  readonly range: PortRange;
  readonly inStore: ReadonlySet<number>;
  /** Ports this request allocates, in order. */
  readonly allocated: number[];
}

export function startPortOp(s: StrategyCtx): PortOp {
  return { s, dryRun: s.dryRun, range: rangeOf(s), inStore: new Set(allocatedNodePorts(s)), allocated: [] };
}

const contains = (r: PortRange, port: number): boolean => port >= r.base && port < r.base + r.size;

/** Allocate: an error message, or undefined when the port is now this request's. */
export function opAllocate(op: PortOp, port: number): string | undefined {
  if (op.dryRun) {
    // Dry run checks only Has (which is false outside the range) and this request's own ports.
    if ((contains(op.range, port) && op.inStore.has(port)) || op.allocated.includes(port)) return ERR_PORT_ALLOCATED;
    op.allocated.push(port);
    return undefined;
  }
  if (!contains(op.range, port)) return notInRange(op.range);
  if (op.inStore.has(port) || op.allocated.includes(port)) return ERR_PORT_ALLOCATED;
  op.allocated.push(port);
  return undefined;
}

/** AllocateNext: a free port, or undefined when the range is full. */
export function opAllocateNext(op: PortOp): number | undefined {
  if (op.dryRun) {
    // operation.go: one past the highest port of this request, starting after 32768 (the loop
    // that would check them is bounded by `port < 100` and never runs).
    const last = op.allocated.length === 0 ? 32768 : Math.max(...op.allocated);
    op.allocated.push(last + 1);
    return last + 1;
  }
  const { base, size } = op.range;
  const taken = (offset: number): boolean => op.inStore.has(base + offset) || op.allocated.includes(base + offset);
  let count = 0;
  for (let i = 0; i < size; i++) if (taken(i)) count++;
  if (count >= size) return undefined;
  const r = op.s.ctx.random('k8s.portallocator');
  const offset = calculateRangeOffset(op.range);
  const subrangeMax = size - offset;
  let found: number | undefined;
  const start = r.int(subrangeMax);
  for (let i = 0; i < subrangeMax && found === undefined; i++) {
    const at = offset + ((start + i) % subrangeMax);
    if (!taken(at)) found = at;
  }
  if (found === undefined && offset > 0) {
    const start2 = r.int(offset);
    for (let i = 0; i < offset && found === undefined; i++) {
      const at = (start2 + i) % offset;
      if (!taken(at)) found = at;
    }
  }
  if (found === undefined) return undefined;
  op.allocated.push(base + found);
  return base + found;
}

/** Writes allocations and releases to the RangeAllocation (one etcd write). Never in dry run. */
export function commitPorts(s: StrategyCtx, allocate: readonly number[], release: readonly number[]): void {
  if (s.dryRun || (allocate.length === 0 && release.length === 0)) return;
  const r = rangeOf(s);
  const set = new Set(allocatedNodePorts(s));
  for (const p of allocate) if (contains(r, p)) set.add(p);
  // Release: a port outside the range is a no-op (a warning in the server log).
  for (const p of release) set.delete(p);
  rangePut(s.etcd, NODE_PORTS_KEY, { range: rangeString(r), ports: [...set].sort((a, b) => a - b) });
}
