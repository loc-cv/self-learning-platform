// How long each step of a Pod's life takes on a node: one tunable table. Durations that upstream
// fixes (the PLEG relist, back-offs, resync intervals) are constants next to the code that uses
// them, with their source; the figures here are the simulator's model of work that takes real time
// on a real machine (CNI setup, registry round trips, unpacking, runc), chosen to match a small
// cloud VM. Each draw comes from its own PRNG stream, so adding a draw in one step does not change
// another step's timing.

import type { Ctx, Millis } from '@simlab/kernel';

export interface Range {
  min: Millis;
  max: Millis;
}

export interface LatencyTable {
  /** RunPodSandbox: the pause container, its network namespace and the CNI ADD. */
  sandbox: Range;
  /** RunPodSandbox for a hostNetwork Pod (no CNI). */
  sandboxHostNetwork: Range;
  /** StopPodSandbox: CNI DEL and stopping the pause container. */
  sandboxStop: Range;
  /** Resolving a reference: token, manifest HEAD and GET (also how long a failing pull takes). */
  registryResolve: Range;
  /** Download bandwidth, bytes per second. */
  bandwidth: Range;
  /** Unpacking into the snapshotter, bytes per second of compressed layers. */
  unpack: Range;
  /** A pull that fails on name resolution of the registry host. */
  dnsFailure: Range;
  /** CreateContainer: the OCI spec, the snapshot, the shim. */
  containerCreate: Range;
  /** StartContainer: runc start until the process runs. */
  containerStart: Range;
}

export const LATENCY: LatencyTable = {
  sandbox: { min: 350, max: 1100 },
  sandboxHostNetwork: { min: 120, max: 300 },
  sandboxStop: { min: 60, max: 180 },
  registryResolve: { min: 450, max: 1300 },
  bandwidth: { min: 25_000_000, max: 70_000_000 },
  unpack: { min: 90_000_000, max: 180_000_000 },
  dnsFailure: { min: 15, max: 60 },
  containerCreate: { min: 25, max: 90 },
  containerStart: { min: 70, max: 220 },
};

/** A uniform draw in `r` from the stream `k8s.kubelet.latency.<step>`. */
export function draw(ctx: Ctx, step: keyof LatencyTable, table: LatencyTable = LATENCY): Millis {
  const r = table[step];
  const span = r.max - r.min;
  return r.min + (span > 0 ? ctx.random(`k8s.kubelet.latency.${step}`).int(span + 1) : 0);
}

/** How long a pull of `bytes` takes after the reference is resolved: download plus unpack. */
export function transferTime(ctx: Ctx, bytes: number, table: LatencyTable = LATENCY): Millis {
  const bw = draw(ctx, 'bandwidth', table);
  const up = draw(ctx, 'unpack', table);
  return Math.round((bytes / bw) * 1000 + (bytes / up) * 1000);
}

/** wait.Jitter(d, factor): d plus a uniform fraction up to factor·d (apimachinery/pkg/util/wait). */
export function jitter(ctx: Ctx, stream: string, d: Millis, factor: number): Millis {
  return d + Math.floor(ctx.random(stream).float() * factor * d);
}
