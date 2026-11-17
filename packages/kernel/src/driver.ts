// Time drivers (docs/ARCHITECTURE.md §2.5). The interactive driver's logic lives here so it is
// tested headlessly; the app owns the wall clock and only reports how much real time passed.
// Nothing here reads a clock: `realElapsed` is an argument.

import type { Millis } from './civil.ts';
import type { Kernel } from './kernel.ts';
import type { Input } from './registry.ts';
import type { SessionRecorder } from './replay.ts';

export interface InteractiveDriver {
  readonly speed: number;
  readonly paused: boolean;
  /** Advances virtual time by `realElapsed × speed`, carrying fractions of a millisecond. */
  tick(realElapsed: Millis): void;
  /** Ticks for the real time since the last tick, then delivers the input at the resulting time. */
  deliver(input: Input, realElapsed?: Millis): void;
  /**
   * Jumps to the next pending non-idle event, if any, and runs it. With `until`, keeps jumping
   * from event to event until `until()` holds after one (something the learner can see happened)
   * or the next event lies more than `limit` ms after the time the skip started; a skip that finds
   * nothing within the limit stops at the last event it ran. Returns whether `until` held (true
   * without `until` when an event ran).
   */
  skipToNextEvent(until?: () => boolean, limit?: Millis): boolean;
  setSpeed(speed: number): void;
  pause(): void;
  resume(): void;
}

/**
 * The driver for a live session. Inputs go through `recorder` so they are logged with the virtual
 * time they were delivered at; speed, pauses and skips are not inputs, their whole effect is in
 * those stamps (§2.8).
 */
export function createInteractiveDriver(recorder: SessionRecorder, options: { speed?: number } = {}): InteractiveDriver {
  const kernel: Kernel = recorder.kernel;
  let speed = checkSpeed(options.speed ?? 1);
  let paused = false;
  let carry = 0;

  const tick = (realElapsed: Millis): void => {
    if (!(realElapsed >= 0)) throw new RangeError(`realElapsed must be >= 0, got ${realElapsed}`);
    if (paused) return;
    const exact = realElapsed * speed + carry;
    const whole = Math.floor(exact);
    carry = exact - whole;
    if (whole > 0) kernel.advance(whole);
  };

  return {
    get speed() {
      return speed;
    },
    get paused() {
      return paused;
    },
    tick,
    deliver(input, realElapsed = 0) {
      tick(realElapsed);
      recorder.deliver(input);
    },
    skipToNextEvent(until, limit = SKIP_LIMIT) {
      carry = 0;
      const deadline = kernel.now + limit;
      for (;;) {
        const next = kernel.nextEventTime();
        if (next === undefined || (until !== undefined && next > deadline)) return false;
        kernel.runUntil(next);
        if (until === undefined || until()) return true;
      }
    },
    setSpeed(s) {
      speed = checkSpeed(s);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
  };
}

/** How far a skip looks for something to show before it gives up: one hour of virtual time. */
export const SKIP_LIMIT: Millis = 3_600_000;

function checkSpeed(s: number): number {
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError(`speed must be a positive finite number, got ${s}`);
  return s;
}
