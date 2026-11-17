import { describe, expect, it } from 'vitest';
import { PROGRESS_VERSION, type ProgressEvent } from '@simlab/learn';
import { createProgressStore, OUTBOX_KEY, type ProgressIo } from './progress.ts';

const started = (attempt: string, at: number): ProgressEvent => ({ v: PROGRESS_VERSION, type: 'attempt.started', at, attempt, item: 'x.a.b-01', seed: 1, mode: 'free' });

function memory() {
  const m = new Map<string, string>();
  return { m, kv: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
}

function server(up = true) {
  const lines: string[] = [];
  const s = { up, lines, posts: 0 };
  const io: ProgressIo = {
    load: async () => (s.up ? lines.map((l) => `${l}\n`).join('') : undefined),
    post: async (body) => {
      if (!s.up) return false;
      s.posts++;
      for (const e of (JSON.parse(body) as { events: unknown[] }).events) lines.push(JSON.stringify(e));
      return true;
    },
  };
  return { s, io };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the progress store', () => {
  it('applies an event at once and posts it; the outbox empties when the server has it', async () => {
    const { s, io } = server();
    const { m, kv } = memory();
    const store = createProgressStore(io, kv);
    await store.ready;
    store.record([started('a1', 1000)]);
    expect(Object.keys(store.state().open)).toEqual(['a1']);
    expect(m.has(OUTBOX_KEY)).toBe(true);
    await settle();
    expect(s.lines).toHaveLength(1);
    expect(m.has(OUTBOX_KEY)).toBe(false);
    expect(store.sync()).toBe('synced');
  });

  it('keeps events while the server is away and sends them in order when it is back', async () => {
    const { s, io } = server(false);
    const { kv } = memory();
    const retries: (() => void)[] = [];
    const store = createProgressStore(io, kv, { set: (fn) => retries.push(fn) });
    await store.ready;
    store.record([started('a1', 1000)]);
    store.record([started('a2', 2000)]);
    await settle();
    expect(store.sync()).toBe('offline');
    expect(s.lines).toHaveLength(0);
    // A new page finds the events in storage.
    const again = createProgressStore(server(false).io, kv, { set: () => undefined });
    await again.ready;
    expect(Object.keys(again.state().open).sort()).toEqual(['a1', 'a2']);
    s.up = true;
    for (const fn of retries.splice(0)) fn();
    await settle();
    expect(s.lines.map((l) => (JSON.parse(l) as { attempt: string }).attempt)).toEqual(['a1', 'a2']);
  });

  it('does not send again what a beacon already delivered', async () => {
    const { s, io } = server();
    const { m, kv } = memory();
    const e = started('a1', 1000);
    m.set(OUTBOX_KEY, JSON.stringify([e]));
    s.lines.push(JSON.stringify(e));
    const store = createProgressStore(io, kv);
    await store.ready;
    await settle();
    expect(s.posts).toBe(0);
    expect(s.lines).toHaveLength(1);
    expect(store.state().events).toBe(1);
  });

  it('refuses what is not an event', async () => {
    const { io } = server();
    const store = createProgressStore(io, memory().kv);
    await store.ready;
    expect(() => store.record([{ v: 1, type: 'attempt.started', at: 1 } as unknown as ProgressEvent])).toThrow(/not a progress event/);
  });
});
