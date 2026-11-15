// Tables: containers whose entries are frozen values (docs/ARCHITECTURE.md §2.1).
// A table is mutable and belongs to one world; its entries may be shared between worlds.

import { deepFreeze } from './json.ts';

export type Table<V> = Record<string, V>;

/** Deep-freezes `value` and stores it under `key`. The only way entries enter a table. */
export function put<V>(table: Table<V>, key: string, value: V): V {
  table[key] = deepFreeze(value);
  return table[key];
}

export function remove<V>(table: Table<V>, key: string): void {
  delete table[key];
}

/**
 * Keys in code-unit order. Iteration whose result depends on order uses this, never `for…in`
 * or `Object.keys`, whose order puts integer-like keys first (CLAUDE.md hard rule 4).
 */
export function keys<V>(table: Table<V>): string[] {
  return Object.keys(table).sort(compareCodeUnits);
}

/** Code-unit order, independent of the host locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
