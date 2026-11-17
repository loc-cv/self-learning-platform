// The page's copy of the progress log (docs/LEARNING_MODEL.md §5, §10, §12): loaded from the
// server once, kept as the derived state, and written through an outbox. Every event is applied
// to the state at once and posted in order; what the server has not confirmed stays in browser
// storage, so a reload, a closed tab or a server that is not running loses nothing. With no
// server at all (a static host) the outbox is the log.

import { eventProblem, initialState, parseLog, replay, type ProgressEvent, type ProgressState } from '@simlab/learn';
import type { KeyValue } from './storage.ts';

export type SyncState = 'loading' | 'synced' | 'pending' | 'offline';

export interface ProgressStore {
  /** Resolves when the log is loaded (from the server, or from the outbox alone). */
  readonly ready: Promise<void>;
  state(): ProgressState;
  /** Changes with every event: what `useSyncExternalStore` compares. */
  version(): number;
  sync(): SyncState;
  /** Applies the events and queues them for the server. An event the schema refuses throws. */
  record(events: readonly ProgressEvent[]): void;
  subscribe(fn: () => void): () => void;
  /** Sends what is waiting; `final` uses a beacon (the page is going away). */
  flush(final?: boolean): void;
}

export interface ProgressIo {
  /** The log as NDJSON; rejects or returns undefined when there is no server. */
  load(): Promise<string | undefined>;
  post(body: string): Promise<boolean>;
  beacon?(body: string): boolean;
}

export const OUTBOX_KEY = 'simlab.progress.outbox.v1';
/** How long after a failed post the next one is tried (ms). */
export const RETRY_MS = 5_000;

export function browserIo(): ProgressIo {
  return {
    async load() {
      const r = await fetch('/api/progress');
      return r.ok ? r.text() : undefined;
    },
    async post(body) {
      const r = await fetch('/api/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return r.ok;
    },
    beacon: (body) => navigator.sendBeacon('/api/progress', new Blob([body], { type: 'application/json' })),
  };
}

export function createProgressStore(io: ProgressIo, kv: KeyValue | undefined, timers: { set(fn: () => void, ms: number): unknown } = { set: (fn, ms) => setTimeout(fn, ms) }): ProgressStore {
  let state = initialState();
  let version = 0;
  let sync: SyncState = 'loading';
  let loaded = false;
  let sending = false;
  let retry = false;
  const listeners = new Set<() => void>();

  const readOutbox = (): ProgressEvent[] => {
    try {
      const raw = kv?.getItem(OUTBOX_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? (list.filter((e) => eventProblem(e) === undefined) as ProgressEvent[]) : [];
    } catch {
      return [];
    }
  };
  let outbox = readOutbox();
  const writeOutbox = (): void => {
    try {
      if (outbox.length === 0) kv?.removeItem(OUTBOX_KEY);
      else kv?.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    } catch {
      // Storage is full or absent: the events are still in memory and go out with the next post.
    }
  };
  const notify = (): void => {
    version++;
    for (const fn of listeners) fn();
  };
  const setSync = (s: SyncState): void => {
    if (s === sync) return;
    sync = s;
    notify();
  };

  const send = async (): Promise<void> => {
    if (sending || !loaded || outbox.length === 0) return;
    sending = true;
    const batch = outbox.slice();
    const ok = await io.post(JSON.stringify({ events: batch })).catch(() => false);
    sending = false;
    if (ok) {
      outbox = outbox.slice(batch.length);
      writeOutbox();
      setSync(outbox.length === 0 ? 'synced' : 'pending');
      if (outbox.length > 0) void send();
    } else {
      setSync('offline');
      if (!retry) {
        retry = true;
        timers.set(() => {
          retry = false;
          void send();
        }, RETRY_MS);
      }
    }
  };

  const ready = (async () => {
    let text: string | undefined;
    try {
      text = await io.load();
    } catch {
      text = undefined;
    }
    let server: ProgressEvent[] = [];
    if (text !== undefined) {
      server = parseLog(text);
      // A beacon sent while the page went away may have arrived: what the server has is not sent again.
      const have = new Set(server.map((e) => JSON.stringify(e)));
      outbox = outbox.filter((e) => !have.has(JSON.stringify(e)));
      writeOutbox();
    }
    state = replay([...server, ...outbox]);
    loaded = true;
    sync = text === undefined ? 'offline' : outbox.length === 0 ? 'synced' : 'pending';
    notify();
    void send();
  })();

  return {
    ready,
    state: () => state,
    version: () => version,
    sync: () => sync,
    record(events) {
      if (events.length === 0) return;
      for (const e of events) {
        const problem = eventProblem(e);
        if (problem) throw new Error(`not a progress event: ${problem}`);
      }
      state = replay(events, state);
      outbox = [...outbox, ...events];
      writeOutbox();
      if (sync === 'synced') sync = 'pending';
      notify();
      void send();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flush(final = false) {
      if (final && outbox.length > 0 && loaded && !sending && io.beacon) {
        // The outbox is kept: the next load drops what the server turns out to have.
        io.beacon(JSON.stringify({ events: outbox }));
        return;
      }
      void send();
    },
  };
}
