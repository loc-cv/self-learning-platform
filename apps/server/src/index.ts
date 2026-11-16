// Local server: the web app's files and the gap log (phase 10); append-only progress persistence
// under data/ comes in phase 11. `npm start` and `npm run dev` run main.ts.

export const packageName = '@simlab/server';

export * from './gaps.ts';
export * from './serve.ts';
