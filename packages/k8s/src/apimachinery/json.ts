// JSON values as the API machinery handles them: request bodies, stored objects, patches.

import type { Json } from '@simlab/kernel';

export type { Json };
export type JsonObject = { [key: string]: Json };

export function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A mutable deep copy (stored objects are frozen). */
export function cloneJson<T extends Json>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneJson(x)) as T;
  if (v !== null && typeof v === 'object') {
    const out: JsonObject = {};
    for (const k of Object.keys(v)) out[k] = cloneJson((v as JsonObject)[k] as Json);
    return out as T;
  }
  return v;
}

/** Structural equality; object key order does not matter (Go's reflect.DeepEqual on decoded values). */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as Json[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => k in bo && jsonEqual(ao[k], bo[k]));
}

/** `obj.a.b.c`, or undefined when a step is missing or not an object. */
export function getPath(obj: Json | undefined, ...path: string[]): Json | undefined {
  let cur: Json | undefined = obj;
  for (const p of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** The object at `obj.a.b`, created (as `{}`) where missing. */
export function ensureObject(obj: JsonObject, ...path: string[]): JsonObject {
  let cur = obj;
  for (const p of path) {
    const next = cur[p];
    if (isObject(next)) cur = next;
    else {
      const created: JsonObject = {};
      cur[p] = created;
      cur = created;
    }
  }
  return cur;
}

/** Go's json.Marshal of a value, compact, with its HTML escaping of <, > and &. */
export function goJson(v: Json): string {
  return JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
