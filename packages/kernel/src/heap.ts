// Binary min-heap of pending events ordered by (at, seq), stored as a plain array in the world
// (docs/ARCHITECTURE.md §2.3). Entries are frozen values; the array is a container, so a fork
// copies only the array of pointers.

import type { Json } from './json.ts';
import type { Millis } from './civil.ts';

export interface PendingEvent {
  /** Unique within the world: the `seq` it was scheduled with, as a string. */
  id: string;
  at: Millis;
  seq: number;
  /** Dotted, prefixed by the plugin that handles it: `host.proc.run`, `k8s.controller.sync`. */
  type: string;
  payload: Json;
  /** Id of the event or input being handled when this one was scheduled (§2.9). */
  cause?: string;
}

function before(a: PendingEvent, b: PendingEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

export function heapPush(heap: PendingEvent[], ev: PendingEvent): void {
  heap.push(ev);
  siftUp(heap, heap.length - 1);
}

export function heapPop(heap: PendingEvent[]): PendingEvent | undefined {
  const top = heap[0];
  if (top === undefined) return undefined;
  removeAt(heap, 0);
  return top;
}

/** Removes the entry at index `i`, keeping the heap property. */
export function removeAt(heap: PendingEvent[], i: number): void {
  const last = heap.pop() as PendingEvent;
  if (i === heap.length) return;
  heap[i] = last;
  siftDown(heap, i);
  siftUp(heap, i);
}

function siftUp(heap: PendingEvent[], i: number): void {
  const ev = heap[i] as PendingEvent;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const p = heap[parent] as PendingEvent;
    if (!before(ev, p)) break;
    heap[i] = p;
    i = parent;
  }
  heap[i] = ev;
}

function siftDown(heap: PendingEvent[], i: number): void {
  const n = heap.length;
  const ev = heap[i] as PendingEvent;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= n) break;
    const r = l + 1;
    const child = r < n && before(heap[r] as PendingEvent, heap[l] as PendingEvent) ? r : l;
    const c = heap[child] as PendingEvent;
    if (!before(c, ev)) break;
    heap[i] = c;
    i = child;
  }
  heap[i] = ev;
}
