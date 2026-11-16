// Human-readable durations, and the age of a timestamp on the kernel clock.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/duration/duration.go HumanDuration,
// ShortHumanDuration; pkg/printers/internalversion/printers.go translateTimestampSince,
// translateMicroTimestampSince (time.Since: the reader's clock, here the virtual one).
//
// Durations are in microseconds (the precision of metav1.MicroTime; the kernel clock is in ms).
// Go's int(d.Seconds()) truncates toward zero and d / time.Minute is integer division; the
// branches below only see d >= 0 once the "almost now" cases are out.

import type { Millis } from '@simlab/kernel';
import type { Json } from '../apimachinery/json.ts';
import { parseTime } from '../apimachinery/time.ts';

const US_SECOND = 1_000_000;
const US_MINUTE = 60 * US_SECOND;
const US_HOUR = 60 * US_MINUTE;

const div = (a: number, b: number): number => Math.trunc(a / b);

/** duration.HumanDuration: ~2–3 significant figures. */
export function humanDuration(us: number): string {
  const seconds = div(us, US_SECOND);
  if (seconds < -1) return '<invalid>';
  if (seconds < 0) return '0s';
  if (seconds < 60 * 2) return `${seconds}s`;
  const minutes = div(us, US_MINUTE);
  if (minutes < 10) {
    const s = div(us, US_SECOND) % 60;
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`;
  }
  if (minutes < 60 * 3) return `${minutes}m`;
  const hours = div(us, US_HOUR);
  if (hours < 8) {
    const m = div(us, US_MINUTE) % 60;
    return m === 0 ? `${hours}h` : `${hours}h${m}m`;
  }
  if (hours < 48) return `${hours}h`;
  if (hours < 24 * 8) {
    const h = hours % 24;
    return h === 0 ? `${div(hours, 24)}d` : `${div(hours, 24)}d${h}h`;
  }
  if (hours < 24 * 365 * 2) return `${div(hours, 24)}d`;
  if (hours < 24 * 365 * 8) {
    const dy = div(hours, 24) % 365;
    return dy === 0 ? `${div(hours, 24 * 365)}y` : `${div(hours, 24 * 365)}y${dy}d`;
  }
  return `${div(hours, 24 * 365)}y`;
}

/** duration.ShortHumanDuration: one unit. */
export function shortHumanDuration(us: number): string {
  const seconds = div(us, US_SECOND);
  if (seconds < -1) return '<invalid>';
  if (seconds < 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = div(us, US_MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = div(us, US_HOUR);
  if (hours < 24) return `${hours}h`;
  if (hours < 24 * 365) return `${div(hours, 24)}d`;
  return `${div(hours, 24 * 365)}y`;
}

/**
 * A metav1.Time or MicroTime from JSON as microseconds since the epoch, or undefined for the zero
 * time (null or absent on the wire, or Go's year-1 zero value).
 */
export function timestampMicros(v: Json | undefined): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const r = parseTime(v, false);
  if ('error' in r) return undefined;
  return r.micros === GO_ZERO_TIME_MICROS ? undefined : r.micros;
}

// time.Time{}: 0001-01-01T00:00:00Z.
const GO_ZERO_TIME_MICROS = -62135596800 * US_SECOND;

/** translateTimestampSince / translateMicroTimestampSince: `<unknown>` for the zero time. */
export function translateTimestampSince(v: Json | undefined, now: Millis): string {
  return since(timestampMicros(v), now);
}

/** The same for a time already parsed (µs since the epoch; undefined is the zero time). */
export function since(t: number | undefined, now: Millis): string {
  return t === undefined ? '<unknown>' : humanDuration(now * 1000 - t);
}
