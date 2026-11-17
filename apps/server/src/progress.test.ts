// The progress log through the server and back (phase 11's exit criteria): what the learning
// layer writes is what it reads, the server refuses what the reducer could not read, and the
// state rebuilt from the file equals the state that was live while it was written.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { demoCatalog, eventProblem, parseLog, replay, simulateLearner, type ProgressEvent } from '@simlab/learn';
import { apiMiddleware, progressFile } from './api.ts';
import { listen } from './serve.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(data: string): Promise<string> {
  const server = await listen({ port: 0, handlers: [apiMiddleware(data, { eventProblem })] });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, events: readonly unknown[]): Promise<Response> => fetch(`${url}/api/progress`, { method: 'POST', body: JSON.stringify({ events }) });

test('a month of sessions posted as they happen is rebuilt exactly from the file, also by a new server', async () => {
  const sim = simulateLearner(demoCatalog(), { days: 30, seed: 11, start: Date.UTC(2026, 10, 17, 9), track: 'demo.track.all' });
  const data = join(mkdtempSync(join(tmpdir(), 'simlab-progress-')), 'data');
  const url = await start(data);
  // The app posts small batches: an attempt's events as they come.
  for (let i = 0; i < sim.log.length; i += 7) expect((await post(url, sim.log.slice(i, i + 7))).status).toBe(204);
  const served = parseLog(await (await fetch(`${url}/api/progress`)).text());
  expect(served).toEqual(sim.log);
  expect(replay(served)).toEqual(sim.live);
  // Derived state lives nowhere on disk: only the log is there, and another process reads the same.
  expect(replay(parseLog(readFileSync(progressFile(data), 'utf8')))).toEqual(sim.live);
  const again = await start(data);
  expect(replay(parseLog(await (await fetch(`${again}/api/progress`)).text()))).toEqual(sim.live);
  rmSync(data, { recursive: true });
});

test('the server refuses an event the reducer could not read, and writes nothing of its batch', async () => {
  const data = join(mkdtempSync(join(tmpdir(), 'simlab-progress-')), 'data');
  const url = await start(data);
  const good: ProgressEvent = { v: 1, type: 'attempt.started', at: 1_800_000_000_000, attempt: 'a1', item: 'x.y', seed: 3, mode: 'new' };
  const refused = await post(url, [good, { v: 1, type: 'attempt.started', at: 1, attempt: 'a2' }]);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toMatch(/^events\[1\]: attempt\.started: /);
  expect((await post(url, [{ ...good, v: 2 }])).status).toBe(400);
  expect((await post(url, [{ v: 1, type: 'attempt.cheered', at: 1 }])).status).toBe(400);
  expect(await (await fetch(`${url}/api/progress`)).text()).toBe('');
  expect((await post(url, [good])).status).toBe(204);
  expect(parseLog(await (await fetch(`${url}/api/progress`)).text())).toEqual([good]);
});
