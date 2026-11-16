// Browser storage: settings, and each item's attempt in progress so a reload resumes it by
// replay (docs/ARCHITECTURE.md §2.8). Durable storage through the server comes in phase 11; until
// then a private window or cleared site data loses the attempt, and every access is guarded.

import type { StoredAttempt } from '../protocol.ts';

export interface Settings {
  theme: 'dark' | 'light';
  /** Key bindings of the editor overlay for vim, vi and kubectl edit. */
  editorKeys: 'vim' | 'plain';
  /** Width of the lab panel in CSS pixels. */
  panelWidth: number;
  panelOpen: boolean;
  fontSize: number;
  /** Width of the X-ray in CSS pixels. Whether it is open is not stored: every attempt starts without it. */
  xrayWidth: number;
  /** Animation of change in views: as the system asks (prefers-reduced-motion), or reduced. */
  motion: 'system' | 'reduced';
}

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', editorKeys: 'vim', panelWidth: 440, panelOpen: true, fontSize: 14, xrayWidth: 520, motion: 'system' };

const SETTINGS = 'simlab.settings.v1';
const ACTIVE = 'simlab.active.v1';
const attemptKey = (item: string): string => `simlab.attempt.v1.${item}`;

/** Storage as an interface, so tests can give a map. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValue | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function createStore(kv: KeyValue | undefined = browserStorage()) {
  const read = (key: string): unknown => {
    try {
      const v = kv?.getItem(key);
      return v === null || v === undefined ? undefined : (JSON.parse(v) as unknown);
    } catch {
      return undefined;
    }
  };
  /** False when the value could not be stored (no storage, or over quota). */
  const write = (key: string, value: unknown): boolean => {
    try {
      if (!kv) return false;
      kv.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const remove = (key: string): void => {
    try {
      kv?.removeItem(key);
    } catch {
      // Nothing to do: the next read finds what is there.
    }
  };
  return {
    settings(): Settings {
      const s = read(SETTINGS);
      return { ...DEFAULT_SETTINGS, ...(typeof s === 'object' && s !== null ? (s as Partial<Settings>) : {}) };
    },
    saveSettings: (s: Settings): boolean => write(SETTINGS, s),
    active(): string | undefined {
      const a = read(ACTIVE);
      return typeof a === 'string' ? a : undefined;
    },
    setActive(item: string | undefined): void {
      if (item === undefined) remove(ACTIVE);
      else write(ACTIVE, item);
    },
    attempt(item: string): StoredAttempt | undefined {
      const a = read(attemptKey(item)) as StoredAttempt | undefined;
      return a?.v === 1 && a.item === item ? a : undefined;
    },
    saveAttempt: (a: StoredAttempt): boolean => write(attemptKey(a.item), a),
    dropAttempt: (item: string): void => remove(attemptKey(item)),
  };
}

export type Store = ReturnType<typeof createStore>;
