// The attempt in progress as the page holds it: the worker sends the whole attempt now and then
// and each new input at once (`attempt.delta`), so the page always has the latest log and can
// write it to storage synchronously when it is hidden or reloaded (D-105).

import type { FromWorker, StoredAttempt } from '../protocol.ts';

type Delta = Extract<FromWorker, { type: 'attempt.delta' }>;

export interface AttemptKeeper {
  full(a: StoredAttempt): void;
  delta(d: Delta): void;
  /** Writes now; false when storage refused it. */
  persist(): boolean;
  /** Forgets the attempt (another item starts). */
  clear(): void;
}

export function createAttemptKeeper(save: (a: StoredAttempt) => boolean, opts: { askForFull(): void; onSaved(ok: boolean): void; delay?: number }): AttemptKeeper {
  let current: StoredAttempt | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = (): boolean => {
    clearTimeout(timer);
    timer = undefined;
    if (!current) return true;
    const ok = save(current);
    opts.onSaved(ok);
    return ok;
  };
  const soon = (): void => {
    timer ??= setTimeout(persist, opts.delay ?? 300);
  };
  return {
    full(a) {
      current = a;
      soon();
    },
    delta(d) {
      if (!current || current.current.inputs.length !== d.from) {
        opts.askForFull();
        return;
      }
      current.current.inputs.push(...d.inputs);
      current.current.checkpoints.push(...d.checkpoints);
      current.current.end = d.end;
      soon();
    },
    persist,
    clear() {
      clearTimeout(timer);
      timer = undefined;
      current = undefined;
    },
  };
}
