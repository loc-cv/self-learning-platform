// Fork: copy containers, share values (docs/ARCHITECTURE.md §2.7, D-008). A frozen node is a
// value and is returned as is; anything else is shallow-copied and its children visited. Because
// tables hold frozen values, the walk stops one level below each table, so the cost follows the
// number of table entries, never the bytes of file contents or object bodies.

import type { World } from './world.ts';

export function forkWorld(world: World): World {
  return forkNode(world) as World;
}

export function forkNode(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Object.isFrozen(node)) return node;
  if (Array.isArray(node)) return node.map(forkNode);
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) out[key] = forkNode(src[key]);
  return out;
}
