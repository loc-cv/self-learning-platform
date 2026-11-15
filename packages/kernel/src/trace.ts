// Trace and gap records: what leaves the engine through write-only ports
// (docs/ARCHITECTURE.md §2.9, §2.10; docs/FIDELITY.md §4.4). Neither is world state, and engine
// logic never reads either.

import type { Json } from './json.ts';
import type { Millis } from './civil.ts';

export interface TraceInput {
  /** Emitting component: `k8s.scheduler`, `host.systemd/controlplane`. */
  source: string;
  /** What happened, dotted: `pod.unschedulable`, `unit.failed`. */
  kind: string;
  /** What it is about, as a reference the UI can link: `pod/shop/web-5d7…`. */
  subject?: string;
  /** Human-readable cause, in the component's own terms (simulator vocabulary, not tool output). */
  message: string;
  data?: Json;
  /** Records this one follows from. */
  causes?: number[];
}

export interface TraceRecord extends TraceInput {
  /** Monotonic within a kernel runtime. */
  id: number;
  t: Millis;
  /** The event (`<seq>`), input (`in<n>`) or action label being handled when emitted. */
  during: string;
}

export type GapKind =
  | 'command' | 'unknown-command' | 'subcommand' | 'flag' | 'flag-value' | 'resource'
  | 'output-format' | 'field' | 'syntax' | 'behavior' | 'internal';

/** What engine code reports; the kernel completes it into a `GapEvent`. */
export interface GapInput {
  kind: GapKind;
  program: string;
  /** The unsupported thing, as printed in the notice. */
  what: string;
  /** The command line as typed, after alias expansion. */
  commandLine: string;
  /** Stable grouping key; defaults to `<kind>:<program>:<what>`. */
  key?: string;
  machine: string;
  error?: { message: string; stack?: string };
}

/**
 * A gap record as it leaves the engine. The sink adds what the engine cannot know: the wall-clock
 * `at`, the content item and the engine and domain versions (docs/FIDELITY.md §4.4 `GapRecord`).
 */
export interface GapEvent {
  v: 1;
  kind: GapKind;
  program: string;
  what: string;
  commandLine: string;
  key: string;
  context: { machine: string; seed: number; virtualTime: Millis };
  error?: { message: string; stack?: string };
}

export interface Ports {
  trace?: (record: TraceRecord) => void;
  gap?: (record: GapEvent) => void;
}

/** A bounded buffer of the most recent trace records. Oldest records are dropped first. */
export interface TraceBuffer {
  push(record: TraceRecord): void;
  /** The retained records, oldest first. */
  records(): TraceRecord[];
  /** How many records were dropped because the buffer was full. */
  dropped(): number;
}

export function createTraceBuffer(capacity: number): TraceBuffer {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('trace buffer capacity must be a positive integer');
  const ring: TraceRecord[] = [];
  let start = 0;
  let dropped = 0;
  return {
    push(record) {
      if (ring.length < capacity) {
        ring.push(record);
      } else {
        ring[start] = record;
        start = (start + 1) % capacity;
        dropped++;
      }
    },
    records: () => ring.slice(start).concat(ring.slice(0, start)),
    dropped: () => dropped,
  };
}
