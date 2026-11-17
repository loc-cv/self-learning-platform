// The local HTTP server: the built web app from apps/web/dist (or, in development, Vite's
// middleware with hot reload) and the API under /api/ (api.ts), which persists to plain files
// under data/. It listens on 127.0.0.1 only.

import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, type Middleware } from './http.ts';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const WEB_ROOT = join(REPO, 'apps', 'web');
export const DIST = join(WEB_ROOT, 'dist');
export const DATA = join(REPO, 'data');

export { apiMiddleware } from './api.ts';
export type { Middleware };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // The web app manifest (apps/web/public): what makes the page installable as an app window.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves files from `root`; any path without a file extension gets index.html (one page app). */
export function staticMiddleware(root: string = DIST): Middleware {
  const base = resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) return send(res, 403, 'forbidden\n');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(path) !== '') return send(res, 404, 'not found\n');
      file = join(base, 'index.html');
      if (!existsSync(file)) return send(res, 500, `no build in ${base}: run npm start, which builds first\n`);
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    // Hashed asset names never change content; the page itself must always be fresh.
    const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  };
}

export interface AppServerOptions {
  port: number;
  /** Request handlers tried in order; the last one ends with 404. */
  handlers: Middleware[];
}

export function listen(opts: AppServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    const run = (i: number): void => {
      const h = opts.handlers[i];
      if (!h) return send(res, 404, 'not found\n');
      try {
        h(req, res, () => run(i + 1));
      } catch (e) {
        send(res, 500, `${(e as Error).message}\n`);
      }
    };
    run(0);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, '127.0.0.1', () => ok(server));
  });
}
