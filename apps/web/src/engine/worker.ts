// The engine's Web Worker: the session core (session.ts) with the wall clock and the ticking of
// the interactive time driver. This is the only place the web app's engine side reads real time.
//
// Virtual time follows real time (docs/ARCHITECTURE.md §2.5). The worker wakes when the next
// pending event is due, so a command that takes 7 ms of virtual time answers after 7 ms, and at
// least every TICK ms otherwise. Sleeping longer while nothing is due changes nothing anyone can
// see: every input first lets virtual time catch up with the wall clock.

import { ITEMS } from '../content.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';
import { createEngine } from './session.ts';

/** The longest the worker sleeps between ticks of the time driver (real ms). */
const TICK = 250;

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const engine = createEngine(ITEMS, (m) => scope.postMessage(m), () => performance.now());
let timer: ReturnType<typeof setTimeout> | undefined;

const schedule = (): void => {
  clearTimeout(timer);
  const due = engine.nextEventIn();
  timer = setTimeout(tick, due === undefined ? TICK : Math.min(TICK, Math.ceil(due)));
};
const tick = (): void => {
  engine.tick();
  schedule();
};
scope.onmessage = (e) => {
  engine.receive(e.data);
  schedule();
};
schedule();
