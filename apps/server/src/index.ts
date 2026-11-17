// Local server: the web app's files and the app's persistence, as plain files under data/ (the
// progress log, attempt input logs for replay, the gap log, settings). `npm start` and
// `npm run dev` run main.ts.

export const packageName = '@simlab/server';

export { ATTEMPT_ID, attemptFile, progressEventShapeProblem, progressFile, settingsFile, type ApiOptions } from './api.ts';
export * from './gaps.ts';
export * from './store.ts';
export * from './serve.ts';
