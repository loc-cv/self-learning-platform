// The attempt in progress as the page holds it: the worker sends the whole attempt now and then
// and each new input at once (`attempt.delta`), so the page always has the latest log. It goes
// two ways: to browser storage, synchronously when the page is hidden or reloaded (D-105), and to
// the server as records appended to data/attempts/<id>.jsonl (docs/LEARNING_MODEL.md §10), from
// which an unfinished attempt reopens by replay on any browser.

import type { Checkpoint, LoggedInput, Millis } from '@simlab/kernel';
import type { GradeReport } from '@simlab/learn';
import type { FromWorker, StoredAttempt } from '../protocol.ts';

type Delta = Extract<FromWorker, { type: 'attempt.delta' }>;

/** A line of an attempt's log on the server: the whole attempt, or what its current log gained. */
export type AttemptRecord =
  | { k: 'full'; attempt: StoredAttempt }
  | { k: 'delta'; from: number; inputs: LoggedInput[]; checkpoints: Checkpoint[]; end: Millis; report?: GradeReport };

/**
 * The attempt a server log describes: the last whole attempt and every delta after it that fits.
 * A delta that does not continue what is there (a beacon and a retry both arrived) is skipped.
 */
export function foldAttempt(records: readonly unknown[]): StoredAttempt | undefined {
  let a: StoredAttempt | undefined;
  for (const raw of records) {
    const r = raw as AttemptRecord;
    if (r.k === 'full' && r.attempt?.v === 1) a = structuredClone(r.attempt);
    else if (r.k === 'delta' && a && a.current.inputs.length === r.from) {
      a.current.inputs.push(...r.inputs);
      a.current.checkpoints.push(...r.checkpoints);
      a.current.end = r.end;
      if (r.report) a.report = r.report;
    }
  }
  return a;
}

/** Of two copies of the same attempt, the one that holds more of it. */
export function longerAttempt(x: StoredAttempt | undefined, y: StoredAttempt | undefined): StoredAttempt | undefined {
  if (!x || !y) return x ?? y;
  const size = (a: StoredAttempt): number => a.previous.length * 1e9 + a.current.inputs.length;
  return size(y) > size(x) ? y : x;
}

export interface AttemptKeeper {
  /** The attempt whose log follows; `id` names its log on the server (none: it is not sent). */
  begin(id: string | undefined): void;
  full(a: StoredAttempt): void;
  delta(d: Delta): void;
  /** Writes to storage now, and sends what waits for the server; false when storage refused it. */
  persist(final?: boolean): boolean;
  /** Forgets the attempt (another item starts). */
  clear(): void;
}

export interface KeeperOptions {
  askForFull(): void;
  onSaved(ok: boolean): void;
  delay?: number;
  /** Appends records to the attempt's log on the server; resolves false when it could not. */
  send?(id: string, records: AttemptRecord[], final: boolean): Promise<boolean>;
  /** How long records wait before they are sent together (ms). */
  sendDelay?: number;
}

export function createAttemptKeeper(save: (a: StoredAttempt) => boolean, opts: KeeperOptions): AttemptKeeper {
  let current: StoredAttempt | undefined;
  let id: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  /** Records not yet confirmed by the server, oldest first, and whether a request is under way. */
  let waiting: AttemptRecord[] = [];
  let sending = false;
  /** What the server's copy holds once `waiting` has arrived: resets and inputs of the current log. */
  let remote: { previous: number; inputs: number; checkpoints: number; report?: number } | undefined;

  const flushRemote = (final: boolean): void => {
    clearTimeout(sendTimer);
    sendTimer = undefined;
    const to = id;
    if (!opts.send || to === undefined || waiting.length === 0 || (sending && !final)) return;
    const batch = waiting;
    waiting = [];
    sending = true;
    void opts.send(to, batch, final).then(
      (ok) => ok,
      () => false,
    ).then((ok) => {
      sending = false;
      // Not arrived: the next whole attempt replaces everything, so nothing has to be resent in order.
      if (!ok && id === to) remote = undefined;
      if (waiting.length > 0) flushRemote(false);
    });
  };
  const queue = (r: AttemptRecord): void => {
    if (!opts.send || id === undefined) return;
    waiting.push(r);
    sendTimer ??= setTimeout(() => flushRemote(false), opts.sendDelay ?? 2_000);
  };
  const persist = (final = false): boolean => {
    clearTimeout(timer);
    timer = undefined;
    flushRemote(final);
    if (!current) return true;
    const ok = save(current);
    opts.onSaved(ok);
    return ok;
  };
  const soon = (): void => {
    timer ??= setTimeout(() => persist(), opts.delay ?? 300);
  };
  const withId = (a: StoredAttempt): StoredAttempt => (id === undefined ? a : { ...a, id });
  return {
    begin(next) {
      flushRemote(false);
      id = next;
      remote = undefined;
      waiting = [];
    },
    full(a) {
      const had = remote;
      current = withId(a);
      const inputs = a.current.inputs.length;
      // The worker sends the whole attempt after every lab action. When it only continues what the
      // server has, a delta says the same in far fewer bytes.
      if (had && had.previous === a.previous.length && inputs >= had.inputs && a.current.checkpoints.length >= had.checkpoints) {
        // The report goes once: it is the largest part of a record.
        const report = a.report && a.report.at !== had.report ? a.report : undefined;
        if (inputs > had.inputs || a.current.checkpoints.length > had.checkpoints || report) queue({ k: 'delta', from: had.inputs, inputs: a.current.inputs.slice(had.inputs), checkpoints: a.current.checkpoints.slice(had.checkpoints), end: a.current.end, ...(report ? { report } : {}) });
      } else queue({ k: 'full', attempt: structuredClone(current) });
      remote = { previous: a.previous.length, inputs, checkpoints: a.current.checkpoints.length, ...(a.report ? { report: a.report.at } : {}) };
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
      if (remote && remote.inputs === d.from) {
        if (d.inputs.length > 0 || d.checkpoints.length > 0) queue({ k: 'delta', from: d.from, inputs: d.inputs, checkpoints: d.checkpoints, end: d.end });
        remote = { ...remote, inputs: d.from + d.inputs.length, checkpoints: remote.checkpoints + d.checkpoints.length };
      } else if (opts.send && id !== undefined) opts.askForFull();
      soon();
    },
    persist,
    clear() {
      clearTimeout(timer);
      timer = undefined;
      flushRemote(false);
      current = undefined;
      id = undefined;
      remote = undefined;
    },
  };
}

/** The server's attempt logs, as the keeper and the resume use them. */
export function attemptApi() {
  const url = (id: string): string => `/api/attempts/${encodeURIComponent(id)}`;
  return {
    async send(id: string, records: AttemptRecord[], final: boolean): Promise<boolean> {
      const body = JSON.stringify({ records });
      if (final) return navigator.sendBeacon(url(id), new Blob([body], { type: 'application/json' }));
      const r = await fetch(url(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return r.ok;
    },
    /** The attempt the server's log describes; undefined when it has none or cannot be reached. */
    async load(id: string): Promise<StoredAttempt | undefined> {
      try {
        const r = await fetch(url(id));
        if (!r.ok) return undefined;
        const lines = (await r.text()).split('\n').filter((l) => l.trim() !== '');
        return foldAttempt(lines.map((l) => JSON.parse(l) as unknown));
      } catch {
        return undefined;
      }
    },
  };
}
