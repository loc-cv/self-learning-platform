// client-go's flowcontrol.Backoff as the kubelet uses it, without jitter, as plain data.
//
// upstream: staging/src/k8s.io/client-go/util/flowcontrol/backoff.go (Next, IsInBackOffSince,
// IsInBackOffSinceUpdate, Get, GC, hasExpired: `eventTime - lastUpdate > 2·maxDuration` unless a
// HasExpiredFunc is set); pkg/kubelet/kubelet.go (imageBackOff: 10 s initial, 300 s max;
// crashLoopBackOff: 10 s, 300 s, HasExpiredFunc `eventTime - lastUpdate > 600 s`).

import type { Millis } from '@simlab/kernel';

export interface BackoffEntry {
  backoff: Millis;
  lastUpdate: Millis;
}

export type BackoffTable = Record<string, BackoffEntry>;

export interface BackoffPolicy {
  initial: Millis;
  max: Millis;
  /** An entry older than this (eventTime − lastUpdate) has expired. */
  expiry: Millis;
}

/** kubelet.go: imageBackOffPeriod 10 s, MaxImageBackOff 300 s; default expiry 2·max. */
export const IMAGE_BACKOFF: BackoffPolicy = { initial: 10_000, max: 300_000, expiry: 600_000 };
/** kubelet.go: initialCrashLoopBackOff 10 s, MaxCrashLoopBackOff 300 s, expiry 600 s. */
export const CRASHLOOP_BACKOFF: BackoffPolicy = { initial: 10_000, max: 300_000, expiry: 600_000 };

function expired(e: BackoffEntry, eventTime: Millis, p: BackoffPolicy): boolean {
  return eventTime - e.lastUpdate > p.expiry;
}

/** Next(id, eventTime): start or double the back-off; lastUpdate is now. Returns the new table. */
export function next(t: BackoffTable, id: string, eventTime: Millis, now: Millis, p: BackoffPolicy): BackoffTable {
  const e = t[id];
  const backoff = !e || expired(e, eventTime, p) ? p.initial : Math.min(e.backoff * 2, p.max);
  return { ...t, [id]: { backoff, lastUpdate: now } };
}

/** IsInBackOffSince(id, eventTime): `now − eventTime < backoff` for a live entry. */
export function inBackoffSince(t: BackoffTable, id: string, eventTime: Millis, now: Millis, p: BackoffPolicy): boolean {
  const e = t[id];
  if (!e || expired(e, eventTime, p)) return false;
  return now - eventTime < e.backoff;
}

/** IsInBackOffSinceUpdate(id, now): `now − lastUpdate < backoff` for a live entry. */
export function inBackoffSinceUpdate(t: BackoffTable, id: string, now: Millis, p: BackoffPolicy): boolean {
  const e = t[id];
  if (!e || expired(e, now, p)) return false;
  return now - e.lastUpdate < e.backoff;
}

export function current(t: BackoffTable, id: string): Millis {
  return t[id]?.backoff ?? 0;
}

/** GC: drops entries that have expired at `now`. */
export function gc(t: BackoffTable, now: Millis, p: BackoffPolicy): BackoffTable {
  const out: BackoffTable = {};
  for (const k of Object.keys(t).sort()) if (!expired(t[k] as BackoffEntry, now, p)) out[k] = t[k] as BackoffEntry;
  return out;
}

/** Go's time.Duration.String() for whole milliseconds: `10s`, `1m20s`, `523ms`, `1.234s`, `2m3.456s`, `0s`. */
export function goDuration(ms: Millis): string {
  if (ms === 0) return '0s';
  const neg = ms < 0;
  let v = Math.abs(Math.trunc(ms));
  let out: string;
  if (v < 1000) out = `${v}ms`;
  else {
    const h = Math.floor(v / 3_600_000);
    v -= h * 3_600_000;
    const m = Math.floor(v / 60_000);
    v -= m * 60_000;
    const s = Math.floor(v / 1000);
    const frac = v % 1000;
    const secs = frac === 0 ? `${s}s` : `${s}.${String(frac).padStart(3, '0').replace(/0+$/, '')}s`;
    out = h > 0 ? `${h}h${m}m${secs}` : m > 0 ? `${m}m${secs}` : secs;
  }
  return neg ? `-${out}` : out;
}
