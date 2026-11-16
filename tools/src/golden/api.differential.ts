// The differential runner for raw API fixtures (fixtures/golden/<tag>/api/*.yaml, `request`
// steps): each captured request is sent through the simulator's request pipeline in a fresh
// world, and the response is normalized with the fixture's rules (normalize.ts) and compared
// with what the real API server answered. Used by api.test.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { bootstrapApiServer, DEFAULT_APISERVER, handle, k8sPlugin, type ApiRequest, type RequestOptions } from '@simlab/k8s';
import { fixturesDir } from '../oracle/paths.ts';
import { newContext, normalizeJson, type NormalizeContext } from './normalize.ts';

export interface RequestRecord {
  request: string;
  contentType?: string;
  body?: string;
  /** The top-level keys of the response the capture kept (`keep` in the case). */
  keep?: string[];
  code: number;
  warnings?: string[];
  response: unknown;
}

export interface Fixture {
  case: string;
  steps: (RequestRecord | Record<string, unknown>)[];
}

export function loadFixture(name: string): Fixture {
  return parseYaml(readFileSync(path.join(fixturesDir, `${name}.yaml`), 'utf8')) as Fixture;
}

const PATCH_TYPES: Record<string, NonNullable<RequestOptions['patchType']>> = {
  'application/merge-patch+json': 'merge',
  'application/strategic-merge-patch+json': 'strategic',
  'application/json-patch+json': 'json',
  'application/apply-patch+yaml': 'apply',
};

/** `<METHOD> <path?query>` → an ApiRequest. */
export function toApiRequest(rec: RequestRecord): ApiRequest | undefined {
  const [method, target] = rec.request.split(' ') as [string, string];
  const url = new URL(target, 'https://x');
  const parts = url.pathname.split('/').filter((p) => p !== '');
  let group = '';
  let version: string;
  let rest: string[];
  if (parts[0] === 'api') {
    version = parts[1] as string;
    rest = parts.slice(2);
  } else if (parts[0] === 'apis') {
    group = parts[1] as string;
    version = parts[2] as string;
    rest = parts.slice(3);
  } else return undefined;
  let namespace: string | undefined;
  if (rest[0] === 'namespaces' && rest.length >= 3) {
    namespace = rest[1];
    rest = rest.slice(2);
  }
  const [resource, name, subresource] = rest as [string | undefined, string | undefined, string | undefined];
  if (!resource) return undefined;
  const q = url.searchParams;
  const options: RequestOptions = {};
  if (q.has('fieldValidation')) options.fieldValidation = q.get('fieldValidation') as string;
  if (q.has('labelSelector')) options.labelSelector = q.get('labelSelector') as string;
  if (q.has('fieldSelector')) options.fieldSelector = q.get('fieldSelector') as string;
  if (q.has('gracePeriodSeconds')) options.gracePeriodSeconds = Number(q.get('gracePeriodSeconds'));
  if (q.has('propagationPolicy')) options.propagationPolicy = q.get('propagationPolicy') as string;
  if (q.get('dryRun') === 'All') options.dryRun = true;
  const verb = method === 'GET' ? (name ? 'get' : 'list') : method === 'POST' ? 'create' : method === 'PUT' ? 'update' : method === 'PATCH' ? 'patch' : 'delete';
  if (verb === 'patch') {
    // The Content-Type names the patch type (types.PatchType); the capture defaults to JSON.
    const ct = rec.contentType ?? 'application/json';
    const patchType = PATCH_TYPES[ct];
    if (!patchType) return undefined;
    options.patchType = patchType;
  }
  let body: unknown;
  if (rec.body !== undefined) {
    const trimmed = rec.body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // JSON text, possibly malformed or with duplicate keys: neither can come from a simulated
      // client, which sends values (kubectl rejects both before sending).
      try {
        body = JSON.parse(rec.body);
      } catch {
        return undefined;
      }
      if (hasDuplicateKeys(rec.body)) return undefined;
    } else body = parseYaml(rec.body);
  }
  return {
    verb,
    group,
    version,
    resource,
    ...(namespace ? { namespace } : {}),
    ...(name ? { name } : {}),
    ...(subresource ? { subresource } : {}),
    ...(body !== undefined ? { body: body as NonNullable<ApiRequest['body']> } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

/** True when a JSON text has an object with a repeated key. */
function hasDuplicateKeys(text: string): boolean {
  let dup = false;
  // JSON.parse keeps the last of repeated keys silently; scan keys per object instead.
  const stack: Set<string>[] = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:|[{}]/g;
  for (const m of text.matchAll(re)) {
    if (m[0] === '{') stack.push(new Set());
    else if (m[0] === '}') stack.pop();
    else {
      const top = stack[stack.length - 1];
      if (top?.has(m[1] as string)) dup = true;
      top?.add(m[1] as string);
    }
  }
  return dup;
}

export function bootCluster(seed = 1): Kernel {
  const k = bootKernel(createRegistry([hostPlugin, k8sPlugin]), { seed, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

/** Fields the simulator does not maintain, removed from both sides before comparing. */
export function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // managedFields: not maintained (DIV-015).
      if (k === 'managedFields') continue;
      out[k] = strip(x);
    }
    return out;
  }
  return v;
}

export interface StepResult {
  index: number;
  request: string;
  expected: { code: number; warnings: string[]; response: unknown };
  actual: { code: number; warnings: string[]; response: unknown } | { notSimulated: string } | { skipped: string };
}

/** Runs a fixture's request steps in order against one fresh cluster. */
export function runRequests(fixture: Fixture, seed = 1): StepResult[] {
  const k = bootCluster(seed);
  // The fixture is normalized already; the simulator's output gets the same rules, with its own
  // numbering of indexed tokens, which follows first appearance as the fixture's does.
  const got: NormalizeContext = newContext();
  const out: StepResult[] = [];
  fixture.steps.forEach((step, index) => {
    if (!('request' in step) || typeof step.request !== 'string') return;
    const rec = step as RequestRecord;
    const expected = { code: rec.code, warnings: rec.warnings ?? [], response: strip(rec.response) };
    const req = toApiRequest(rec);
    if (!req) {
      // The real server may have created an object here; keep the simulator's uid numbering in
      // step by reserving the numbers this response introduced.
      const table = (got.indices.uid ??= {});
      for (const m of JSON.stringify(rec.response).matchAll(/<<uid:(\d+)>>/g)) {
        while (Object.keys(table).length < Number(m[1])) table[`skipped-${index}-${Object.keys(table).length}`] = Object.keys(table).length + 1;
      }
      out.push({ index, request: rec.request, expected, actual: { skipped: 'a body no simulated client can send (malformed JSON, duplicate keys)' } });
      return;
    }
    const r = k.act(`step ${index}`, (ctx) => handle(ctx, DEFAULT_APISERVER, req));
    k.advance(0);
    if ('notSimulated' in r) {
      out.push({ index, request: rec.request, expected, actual: { notSimulated: r.notSimulated } });
      return;
    }
    let body: unknown = r.ok ? r.object : r.status;
    // A step captured with `keep` recorded only those top-level keys.
    const keep = rec.keep;
    if (keep && body !== null && typeof body === 'object') body = Object.fromEntries(Object.entries(body).filter(([key]) => keep.includes(key)));
    out.push({ index, request: rec.request, expected, actual: { code: r.code, warnings: r.warnings, response: strip(normalizeJson(body, got)) } });
  });
  return out;
}
