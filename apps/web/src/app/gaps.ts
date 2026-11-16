// The browser's half of the gap log (docs/FIDELITY.md §4.4): every `[sim]` notice of this session
// is listed in the top bar and posted to the local server, which appends it to data/gaps.jsonl.
// A replay's notices were posted when they first happened and are listed only.

import type { GapEvent } from '@simlab/kernel';

export interface GapEntry {
  gap: GapEvent;
  item: string;
  /** Wall-clock time the page saw it. */
  seenAt: number;
  replayed: boolean;
}

export interface EngineVersions {
  version: string;
  kubernetes: string;
}

export type SinkState = 'idle' | 'ok' | 'unreachable';

/**
 * `post` sends a batch; `beacon` sends one while the page goes away (navigator.sendBeacon), so a
 * notice hit just before closing the tab is not lost.
 */
export function createGapSink(post: (body: string) => Promise<{ ok: boolean }>, onState: (s: SinkState) => void, beacon?: (body: string) => boolean) {
  let queue: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (leaving = false): void => {
    clearTimeout(timer);
    timer = undefined;
    const records = queue;
    queue = [];
    if (records.length === 0) return;
    const body = JSON.stringify({ records });
    if (leaving && beacon) {
      onState(beacon(body) ? 'ok' : 'unreachable');
      return;
    }
    post(body).then(
      (r) => onState(r.ok ? 'ok' : 'unreachable'),
      () => onState('unreachable'),
    );
  };
  return {
    add(e: GapEntry, engine: EngineVersions): void {
      if (e.replayed) return;
      queue.push({ ...e.gap, context: { ...e.gap.context, item: e.item }, engine });
      timer ??= setTimeout(() => flush(), 300);
    },
    flush,
  };
}
