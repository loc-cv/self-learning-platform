// World state: one tree of plain data (docs/ARCHITECTURE.md §2.1, D-008).
// Containers (this object, `queue`, `prng`, `counters`, `topics`, each slice and its tables) are
// mutable and belong to one world; the values in them are deeply frozen and may be shared.

import type { Json } from './json.ts';
import type { Millis } from './civil.ts';
import type { PendingEvent } from './heap.ts';
import type { PrngState } from './prng.ts';
import type { Table } from './table.ts';

/** Layout version of the kernel part of the world; slices carry their own. */
export const KERNEL_SCHEMA = 1;

export interface Clock {
  /** Virtual wall-clock time in ms since the Unix epoch. */
  now: Millis;
  /** Value of `now` when the world was created; `now - start` is the uptime. */
  start: Millis;
  /** Sequence number for the next scheduled event. */
  seq: number;
}

/** Something to schedule at the current time when a topic is published (§2.4). */
export interface Waiter {
  /** Unique within the world, so the subscriber can withdraw it. */
  id: string;
  type: string;
  payload: Json;
}

export interface TopicState {
  /** Subscribers in subscription order. */
  waiters: Waiter[];
}

export interface World {
  schema: number;
  seed: number;
  clock: Clock;
  /** Binary min-heap ordered by (at, seq). Cancelling removes the entry. */
  queue: PendingEvent[];
  /** One state per named PRNG stream, created on first use and advanced in place. */
  prng: Record<string, PrngState>;
  /** Counters for deterministic ids (pids, inode numbers, input numbers). */
  counters: Record<string, number>;
  /** Wake topics with their waiting subscribers. Entries are frozen values. */
  topics: Table<TopicState>;
  /** One slice per plugin, keyed by plugin name: `host`, `k8s`, … */
  slices: Record<string, unknown>;
}

export interface SliceSpec<S> {
  /** Plugin name; the key under `world.slices`. */
  name: string;
  /** Bumped when the slice layout changes. A snapshot with another version is refused. */
  version: number;
  init(seed: number): S;
  /** After deserialization: freeze the values so later forks share them (§2.7). */
  adopt(slice: S): void;
}

export function emptyWorld(seed: number, startTime: Millis): World {
  if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer, got ${seed}`);
  if (!Number.isInteger(startTime)) throw new RangeError(`startTime must be an integer number of ms, got ${startTime}`);
  return {
    schema: KERNEL_SCHEMA,
    seed,
    clock: { now: startTime, start: startTime, seq: 0 },
    queue: [],
    prng: {},
    counters: {},
    topics: {},
    slices: {},
  };
}
