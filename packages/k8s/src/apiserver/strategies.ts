// Lookup of the strategy serving a resource. Strategies are code, registered statically.

import { STRATEGIES } from '../registry/index.ts';
import type { Strategy } from './types.ts';

let index: Map<string, Strategy> | undefined;

export function strategyFor(group: string, resource: string): Strategy | undefined {
  if (!index) {
    index = new Map();
    for (const s of STRATEGIES) {
      const k = `${s.group}/${s.resource}`;
      if (index.has(k)) throw new Error(`two strategies for ${k}`);
      index.set(k, s);
    }
  }
  return index.get(`${group}/${resource}`);
}

/** Every strategy storing objects in `storage` (events: core and events.k8s.io). */
export function strategiesForStorage(storage: string): Strategy[] {
  return STRATEGIES.filter((s) => s.storage === storage);
}
