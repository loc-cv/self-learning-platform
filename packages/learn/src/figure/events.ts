// The trace in figures (PLAN.md §6.1, §6.5): the events a kernel recorded since some point, the
// event a scene's frame is anchored to, and the causes that travelled along relations of a
// drawing. Domain-agnostic: events come from the view providers through the kernel's contract.

import { buildEvents, type Kernel, type Registry, type ViewEvent, type ViewModel } from '@simlab/kernel';
import { parseDuration } from '../item/duration.ts';
import { resolveRef } from './focus.ts';
import type { FrameAnchor } from './types.ts';

/** Every event the kernel's trace holds, oldest first. */
export function eventsOf(registry: Registry, kernel: Kernel): ViewEvent[] {
  return buildEvents(registry, kernel.traceRecords());
}

/** The id of the newest trace record, 0 for an empty trace. */
export function lastRecord(kernel: Kernel): number {
  const records = kernel.traceRecords();
  return records[records.length - 1]?.id ?? 0;
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is');
}

/** Whether `e` is what the anchor describes, in the whole view `model` of the world at that time. */
export function matchesAnchor(e: ViewEvent, at: FrameAnchor, model: ViewModel): boolean {
  if (at.actor !== undefined && !glob(at.actor).test(e.actor)) return false;
  if (at.text !== undefined && !glob(at.text).test(e.text)) return false;
  if (at.about !== undefined) {
    const ids = resolveRef(model, at.about);
    if (!ids.some((id) => e.about.includes(id))) return false;
  }
  return true;
}

export const ANCHOR_WITHIN = '5m';

export type AnchorResult = { event: ViewEvent } | { problem: string };

/**
 * Waits for the anchor's event: one recorded after record `since` already counts if it was
 * recorded at this very instant; otherwise time advances event by event until one matches or
 * `within` has passed. An event that matched earlier than now cannot be drawn any more, and says so.
 */
export function awaitAnchor(kernel: Kernel, registry: Registry, at: FrameAnchor, since: number, view: () => ViewModel): AnchorResult {
  const describe = [at.actor && `actor ${at.actor}`, at.about && `about ${at.about}`, at.text && `text ${at.text}`].filter(Boolean).join(', ') || 'any event';
  const find = (): ViewEvent | undefined => {
    const model = view();
    return eventsOf(registry, kernel).find((e) => e.id > since && matchesAnchor(e, at, model));
  };
  const deadline = kernel.now + parseDuration(at.within ?? ANCHOR_WITHIN);
  let seen = -1;
  for (;;) {
    const newest = lastRecord(kernel);
    if (newest !== seen) {
      seen = newest;
      const e = find();
      if (e) {
        if (e.t === kernel.now) return { event: e };
        return { problem: `the event (${describe}) was recorded ${kernel.now - e.t} ms before the frame could be drawn, while its steps were still running; move the steps that wait to a later frame` };
      }
    }
    const next = kernel.nextEventTime();
    if (next === undefined || next > deadline) return { problem: `no event (${describe}) was recorded within ${at.within ?? ANCHOR_WITHIN}` };
    kernel.runUntil(next);
  }
}

/** The links of `events` whose two ends are drawn in `model`, each pair once, in event order. */
export function linksIn(events: readonly ViewEvent[], model: ViewModel): { from: string; to: string }[] {
  const ids = new Set(model.entities.map((e) => e.id));
  const seen = new Set<string>();
  const out: { from: string; to: string }[] = [];
  for (const e of events) {
    if (!e.link || !ids.has(e.link.from) || !ids.has(e.link.to)) continue;
    const key = `${e.link.from}\u0000${e.link.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.link.from, to: e.link.to });
  }
  return out;
}

/** The events that concern a drawing: about one of its entities, or about nothing in particular. */
export function eventsIn(events: readonly ViewEvent[], model: ViewModel): ViewEvent[] {
  const ids = new Set(model.entities.map((e) => e.id));
  return events.filter((e) => e.about.length === 0 || e.about.some((id) => ids.has(id)));
}
