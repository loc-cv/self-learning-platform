// Canonical 64-bit hashing of plain data (docs/ARCHITECTURE.md §2.7).
//
// Function: the cyrb53 mixing core by bryc (public domain,
// https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js), with both 32-bit lanes
// printed, which gives 64 bits as 16 hex digits. It is non-cryptographic, fast with Math.imul,
// and needs nothing from the platform (the engine has no crypto). Collisions only matter for
// determinism tests and replay checkpoints, where 64 bits is plenty.
//
// Structure: a Merkle hash. A node's hash covers its canonical form, in which object keys are
// sorted in code-unit order and every child object or array is replaced by its own hash. The
// result depends only on the data, never on which nodes happen to be frozen, so a world hashes the
// same before a snapshot and after a restore. Frozen nodes are values that never change, so their
// hashes are cached by identity; hashing after a small change revisits only the containers on the
// path to it plus the new values.

import { isPlainContainer } from './json.ts';

export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return hex8(h2) + hex8(h1);
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** Outside world state: a derived cache keyed by value identity (§2.12). */
const cache = new WeakMap<object, string>();

/** Hash of any plain data. Throws on anything that is not JSON data. */
export function hashNode(node: unknown): string {
  return hashString(canonical(node, '$'));
}

function canonical(node: unknown, at: string): string {
  switch (typeof node) {
    case 'string':
      return JSON.stringify(node);
    case 'boolean':
      return node ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(node)) throw new TypeError(`${at}: ${String(node)} is not JSON data`);
      return String(node);
    case 'object':
      if (node === null) return 'null';
      return `#${hashObject(node, at)}`;
    default:
      throw new TypeError(`${at}: a ${typeof node} is not JSON data`);
  }
}

function hashObject(node: object, at: string): string {
  const frozen = Object.isFrozen(node);
  if (frozen) {
    const hit = cache.get(node);
    if (hit !== undefined) return hit;
  }
  if (!isPlainContainer(node)) {
    throw new TypeError(`${at}: an instance of ${node.constructor?.name ?? 'unknown'} is not JSON data`);
  }
  let form: string;
  if (Array.isArray(node)) {
    const parts: string[] = [];
    for (let i = 0; i < node.length; i++) parts.push(canonical(node[i], `${at}[${i}]`));
    form = `[${parts.join(',')}]`;
  } else {
    const rec = node as Record<string, unknown>;
    const ks = Object.keys(rec).sort();
    const parts: string[] = [];
    for (const k of ks) parts.push(`${JSON.stringify(k)}:${canonical(rec[k], `${at}.${k}`)}`);
    form = `{${parts.join(',')}}`;
  }
  const h = hashString(form);
  if (frozen) cache.set(node, h);
  return h;
}
