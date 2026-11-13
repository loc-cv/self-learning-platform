// lint-as: packages/learn/src/progress.ts
// expect: simlab/engine-determinism x5
export const saved = localStorage.getItem('progress');
export const title = document.title;
export const w = window.innerWidth;
export const g = globalThis;
export async function load(): Promise<unknown> {
  return fetch('/api/progress');
}
