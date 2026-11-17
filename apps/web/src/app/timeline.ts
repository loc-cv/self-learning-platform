// The pure parts of the trace on screen (docs/DESIGN.md §7, X-ray timeline; PLAN.md §6.5): the
// page's copy of the events the worker sends, virtual time as offsets from the attempt's start,
// the timeline's scale, ticks, clusters and hit testing, and stepping the playhead from mark to
// mark. Nothing here draws or names a domain; Timeline.tsx renders it.

import type { ViewEvent } from '@simlab/kernel';
import type { TimelineMark } from '../protocol.ts';

/** What the page holds of the trace: the events by id order, the learner's lab actions, and the attempt's start. */
export interface TraceState {
  events: ViewEvent[];
  marks: TimelineMark[];
  /** Virtual time the attempt's world started at: offsets are counted from here. */
  start: number;
}

/**
 * The events after a message: `reset` replaces what the page has; otherwise each incoming event is
 * added, and one whose id is already there replaces it (a command that has now ended). Kept in id
 * order, which is record order.
 */
export function mergeEvents(prev: readonly ViewEvent[], incoming: readonly ViewEvent[], reset: boolean): ViewEvent[] {
  if (reset) return [...incoming].sort((a, b) => a.id - b.id);
  if (incoming.length === 0) return prev as ViewEvent[];
  const byId = new Map(prev.map((e) => [e.id, e]));
  let appended = true;
  const last = prev[prev.length - 1]?.id ?? -Infinity;
  for (const e of incoming) {
    if (byId.has(e.id) || e.id <= last) appended = false;
    byId.set(e.id, e);
  }
  // The common case, new events after the last one, needs no sort.
  if (appended) return [...prev, ...[...incoming].sort((a, b) => a.id - b.id)];
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A moment as an offset from the start: `+0:47`, `+12:05`, `+1:02:03`; before the start (the
 * setup that built the world) `−0:12`. Whole seconds, rounded down.
 */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${sign}${h}:${pad2(m)}:${pad2(s % 60)}` : `${sign}${m}:${pad2(s % 60)}`;
}

/** How far a skip jumped, in words that fit a chip: `+0.4s`, `+47s`, `+2m 05s`, `+1h 00m`. */
export function formatJump(ms: number): string {
  if (ms < 1000) return `+${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `+${m}m ${pad2(s % 60)}s`;
  return `+${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** Virtual time on the timeline: `start`…`end` across the pixels `x0`…`x1`. */
export interface Scale {
  start: number;
  end: number;
  x0: number;
  x1: number;
}

/** The shortest span drawn: a timeline of a world that just started is not divided by zero. */
export const MIN_SPAN = 1000;

export function scaleOf(start: number, now: number, width: number, padding: number): Scale {
  return { start, end: Math.max(now, start + MIN_SPAN), x0: padding, x1: Math.max(padding + 1, width - padding) };
}

export function xOf(s: Scale, t: number): number {
  const f = (Math.min(Math.max(t, s.start), s.end) - s.start) / (s.end - s.start);
  return s.x0 + f * (s.x1 - s.x0);
}

export function tOf(s: Scale, x: number): number {
  const f = (Math.min(Math.max(x, s.x0), s.x1) - s.x0) / (s.x1 - s.x0);
  return Math.round(s.start + f * (s.end - s.start));
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400].map((s) => s * 1000);

/** Ticks at a round step, about `every` pixels apart, labelled as offsets (`+2:00`). The start is not one. */
export function ticks(s: Scale, every = 90): { t: number; x: number; label: string }[] {
  const span = s.end - s.start;
  const want = Math.max(1, Math.floor((s.x1 - s.x0) / every));
  const step = TICK_STEPS.find((d) => span / d <= want) ?? (TICK_STEPS[TICK_STEPS.length - 1] as number);
  const out: { t: number; x: number; label: string }[] = [];
  for (let t = s.start + step; t < s.end; t += step) out.push({ t, x: xOf(s, t), label: formatOffset(t - s.start) });
  return out;
}

/** The rows of the timeline: what the learner did, what the system did, and the bookkeeping around it. */
export type Lane = 'input' | 'key' | 'detail';

/** One thing on the timeline: an event (a command is one too), or a lab action of the learner. */
export type TimelineItem = { kind: 'event'; t: number; event: ViewEvent } | { kind: 'mark'; t: number; mark: TimelineMark };

export function laneOf(i: TimelineItem): Lane {
  if (i.kind === 'mark' || i.event.input === true) return 'input';
  return i.event.level === 'key' ? 'key' : 'detail';
}

/** Everything the timeline can show, in time order (record order within an instant); detail events only when asked for. */
export function timelineItems(trace: TraceState, detail: boolean): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const e of trace.events) if (detail || e.input === true || e.level === 'key') items.push({ kind: 'event', t: e.t, event: e });
  for (const m of trace.marks) items.push({ kind: 'mark', t: m.t, mark: m });
  // Stable: events keep their id order within an instant, marks follow them.
  return items.map((i, n) => ({ i, n })).sort((a, b) => a.i.t - b.i.t || a.n - b.n).map((x) => x.i);
}

/** Marks of one lane closer than a few pixels, drawn as one with a count. */
export interface Cluster {
  lane: Lane;
  /** Where it is drawn: the position of its newest item. */
  x: number;
  t0: number;
  t1: number;
  items: TimelineItem[];
  /** How it reads: bad if one of its items hurt, else good if one helped, else neutral. */
  tone: 'good' | 'bad' | 'neutral';
}

function toneOf(i: TimelineItem): Cluster['tone'] {
  if (i.kind === 'mark') return i.mark.action === 'check' ? (i.mark.passed ? 'good' : 'bad') : 'neutral';
  return i.event.tone;
}

const worse = (a: Cluster['tone'], b: Cluster['tone']): Cluster['tone'] => (a === 'bad' || b === 'bad' ? 'bad' : a === 'good' || b === 'good' ? 'good' : 'neutral');

/**
 * Groups each lane's items left to right: an item within `gap` pixels of the cluster before it
 * joins it. A cluster sits where its newest item is, so the newest moment of a burst is what a
 * click reaches.
 */
export function cluster(items: readonly TimelineItem[], s: Scale, gap = 7): Cluster[] {
  const out: Cluster[] = [];
  const open = new Map<Lane, Cluster>();
  for (const i of items) {
    const lane = laneOf(i);
    const x = xOf(s, i.t);
    const c = open.get(lane);
    if (c && x - c.x <= gap) {
      c.items.push(i);
      c.x = x;
      c.t1 = i.t;
      c.tone = worse(c.tone, toneOf(i));
      continue;
    }
    const n: Cluster = { lane, x, t0: i.t, t1: i.t, items: [i], tone: toneOf(i) };
    open.set(lane, n);
    out.push(n);
  }
  return out;
}

/** The cluster nearest to `x` within `radius` pixels, in `lane` if given; the newer one on a tie. */
export function hit(clusters: readonly Cluster[], x: number, lane?: Lane, radius = 8): Cluster | undefined {
  let best: Cluster | undefined;
  let d = Infinity;
  for (const c of clusters) {
    if (lane !== undefined && c.lane !== lane) continue;
    const dc = Math.abs(c.x - x);
    if (dc <= radius && dc <= d) [best, d] = [c, dc];
  }
  return best;
}

/**
 * The moment the playhead goes to from `t` (undefined: now) when stepped: the time of the next or
 * the previous distinct item. Stepping back from now goes to the newest item; stepping forward past
 * the newest returns undefined (now).
 */
export function stepTime(items: readonly TimelineItem[], t: number | undefined, dir: -1 | 1): number | undefined {
  const times = [...new Set(items.map((i) => i.t))].sort((a, b) => a - b);
  if (times.length === 0) return t;
  if (dir < 0) {
    if (t === undefined) return times[times.length - 1];
    const before = times.filter((x) => x < t);
    return before.length > 0 ? before[before.length - 1] : times[0];
  }
  if (t === undefined) return undefined;
  return times.find((x) => x > t);
}

/** The newest item at or before `t`: what the readout names for a moment between marks. */
export function itemAt(items: readonly TimelineItem[], t: number): TimelineItem | undefined {
  let found: TimelineItem | undefined;
  for (const i of items) {
    if (i.t > t) break;
    found = i;
  }
  return found;
}

/**
 * Requests where only the newest answer matters (the view of a past moment while the playhead is
 * dragged): one request in flight at a time; what was asked meanwhile is replaced by the newest
 * value and sent when the answer arrives. `cancel` drops what waits and makes a late answer stale.
 */
export function createLatest<T, R>(send: (v: T) => Promise<R>, apply: (r: R, v: T) => void) {
  let busy = false;
  let waiting: { v: T } | undefined;
  let generation = 0;
  const go = (v: T): void => {
    busy = true;
    const g = generation;
    void send(v).then((r) => {
      // A cancelled request's answer changes nothing, not even whether one is in flight.
      if (g !== generation) return;
      busy = false;
      if (waiting) {
        const next = waiting.v;
        waiting = undefined;
        go(next);
        return;
      }
      apply(r, v);
    });
  };
  return {
    push(v: T): void {
      if (busy) waiting = { v };
      else go(v);
    },
    cancel(): void {
      generation++;
      waiting = undefined;
      busy = false;
    },
  };
}

/** The speed after `speed` in `speeds`, wrapping to the first; an unknown speed goes to the first. */
export function nextSpeed(speed: number, speeds: readonly number[]): number {
  const i = speeds.indexOf(speed);
  return speeds[i === -1 ? 0 : (i + 1) % speeds.length] as number;
}
