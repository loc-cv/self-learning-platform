import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { apiMiddleware, listen, staticMiddleware } from './serve.ts';
import type { GapPost } from './gaps.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(): Promise<{ url: string; data: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'simlab-server-'));
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Simlab</title>');
  writeFileSync(join(dist, 'assets', 'app-1a2b.js'), 'export {}');
  const data = join(dir, 'data');
  const server = await listen({ port: 0, handlers: [apiMiddleware(data), staticMiddleware(dist)] });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, data };
}

const gap: GapPost = {
  v: 1,
  kind: 'flag',
  program: 'kubectl',
  what: '--raw',
  commandLine: 'kubectl get --raw /',
  key: 'flag:kubectl:--raw',
  context: { machine: 'controlplane', virtualTime: 1_800_000_000_000, seed: 3, item: 'k8s.workloads.deployment-service-01' },
  engine: { version: '0.10.0', kubernetes: 'v1.37.2' },
};

describe('the app server', () => {
  test('serves the page for app paths, assets by name, and refuses paths outside the build', async () => {
    const { url } = await start();
    const page = await fetch(`${url}/`);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('<title>Simlab</title>');
    expect(await (await fetch(`${url}/labs/x`)).text()).toContain('<title>Simlab</title>');
    const asset = await fetch(`${url}/assets/app-1a2b.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${url}/..%2f..%2f..%2fetc%2fpasswd`)).status).toBe(403);
    expect(await (await fetch(`${url}/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain("<title>Simlab</title>");
  });

  test('appends posted gap records to data/gaps.jsonl with the wall-clock time', async () => {
    const { url, data } = await start();
    const res = await fetch(`${url}/api/gaps`, { method: 'POST', body: JSON.stringify({ records: [gap, { ...gap, what: '--v' }] }) });
    expect(res.status).toBe(204);
    const lines = readFileSync(join(data, 'gaps.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as GapPost & { at: string });
    expect(lines.map((l) => l.what)).toEqual(['--raw', '--v']);
    expect(lines[0]?.context.item).toBe('k8s.workloads.deployment-service-01');
    expect(lines[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test('refuses what is not a gap record', async () => {
    const { url } = await start();
    const post = (body: string) => fetch(`${url}/api/gaps`, { method: 'POST', body });
    expect(await (await post('nope')).text()).toBe('the body is not JSON\n');
    expect((await post(JSON.stringify({ records: [{ ...gap, v: 2 }] }))).status).toBe(400);
    expect((await fetch(`${url}/api/gaps`)).status).toBe(405);
    expect((await fetch(`${url}/api/other`, { method: 'POST' })).status).toBe(404);
  });
});
