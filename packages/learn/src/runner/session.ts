// What the runner hands steps and checks besides the kernel (docs/SCENARIO_FORMAT.md §6): a hub
// that fans the kernel's ports out to listeners, and the per-list StepSession over it.

import type { Entry, GapEvent, OutputRecord, Ports, StepSession, TraceRecord } from '@simlab/kernel';

/**
 * Ports are fixed when a kernel is created, so the runner creates every kernel it drives with a
 * hub's ports, and steps and checks add listeners for as long as they need them.
 */
export interface PortHub {
  readonly ports: Ports;
  /** Adds listeners; returns a function that removes them. */
  add(listener: Ports): () => void;
}

export function createPortHub(base?: Ports): PortHub {
  const listeners: Ports[] = base ? [base] : [];
  return {
    ports: {
      trace: (r: TraceRecord) => {
        for (const l of [...listeners]) l.trace?.(r);
      },
      gap: (g: GapEvent) => {
        for (const l of [...listeners]) l.gap?.(g);
      },
      output: (o: OutputRecord) => {
        for (const l of [...listeners]) l.output?.(o);
      },
    },
    add(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

export interface RunnerSession extends StepSession {
  /** Runs the `onEnd` callbacks (most recent first) and removes the listeners. */
  end(): void;
}

export function createStepSession(hub: PortHub, entry: Entry): RunnerSession {
  const locals = new Map<string, unknown>();
  const enders: (() => void)[] = [];
  const removers: (() => void)[] = [];
  let ended = false;
  return {
    entry,
    local<T>(key: string, create: () => T): T {
      if (!locals.has(key)) locals.set(key, create());
      return locals.get(key) as T;
    },
    onEnd(fn) {
      enders.push(fn);
    },
    listen(ports) {
      const remove = hub.add(ports);
      removers.push(remove);
      return remove;
    },
    end() {
      if (ended) return;
      ended = true;
      let failure: unknown;
      for (const fn of enders.reverse()) {
        try {
          fn();
        } catch (e) {
          failure ??= e;
        }
      }
      for (const r of removers) r();
      if (failure !== undefined) throw failure;
    },
  };
}
