// lint-as: packages/k8s/src/scheduler/score.ts
// expect: simlab/engine-determinism x3
export const a = Math.random();
export const b = Math['random']();
export const c = crypto.randomUUID();
