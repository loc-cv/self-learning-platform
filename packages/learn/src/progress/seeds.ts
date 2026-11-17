// A new variant on every review (PLAN.md §5, "Variation"): the seed of an item's next attempt is
// a function of the item and of how often it was attempted, and where the item has parameters it
// is one whose parameters differ from the last attempt's, so a review asks for the method and not
// for last time's answer.

import { initialPrngState, randomOver } from '@simlab/kernel';
import type { AnyItem } from '../item/types.ts';
import { resolveParams } from '../item/variant.ts';

const SEEDS = 1_000_000;
const TRIES = 20;

/** The `n`th candidate seed of the item's `attempts`th attempt. */
function candidate(id: string, attempts: number, n: number): number {
  return 1 + randomOver(initialPrngState(attempts * TRIES + n, `learn.seed:${id}`)).int(SEEDS);
}

/** The seed without the item: a function of the id and the count alone. */
export function attemptSeed(id: string, attempts: number): number {
  return candidate(id, attempts, 0);
}

/**
 * The seed for the next attempt of `item` after `attempts` finished ones, the last with
 * `lastSeed`. Tries up to twenty candidates for parameters that differ from the last attempt's;
 * an item with one variant keeps the first.
 */
export function reviewSeed(item: Exclude<AnyItem, { kind: 'exam' }>, attempts: number, lastSeed?: number): number {
  const first = candidate(item.id, attempts, 0);
  if (lastSeed === undefined || Object.keys(item.world?.params ?? {}).length === 0) return first;
  const last = JSON.stringify(resolveParams(item, lastSeed));
  for (let n = 0; n < TRIES; n++) {
    const seed = candidate(item.id, attempts, n);
    if (JSON.stringify(resolveParams(item, seed)) !== last) return seed;
  }
  return first;
}
