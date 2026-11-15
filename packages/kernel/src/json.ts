// Plain data: the only kind of value world state may hold (CLAUDE.md hard rule 5,
// docs/ARCHITECTURE.md §2.1).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Freezes `value` and everything reachable from it. A subtree that is already frozen is assumed
 * to be deeply frozen (it was frozen by this function) and is not visited again, which keeps
 * freezing a new inode that shares an old content string cheap.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** True for arrays and objects whose prototype is `Object.prototype` or `null`. */
export function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Throws if `value` holds anything but JSON data: `undefined`, functions, symbols, bigints,
 * non-finite numbers, class instances (`Map`, `Set`, `Date`, …), typed arrays or cycles.
 * Used by snapshot and by tests; the hot paths rely on the same checks in `hashNode`.
 */
export function assertPlainData(value: unknown, path = '$'): void {
  const onPath = new Set<object>();
  const visit = (v: unknown, at: string): void => {
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`${at}: ${String(v)} is not JSON data`);
        return;
      case 'object':
        break;
      default:
        throw new TypeError(`${at}: a ${typeof v} is not JSON data`);
    }
    if (v === null) return;
    if (!isPlainContainer(v)) {
      throw new TypeError(`${at}: an instance of ${v.constructor?.name ?? 'unknown'} is not JSON data`);
    }
    if (onPath.has(v)) throw new TypeError(`${at}: cycle`);
    onPath.add(v);
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${at}[${i}]`));
    } else {
      for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key], `${at}.${key}`);
    }
    onPath.delete(v);
  };
  visit(value, path);
}
