// lint-as: packages/kernel/src/clock.ts
// expect: simlab/engine-determinism x5
export function now(): number {
  return Date.now();
}
export const started = new Date();
export function later(fn: () => void): void {
  setTimeout(fn, 1000);
  setInterval(fn, 1000);
  queueMicrotask(fn);
}
