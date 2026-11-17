// What the request handlers share: the middleware shape, sending an answer, reading a body.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request handler that may pass the request on. */
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export class BodyTooLarge extends Error {}

/** The request body as text; rejects with `BodyTooLarge` past `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      // Keep reading and drop the rest, so the client gets the 413 instead of a reset connection.
      if (size > limit) {
        over = true;
        chunks.length = 0;
      } else chunks.push(c);
    });
    req.on('end', () => (over ? fail(new BodyTooLarge('request body too large')) : ok(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', fail);
  });
}
