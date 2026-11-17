import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { apiMiddleware, type ApiOptions } from './api.ts';
import { listen } from './serve.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(options?: ApiOptions): Promise<{ url: string; data: string }> {
  const data = join(mkdtempSync(join(tmpdir(), 'simlab-api-')), 'data');
  const server = await listen({ port: 0, handlers: [apiMiddleware(data, options)] });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, data };
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const ndjson = async (res: Response): Promise<unknown[]> => (await res.text()).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown);

const started = { v: 1, type: 'attempt.started', at: 1_800_000_000_000, item: 'k8s.x-01', seed: 4 };
const finished = { v: 1, type: 'attempt.finished', at: 1_800_000_060_000, item: 'k8s.x-01', passed: true };

describe('/api/progress', () => {
  test('is empty before anything was posted, then returns the events in the order posted', async () => {
    const { url, data } = await start();
    const empty = await fetch(`${url}/api/progress`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(await empty.text()).toBe('');
    expect((await fetch(`${url}/api/progress`, json('POST', { events: [started] }))).status).toBe(204);
    expect((await fetch(`${url}/api/progress`, json('POST', { events: [finished, { ...started, seed: 5 }] }))).status).toBe(204);
    expect((await fetch(`${url}/api/progress`, json('POST', { events: [] }))).status).toBe(204);
    expect(await ndjson(await fetch(`${url}/api/progress`))).toEqual([started, finished, { ...started, seed: 5 }]);
    expect(readFileSync(join(data, 'progress.jsonl'), 'utf8').split('\n')).toHaveLength(4);
  });

  test('refuses a batch with one bad event and writes none of it', async () => {
    const { url, data } = await start();
    const post = (body: unknown): Promise<Response> => fetch(`${url}/api/progress`, json('POST', body));
    const bad = await post({ events: [started, { ...finished, v: '1' }] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('events[1]: v must be an integer (the schema version)\n');
    expect(await (await post({ events: [{ v: 1, at: 3 }] })).text()).toBe('events[0]: type must be a string\n');
    expect(await (await post({ events: [{ v: 1, type: 'x', at: '3' }] })).text()).toContain('at must be a number');
    expect(await (await post({ events: [[started]] })).text()).toBe('events[0]: a progress event is a JSON object\n');
    expect(await (await post([started])).text()).toBe('expected { events: [...] }\n');
    expect(await (await fetch(`${url}/api/progress`, { method: 'POST', body: '{' })).text()).toBe('the body is not JSON\n');
    expect((await fetch(`${url}/api/progress`, { method: 'DELETE' })).status).toBe(405);
    expect(existsSync(join(data, 'progress.jsonl'))).toBe(false);
  });

  test('uses the validator it is given instead of the structural check', async () => {
    const { url } = await start({ eventProblem: (e: unknown) => ((e as { v?: unknown }).v === 2 ? undefined : 'schema version 2 only') });
    const res = await fetch(`${url}/api/progress`, json('POST', { events: [started] }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('events[0]: schema version 2 only\n');
    expect((await fetch(`${url}/api/progress`, json('POST', { events: [{ v: 2 }] }))).status).toBe(204);
  });

  test('takes a batch over 1 MiB and refuses one over 8 MiB', async () => {
    const { url } = await start();
    const big = { ...started, note: 'n'.repeat(2 << 20) };
    expect((await fetch(`${url}/api/progress`, json('POST', { events: [big] }))).status).toBe(204);
    expect(await ndjson(await fetch(`${url}/api/progress`))).toEqual([big]);
    const res = await fetch(`${url}/api/progress`, json('POST', { events: [{ ...started, note: 'n'.repeat(9 << 20) }] }));
    expect(res.status).toBe(413);
    expect(await ndjson(await fetch(`${url}/api/progress`))).toHaveLength(1);
  });

  test('a log with a torn tail is served as its whole lines, and the next post repairs it', async () => {
    const { url, data } = await start();
    await fetch(`${url}/api/progress`, json('POST', { events: [started] }));
    writeFileSync(join(data, 'progress.jsonl'), '{"v":1,"type":"attempt.fin', { flag: 'a' });
    expect(await ndjson(await fetch(`${url}/api/progress`))).toEqual([started]);
    await fetch(`${url}/api/progress`, json('POST', { events: [finished] }));
    expect(await ndjson(await fetch(`${url}/api/progress`))).toEqual([started, finished]);
    expect(readFileSync(join(data, 'progress.jsonl'), 'utf8')).toBe(`${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`);
  });
});

describe('/api/attempts/<id>', () => {
  test('keeps one input log per attempt', async () => {
    const { url, data } = await start();
    const a = `${url}/api/attempts/k8s.x-01_4_1800000000000`;
    expect((await fetch(a)).status).toBe(404);
    expect((await fetch(a, json('POST', { records: [{ t: 0, input: 'kubectl get po\r' }] }))).status).toBe(204);
    expect((await fetch(a, json('POST', { records: [{ t: 900, advance: 1000 }] }))).status).toBe(204);
    expect((await fetch(`${url}/api/attempts/other`, json('POST', { records: [{ t: 1 }] }))).status).toBe(204);
    expect(await ndjson(await fetch(a))).toEqual([{ t: 0, input: 'kubectl get po\r' }, { t: 900, advance: 1000 }]);
    expect(readdirSync(join(data, 'attempts')).sort()).toEqual(['k8s.x-01_4_1800000000000.jsonl', 'other.jsonl']);
  });

  test('refuses ids that are not file names, records that are not objects, other methods', async () => {
    const { url, data } = await start();
    const post = (id: string, body: unknown): Promise<Response> => fetch(`${url}/api/attempts/${id}`, json('POST', body));
    for (const id of ['.hidden', '..%2f..%2fprogress', 'a%2fb', 'a%20b', '', `${'a'.repeat(129)}`, '%E0%A4%A']) expect((await post(id, { records: [{ t: 1 }] })).status, id).toBe(400);
    expect(await (await post('ok', { records: [{ t: 1 }, 'text'] })).text()).toBe('records[1]: a record is a JSON object\n');
    expect(await (await post('ok', { events: [] })).text()).toBe('expected { records: [...] }\n');
    expect((await fetch(`${url}/api/attempts/ok`, { method: 'PUT', body: '{}' })).status).toBe(405);
    expect(existsSync(join(data, 'attempts'))).toBe(false);
    expect(existsSync(join(data, 'progress.jsonl'))).toBe(false);
  });
});

describe('/api/settings', () => {
  test('is {} until set, then the object last put', async () => {
    const { url, data } = await start();
    const first = await fetch(`${url}/api/settings`);
    expect(first.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await first.json()).toEqual({});
    expect((await fetch(`${url}/api/settings`, json('PUT', { retention: 0.9, minutes: 30 }))).status).toBe(204);
    expect((await fetch(`${url}/api/settings`, json('PUT', { retention: 0.85 }))).status).toBe(204);
    expect(await (await fetch(`${url}/api/settings`)).json()).toEqual({ retention: 0.85 });
    expect(readdirSync(data)).toEqual(['settings.json']);
  });

  test('refuses what is not an object, and other methods', async () => {
    const { url } = await start();
    for (const body of [[1], 'text', null, 3]) {
      const res = await fetch(`${url}/api/settings`, json('PUT', body));
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('settings are a JSON object\n');
    }
    expect((await fetch(`${url}/api/settings`, json('POST', {}))).status).toBe(405);
    expect(await (await fetch(`${url}/api/settings`)).json()).toEqual({});
  });
});

test('unknown API paths are 404 and other paths pass through', async () => {
  const { url } = await start();
  expect((await fetch(`${url}/api/other`)).status).toBe(404);
  expect((await fetch(`${url}/api/attempts`)).status).toBe(404);
  expect(await (await fetch(`${url}/elsewhere`)).text()).toBe('not found\n');
});
