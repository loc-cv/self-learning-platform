// The page's side of the worker protocol: one engine worker, terminal output buffered per
// terminal until its view attaches (a replay fills terminals before they are drawn), and
// request/response for lab actions and terminal opening.

import type { FromWorker, LabAction, LabResult, LabState, ToWorker } from '../protocol.ts';

type Listener = (m: FromWorker) => void;

export interface EngineClient {
  send(m: ToWorker): void;
  /** Every message except terminal output. Returns an unsubscribe function. */
  on(fn: Listener): () => void;
  /** Output for one terminal; what arrived before this call is delivered first. */
  attach(tty: string, fn: (data: string) => void): () => void;
  /** Drops buffered output of terminals that no longer exist. */
  forget(tty: string): void;
  openTty(cols: number, rows: number): Promise<string>;
  lab(action: LabAction): Promise<{ result: LabResult; state: LabState }>;
  /** Called with every message as it arrives, before listeners: the latency probe uses it. */
  tap?: (m: FromWorker) => void;
}

export function createEngineClient(worker: { postMessage(m: ToWorker): void; onmessage: ((e: MessageEvent<FromWorker>) => void) | null }): EngineClient {
  const listeners = new Set<Listener>();
  const sinks = new Map<string, (data: string) => void>();
  const pending = new Map<string, string[]>();
  const waiting = new Map<number, (m: FromWorker) => void>();
  let req = 0;
  const client: EngineClient = {
    send: (m) => worker.postMessage(m),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    attach(tty, fn) {
      sinks.set(tty, fn);
      const buffered = pending.get(tty);
      pending.delete(tty);
      if (buffered) fn(buffered.join(''));
      return () => {
        if (sinks.get(tty) === fn) sinks.delete(tty);
      };
    },
    forget(tty) {
      pending.delete(tty);
      sinks.delete(tty);
    },
    openTty(cols, rows) {
      const id = ++req;
      return new Promise((ok) => {
        waiting.set(id, (m) => ok((m as Extract<FromWorker, { type: 'tty.opened' }>).tty));
        worker.postMessage({ type: 'tty.open', req: id, cols, rows });
      });
    },
    lab(action) {
      const id = ++req;
      return new Promise((ok) => {
        waiting.set(id, (m) => {
          const r = m as Extract<FromWorker, { type: 'lab.result' }>;
          ok({ result: r.result, state: r.state });
        });
        worker.postMessage({ type: 'lab', req: id, action });
      });
    },
  };
  worker.onmessage = (e) => {
    const m = e.data;
    client.tap?.(m);
    if (m.type === 'tty.out') {
      const sink = sinks.get(m.tty);
      if (sink) sink(m.data);
      else pending.set(m.tty, [...(pending.get(m.tty) ?? []), m.data]);
      return;
    }
    if (m.type === 'tty.opened' || m.type === 'lab.result') {
      const w = waiting.get(m.req);
      waiting.delete(m.req);
      w?.(m);
    }
    for (const fn of listeners) fn(m);
  };
  return client;
}
