// The kernel loop: virtual clock, event dispatch, inputs, topics, PRNG access, trace and gap
// ports (docs/ARCHITECTURE.md §2.3–§2.5, §2.9, §2.10).
//
// Everything that decides behavior is in the world; the runtime object built here holds only the
// registry, the ports, the trace buffer and the guard counters, none of which feed back into the
// world.

import { forkWorld } from './fork.ts';
import { hashNode } from './hash.ts';
import { heapPop, heapPush, removeAt, type PendingEvent } from './heap.ts';
import { assertPlainData, deepFreeze, type Json } from './json.ts';
import { initialPrngState, randomOver, type Random } from './prng.ts';
import type { Input, Registry } from './registry.ts';
import { put, remove } from './table.ts';
import {
  createTraceBuffer,
  type GapInput,
  type OutputRecord,
  type Ports,
  type TraceInput,
  type TraceRecord,
} from './trace.ts';
import { emptyWorld, type World } from './world.ts';
import type { Millis } from './civil.ts';

/**
 * Events dispatched at one virtual instant before the kernel declares a livelock. Legitimate
 * bursts (an apply of many objects, a pipeline of chatty processes) stay far below it; two
 * handlers that schedule each other at delay zero reach it in milliseconds of real time.
 * Chosen in phase 01 (docs/ARCHITECTURE.md §6).
 */
export const MAX_EVENTS_PER_INSTANT = 100_000;

export interface Ctx {
  readonly world: World;
  readonly registry: Registry;
  readonly now: Millis;
  /** What is being handled: an event id (`<seq>`), an input id (`in<n>`) or an action label. */
  readonly during: string;
  /** Schedules an event `delay` ms from now. Returns its id. */
  schedule(delay: Millis, type: string, payload: Json): string;
  /** Removes a pending event. Returns false if it was not pending (already run or cancelled). */
  cancel(eventId: string): boolean;
  random(stream: string): Random;
  /** Next value of a world counter, starting at 1. */
  nextId(counter: string): number;
  /** Adds a waiter that `publish(topic)` turns into an event. Returns the waiter id. */
  subscribe(topic: string, type: string, payload: Json): string;
  unsubscribe(topic: string, waiterId: string): void;
  /** Schedules one event at the current time per waiter, in subscription order, and clears them. */
  publish(topic: string): void;
  /** Emits a trace record. Returns its id, for `causes` of later records. */
  trace(record: TraceInput): number;
  gap(record: GapInput): void;
  /** Sends bytes out through the output port. Write-only: nothing in the engine reads them back. */
  output(record: OutputRecord): void;
  /** Typed access to a plugin's slice. */
  slice<S>(name: string): S;
}

export interface SettleOptions {
  timeout: Millis;
  until?: (world: World) => boolean;
}

export interface Kernel {
  readonly world: World;
  readonly registry: Registry;
  readonly now: Millis;
  /**
   * Delivers one input at the current time (§2.8). Events already due (`at <= now`, such as those
   * an earlier input at this instant scheduled with delay zero) run first: the ordering rule of
   * §2.5, which replay relies on.
   */
  input(input: Input): void;
  /** Runs every event with `at <= t`, then sets the clock to `t`. */
  runUntil(t: Millis): void;
  /** `runUntil(now + d)`. */
  advance(d: Millis): void;
  /**
   * Runs until only idle events are pending ('quiet'), `until(world)` holds ('until'), or
   * `timeout` has passed ('timeout'). `until` is tested before each virtual instant is run.
   */
  settle(opts: SettleOptions): 'quiet' | 'until' | 'timeout';
  /** Time of the next pending non-idle event, if any ("skip to next event"). */
  nextEventTime(): Millis | undefined;
  /**
   * Runs `fn` with a context at the current time, outside any event: topology build, setup and
   * solution steps, fault injection, tests. `label` becomes `during` for its trace and events.
   */
  act<T>(label: string, fn: (ctx: Ctx) => T): T;
  /**
   * A kernel over a fork of this world (§2.7). It gets its own trace buffer and the given ports;
   * with `keepTrace` the buffer starts as a copy of this kernel's and record ids continue, so the
   * fork can still explain what happened before it (a session forked from a baseline, §2.9).
   */
  fork(options?: ForkOptions): Kernel;
  hash(): string;
  /** The trace buffer's retained records, oldest first. */
  traceRecords(): TraceRecord[];
}

export interface KernelOptions {
  ports?: Ports;
  /** Trace records kept in memory. Default 10 000. */
  traceCapacity?: number;
}

export interface ForkOptions extends KernelOptions {
  /** Start with this kernel's retained trace records, and continue their ids. */
  keepTrace?: boolean;
}

export interface BootOptions extends KernelOptions {
  seed: number;
  startTime: Millis;
}

/** A new world with every registered slice initialized, in registration order. */
export function bootWorld(registry: Registry, seed: number, startTime: Millis): World {
  const world = emptyWorld(seed, startTime);
  for (const spec of registry.slices) world.slices[spec.name] = spec.init(seed);
  return world;
}

export function bootKernel(registry: Registry, options: BootOptions): Kernel {
  return createKernel(bootWorld(registry, options.seed, options.startTime), registry, options);
}

export function createKernel(world: World, registry: Registry, options: KernelOptions = {}, inherited: readonly TraceRecord[] = []): Kernel {
  const ports = options.ports ?? {};
  const traceCapacity = options.traceCapacity ?? 10_000;
  const buffer = createTraceBuffer(traceCapacity);
  for (const r of inherited) buffer.push(r);
  let traceSeq = inherited[inherited.length - 1]?.id ?? 0;
  let during = 'outside';
  // Livelock guard, runtime only.
  let instant = Number.NaN;
  let dispatchedAtInstant = 0;
  const typesAtInstant = new Map<string, number>();

  const assertDelay = (delay: Millis): void => {
    if (!Number.isInteger(delay) || delay < 0) throw new RangeError(`event delay must be a non-negative integer, got ${delay}`);
  };

  const ctx: Ctx = {
    world,
    registry,
    get now() {
      return world.clock.now;
    },
    get during() {
      return during;
    },
    schedule(delay, type, payload) {
      assertDelay(delay);
      registry.handler(type);
      const seq = world.clock.seq++;
      const ev: PendingEvent = { id: String(seq), at: world.clock.now + delay, seq, type, payload };
      if (during !== 'outside') ev.cause = during;
      heapPush(world.queue, deepFreeze(ev));
      return ev.id;
    },
    cancel(eventId) {
      const i = world.queue.findIndex((ev) => ev.id === eventId);
      if (i < 0) return false;
      removeAt(world.queue, i);
      return true;
    },
    random(stream) {
      const state = (world.prng[stream] ??= initialPrngState(world.seed, stream));
      return randomOver(state);
    },
    nextId(counter) {
      const n = (world.counters[counter] ?? 0) + 1;
      world.counters[counter] = n;
      return n;
    },
    subscribe(topic, type, payload) {
      registry.handler(type);
      const id = `w${ctx.nextId('kernel.waiter')}`;
      const waiters = world.topics[topic]?.waiters ?? [];
      put(world.topics, topic, { waiters: [...waiters, { id, type, payload }] });
      return id;
    },
    unsubscribe(topic, waiterId) {
      const state = world.topics[topic];
      if (!state) return;
      const waiters = state.waiters.filter((w) => w.id !== waiterId);
      if (waiters.length === 0) remove(world.topics, topic);
      else if (waiters.length !== state.waiters.length) put(world.topics, topic, { waiters });
    },
    publish(topic) {
      const state = world.topics[topic];
      if (!state) return;
      remove(world.topics, topic);
      for (const w of state.waiters) ctx.schedule(0, w.type, w.payload);
    },
    trace(input) {
      const record: TraceRecord = { ...input, id: ++traceSeq, t: world.clock.now, during };
      deepFreeze(record);
      buffer.push(record);
      ports.trace?.(record);
      return record.id;
    },
    gap(input) {
      const { key, machine, error, ...rest } = input;
      ports.gap?.(
        deepFreeze({
          v: 1,
          ...rest,
          key: key ?? `${input.kind}:${input.program}:${input.what}`,
          context: { machine, seed: world.seed, virtualTime: world.clock.now },
          ...(error ? { error } : {}),
        }),
      );
    },
    output(record) {
      ports.output?.(deepFreeze({ ...record }));
    },
    slice<S>(name: string): S {
      if (!(name in world.slices)) throw new Error(`no slice named ${name}`);
      return world.slices[name] as S;
    },
  };

  const withDuring = <T>(label: string, fn: () => T): T => {
    const outer = during;
    during = label;
    try {
      return fn();
    } finally {
      during = outer;
    }
  };

  const guard = (ev: PendingEvent): void => {
    if (world.clock.now !== instant) {
      instant = world.clock.now;
      dispatchedAtInstant = 0;
      typesAtInstant.clear();
    }
    dispatchedAtInstant++;
    typesAtInstant.set(ev.type, (typesAtInstant.get(ev.type) ?? 0) + 1);
    if (dispatchedAtInstant > MAX_EVENTS_PER_INSTANT) {
      const top = [...typesAtInstant.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t, n]) => `${t} ×${n}`)
        .join(', ');
      throw new Error(
        `livelock: more than ${MAX_EVENTS_PER_INSTANT} events dispatched at virtual time ${instant} without the clock advancing (${top})`,
      );
    }
  };

  const runUntil = (t: Millis): void => {
    if (!Number.isInteger(t)) throw new RangeError(`runUntil: time must be an integer, got ${t}`);
    if (t < world.clock.now) throw new RangeError(`runUntil(${t}) is in the past (now ${world.clock.now})`);
    for (;;) {
      const top = world.queue[0];
      if (top === undefined || top.at > t) break;
      heapPop(world.queue);
      world.clock.now = top.at;
      guard(top);
      const handler = registry.handler(top.type);
      withDuring(top.id, () => handler.handle(ctx, top.payload));
    }
    world.clock.now = t;
  };

  const nextEventTime = (): Millis | undefined => {
    let best: PendingEvent | undefined;
    for (const ev of world.queue) {
      if (registry.handler(ev.type).idle) continue;
      if (!best || ev.at < best.at || (ev.at === best.at && ev.seq < best.seq)) best = ev;
    }
    return best?.at;
  };

  for (const spec of registry.slices) {
    if (spec.attach) withDuring('attach', () => spec.attach?.(ctx));
  }

  return {
    world,
    registry,
    get now() {
      return world.clock.now;
    },
    input(input) {
      assertPlainData(input, 'input');
      const handler = registry.input(input.kind);
      runUntil(world.clock.now);
      const id = `in${ctx.nextId('kernel.input')}`;
      const frozen = deepFreeze(structuredCloneJson(input));
      withDuring(id, () => handler.handle(ctx, frozen));
    },
    runUntil,
    advance(d) {
      assertDelay(d);
      runUntil(world.clock.now + d);
    },
    settle({ timeout, until }) {
      assertDelay(timeout);
      const deadline = world.clock.now + timeout;
      for (;;) {
        if (until?.(world)) return 'until';
        const next = nextEventTime();
        if (next === undefined) return 'quiet';
        if (next > deadline) {
          runUntil(deadline);
          return until?.(world) ? 'until' : 'timeout';
        }
        runUntil(next);
      }
    },
    nextEventTime,
    act(label, fn) {
      return withDuring(label, () => fn(ctx));
    },
    fork(forkOptions) {
      const { keepTrace, ...rest } = forkOptions ?? {};
      return createKernel(forkWorld(world), registry, { traceCapacity, ...rest }, keepTrace ? buffer.records() : []);
    },
    hash: () => hashNode(world),
    traceRecords: () => buffer.records(),
  };
}

/** A private copy of an input, so a caller that keeps mutating its object cannot reach the world. */
function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
