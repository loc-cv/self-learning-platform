// The API under /api/: everything the app persists, as plain files under the data directory.
//
//   POST /api/gaps            { records: GapPost[] }   → data/gaps.jsonl (docs/FIDELITY.md §4.4)
//   GET  /api/progress                                 ← data/progress.jsonl, as NDJSON
//   POST /api/progress        { events: object[] }     → appended, one write per request
//   GET  /api/attempts/<id>                            ← data/attempts/<id>.jsonl, as NDJSON
//   POST /api/attempts/<id>   { records: object[] }    → appended (an attempt's input log, for replay)
//   GET  /api/settings                                 ← data/settings.json, {} when absent
//   PUT  /api/settings        object                   → replaced atomically
//
// The server stores and returns; it does not interpret. The progress log's meaning (the reducer,
// the schema version of its events) belongs to the learning layer, which hands in the validator.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendGaps, gapProblem, type GapPost } from './gaps.ts';
import { BodyTooLarge, readBody, send, type Middleware } from './http.ts';
import { appendLines, readWhole, writeJsonAtomic } from './store.ts';

/** Gap records and settings are small. */
const MAX_BODY = 1 << 20;
/** A batch of progress events or a stretch of an attempt's input log. */
const MAX_LOG_BODY = 8 << 20;

const NDJSON = 'application/x-ndjson; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

/** An attempt's id is a file name: no separators, no leading dot. */
export const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ApiOptions {
  /**
   * Why a posted progress event is refused, or undefined when it may be appended. Default:
   * `progressEventShapeProblem`, the fields every event has whatever its schema version.
   */
  eventProblem?: (event: unknown) => string | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The structural check: a JSON object with an integer `v`, a string `type` and a finite number `at`. */
export function progressEventShapeProblem(e: unknown): string | undefined {
  if (!isObject(e)) return 'a progress event is a JSON object';
  if (!Number.isInteger(e['v'])) return 'v must be an integer (the schema version)';
  if (typeof e['type'] !== 'string') return 'type must be a string';
  if (typeof e['at'] !== 'number' || !Number.isFinite(e['at'])) return 'at must be a number (milliseconds since the epoch)';
  return undefined;
}

export const progressFile = (dataDir: string): string => join(dataDir, 'progress.jsonl');
export const attemptFile = (dataDir: string, id: string): string => join(dataDir, 'attempts', `${id}.jsonl`);
export const settingsFile = (dataDir: string): string => join(dataDir, 'settings.json');

/** Reads the body as JSON and hands it to `use`; answers 400 or 413 itself. */
function withJson(req: IncomingMessage, res: ServerResponse, limit: number, use: (body: unknown) => void): void {
  readBody(req, limit).then(
    (text) => {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return send(res, 400, 'the body is not JSON\n');
      }
      try {
        use(body);
      } catch (e) {
        send(res, 500, `${(e as Error).message}\n`);
      }
    },
    (e: Error) => send(res, e instanceof BodyTooLarge ? 413 : 400, `${e.message}\n`),
  );
}

/** The list under `key`, each element checked by `problem`; answers 400 and returns undefined otherwise. */
function listOf(res: ServerResponse, body: unknown, key: string, problem: (v: unknown) => string | undefined): unknown[] | undefined {
  const list = isObject(body) ? body[key] : undefined;
  if (!Array.isArray(list)) {
    send(res, 400, `expected { ${key}: [...] }\n`);
    return undefined;
  }
  for (let i = 0; i < list.length; i++) {
    const p = problem(list[i]);
    if (p !== undefined) {
      // Nothing of a refused batch is written: a log holds whole requests only.
      send(res, 400, `${key}[${i}]: ${p}\n`);
      return undefined;
    }
  }
  return list;
}

export function apiMiddleware(dataDir: string, options: ApiOptions = {}): Middleware {
  const eventProblem = options.eventProblem ?? progressEventShapeProblem;
  return (req, res, next) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/')) return next();
    const method = req.method ?? 'GET';

    if (path === '/api/gaps') {
      if (method !== 'POST') return send(res, 405, 'POST only\n');
      return withJson(req, res, MAX_BODY, (body) => {
        const records = (body as { records?: unknown } | null)?.records;
        if (!Array.isArray(records)) return send(res, 400, 'expected { records: [...] }\n');
        for (const r of records) {
          const problem = gapProblem(r);
          if (problem) return send(res, 400, `${problem}\n`);
        }
        appendGaps(dataDir, records as GapPost[]);
        send(res, 204, '');
      });
    }

    if (path === '/api/progress') {
      if (method === 'GET') return send(res, 200, readWhole(progressFile(dataDir)), NDJSON);
      if (method !== 'POST') return send(res, 405, 'GET or POST only\n');
      return withJson(req, res, MAX_LOG_BODY, (body) => {
        const events = listOf(res, body, 'events', eventProblem);
        if (!events) return;
        appendLines(progressFile(dataDir), events.map((e) => JSON.stringify(e)));
        send(res, 204, '');
      });
    }

    if (path.startsWith('/api/attempts/')) {
      let id: string;
      try {
        id = decodeURIComponent(path.slice('/api/attempts/'.length));
      } catch {
        return send(res, 400, 'bad attempt id\n');
      }
      if (!ATTEMPT_ID.test(id)) return send(res, 400, 'an attempt id is 1 to 128 letters, digits, dots, dashes or underscores, not starting with a dot\n');
      const file = attemptFile(dataDir, id);
      if (method === 'GET') return existsSync(file) ? send(res, 200, readWhole(file), NDJSON) : send(res, 404, 'no such attempt\n');
      if (method !== 'POST') return send(res, 405, 'GET or POST only\n');
      return withJson(req, res, MAX_LOG_BODY, (body) => {
        const records = listOf(res, body, 'records', (r) => (isObject(r) ? undefined : 'a record is a JSON object'));
        if (!records) return;
        appendLines(file, records.map((r) => JSON.stringify(r)));
        send(res, 204, '');
      });
    }

    if (path === '/api/settings') {
      const file = settingsFile(dataDir);
      if (method === 'GET') return send(res, 200, existsSync(file) ? readFileSync(file, 'utf8') : '{}\n', JSON_TYPE);
      if (method !== 'PUT') return send(res, 405, 'GET or PUT only\n');
      return withJson(req, res, MAX_BODY, (body) => {
        if (!isObject(body)) return send(res, 400, 'settings are a JSON object\n');
        writeJsonAtomic(file, body);
        send(res, 204, '');
      });
    }

    return send(res, 404, 'not found\n');
  };
}
