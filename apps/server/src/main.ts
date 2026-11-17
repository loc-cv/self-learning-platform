// npm start            → node apps/server/src/main.ts        (after building apps/web)
// npm run dev          → node apps/server/src/main.ts --dev  (Vite middleware, hot reload)
// Both serve the same API (api.ts) from this one process: in development Vite runs as middleware
// behind it, so the page's /api/ requests need no proxy.
// Options: --port N (default 4317), --data DIR (default data/ in the repository; the browser tests
// use their own, so their deliberate [sim] probes stay out of the real gap log). 127.0.0.1 only.

import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { eventProblem } from '@simlab/learn';
import { apiMiddleware, DATA, listen, staticMiddleware, WEB_ROOT, type Middleware } from './serve.ts';

const USAGE = 'usage: node apps/server/src/main.ts [--dev] [--port N] [--data DIR]\n';

async function main(argv: string[]): Promise<number> {
  let dev = false;
  let port = 4317;
  let data = DATA;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--dev') dev = true;
    else if (a === '--data') {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`--data needs a directory\n${USAGE}`);
        return 2;
      }
      data = resolve(v);
    }
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a === '--port' ? argv[++i] : a.slice('--port='.length);
      if (v === undefined || !/^\d+$/.test(v) || Number(v) > 65535) {
        process.stderr.write(`bad port ${v ?? '(none)'}\n${USAGE}`);
        return 2;
      }
      port = Number(v);
    } else {
      process.stderr.write(`unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  // The learning layer says what a progress event is; the server only refuses to store what it would not read back.
  const handlers: Middleware[] = [apiMiddleware(data, { eventProblem })];
  if (!dev) handlers.push(staticMiddleware());
  const server = await listen({ port, handlers });
  if (dev) {
    // Vite only in development, so `npm start` does not load it. Hot reload's websocket shares
    // this server; requests before Vite is ready get 404.
    const { createServer } = await import('vite');
    const vite = await createServer({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    handlers.push(vite.middlewares as unknown as Middleware);
  }
  const { port: actual } = server.address() as AddressInfo;
  process.stdout.write(`simlab ${dev ? 'dev server' : 'app'}: http://127.0.0.1:${actual}/\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (e: Error) => {
    process.stderr.write(`${e.stack ?? e.message}\n`);
    process.exit(1);
  },
);
