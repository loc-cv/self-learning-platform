// The page's side of the worker protocol: one engine worker, terminal output buffered per
// terminal until its view attaches (a replay fills terminals before they are drawn), and
// request/response for lab actions, terminal opening, "why" and the view of a past moment.

import type { Millis, ViewModel, Why } from '@simlab/kernel';
import type { Clock, FromWorker, LabAction, LabResult, LabState, ToWorker } from '../protocol.ts';

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
  /** A lab action; `step` names a lesson's guided task. The clock is the attempt's time when it ran. */
  lab(action: LabAction, step?: number): Promise<{ result: LabResult; state: LabState; clock: Clock }>;
  /**
   * Why an entity is in its state (assist level full; the worker records the question). The worker
   * ignores it below that level, and the promise then never settles: ask only when allowed.
   */
  why(entity: string): Promise<Why | undefined>;
  /** The view of a past moment of the attempt (assist level full), as `why`. `t` is clamped by the worker. */
  past(t: Millis): Promise<{ t: Millis; model: ViewModel }>;
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
    lab(action, step) {
      const id = ++req;
      return new Promise((ok) => {
        waiting.set(id, (m) => {
          const r = m as Extract<FromWorker, { type: 'lab.result' }>;
          ok({ result: r.result, state: r.state, clock: r.clock });
        });
        worker.postMessage(step === undefined ? { type: 'lab', req: id, action } : { type: 'lab', req: id, action, step });
      });
    },
    why(entity) {
      const id = ++req;
      return new Promise((ok) => {
        waiting.set(id, (m) => ok((m as Extract<FromWorker, { type: 'why' }>).why));
        worker.postMessage({ type: 'why', req: id, entity });
      });
    },
    past(t) {
      const id = ++req;
      return new Promise((ok) => {
        waiting.set(id, (m) => {
          const r = m as Extract<FromWorker, { type: 'past' }>;
          ok({ t: r.t, model: r.model });
        });
        worker.postMessage({ type: 'past', req: id, t });
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
    if (m.type === 'tty.opened' || m.type === 'lab.result' || m.type === 'why' || m.type === 'past') {
      const w = waiting.get(m.req);
      waiting.delete(m.req);
      w?.(m);
    }
    for (const fn of listeners) fn(m);
  };
  return client;
}
