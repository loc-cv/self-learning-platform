// HTTP access to OCI distribution registries for `npm run images:capture`, with Node's fetch.
// Anonymous only. Every document and blob read in full is checked against its digest.

import { createHash } from 'node:crypto';
import type { Json } from './catalog.ts';
import { REGISTRIES, RESOLVE_ACCEPT, type RegistrySpec } from './references.ts';

export interface Head {
  status: number;
  digest?: string;
  mediaType?: string;
  size?: number;
}

export interface Fetched {
  digest: string;
  mediaType: string;
  size: number;
  json: Json;
}

/** Counts requests per host, and remembers Docker Hub's last reported pull allowance. */
export const stats = { requests: new Map<string, number>(), rateLimitRemaining: undefined as string | undefined };

export function registrySpec(name: string): RegistrySpec {
  const r = REGISTRIES.find((x) => x.name === name);
  if (r === undefined) throw new Error(`unknown registry ${name}`);
  return r;
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const host = new URL(url).host;
  stats.requests.set(host, (stats.requests.get(host) ?? 0) + 1);
  const res = await fetch(url, init);
  const rl = res.headers.get('ratelimit-remaining');
  if (rl !== null) stats.rateLimitRemaining = rl;
  return res;
}

export function tokenUrl(reg: RegistrySpec, path: string): string | undefined {
  if (reg.token === undefined) return undefined;
  return `${reg.token.realm}?service=${encodeURIComponent(reg.token.service)}&scope=${encodeURIComponent(`repository:${path}:pull`)}`;
}

/** An anonymous pull session for one repository: one token, reused for every request. */
export interface Session {
  reg: RegistrySpec;
  path: string;
  headers: Record<string, string>;
  token?: { url: string; status: number };
}

export async function openSession(registry: string, path: string): Promise<Session> {
  const reg = registrySpec(registry);
  const url = tokenUrl(reg, path);
  if (url === undefined) return { reg, path, headers: {} };
  const res = await request(url);
  const body = (await res.json()) as { token?: string };
  const headers: Record<string, string> = typeof body.token === 'string' ? { Authorization: `Bearer ${body.token}` } : {};
  return { reg, path, headers, token: { url, status: res.status } };
}

function manifestUrl(s: Session, ref: string): string {
  return `${s.reg.api}/v2/${s.path}/manifests/${ref}`;
}

export async function headManifest(s: Session, ref: string): Promise<Head> {
  const res = await request(manifestUrl(s, ref), { method: 'HEAD', headers: { ...s.headers, Accept: RESOLVE_ACCEPT } });
  const digest = res.headers.get('docker-content-digest') ?? undefined;
  const mediaType = res.headers.get('content-type') ?? undefined;
  const len = res.headers.get('content-length');
  return {
    status: res.status,
    ...(digest !== undefined ? { digest } : {}),
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(len !== null ? { size: Number(len) } : {}),
  };
}

export function sha256(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function readVerified(res: Response, digest: string, what: string): Promise<Uint8Array> {
  if (res.status !== 200) throw new Error(`${what}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== digest) throw new Error(`${what}: content is ${got}, expected ${digest}`);
  return bytes;
}

/** GET a manifest or index by digest; its bytes must hash to the digest. */
export async function getManifest(s: Session, digest: string): Promise<Fetched> {
  const res = await request(manifestUrl(s, digest), { headers: { ...s.headers, Accept: RESOLVE_ACCEPT } });
  const bytes = await readVerified(res, digest, `${s.path}@${digest}`);
  const mediaType = res.headers.get('content-type') ?? '';
  return { digest, mediaType, size: bytes.length, json: JSON.parse(new TextDecoder().decode(bytes)) as Json };
}

export function blobUrl(s: Session, digest: string): string {
  return `${s.reg.api}/v2/${s.path}/blobs/${digest}`;
}

/** GET a small blob (an image config) by digest. */
export async function getBlobJson(s: Session, digest: string): Promise<{ size: number; json: Json }> {
  const res = await request(blobUrl(s, digest), { headers: s.headers });
  const bytes = await readVerified(res, digest, `${s.path} blob ${digest}`);
  return { size: bytes.length, json: JSON.parse(new TextDecoder().decode(bytes)) as Json };
}

/** A large blob (a layer) as a stream; the caller hashes it. */
export async function openBlob(s: Session, digest: string): Promise<ReadableStream<Uint8Array>> {
  const res = await request(blobUrl(s, digest), { headers: s.headers });
  if (res.status !== 200 || res.body === null) throw new Error(`${s.path} blob ${digest}: HTTP ${res.status}`);
  return res.body;
}

/** The repository's full tag list, following Link pagination (distribution spec "Listing Tags"). */
export async function listTags(s: Session): Promise<string[]> {
  const tags: string[] = [];
  let url: string | undefined = `${s.reg.api}/v2/${s.path}/tags/list?n=1000`;
  while (url !== undefined) {
    const res = await request(url, { headers: s.headers });
    if (res.status !== 200) throw new Error(`${s.path} tags/list: HTTP ${res.status}`);
    const body = (await res.json()) as { tags?: string[] | null };
    tags.push(...(body.tags ?? []));
    const link = res.headers.get('link');
    const m = link === null ? null : /<([^>]+)>\s*;\s*rel="?next"?/.exec(link);
    url = m?.[1] === undefined ? undefined : new URL(m[1], url).toString();
  }
  return tags;
}

/** The answer to a request that should fail, minus headers that change per request. */
export async function probe(s: Session, ref: string, method: 'HEAD' | 'GET'): Promise<{ url: string; status: number; contentType?: string; wwwAuthenticate?: string; body?: Json }> {
  const url = manifestUrl(s, ref);
  const res = await request(url, { method, headers: { ...s.headers, Accept: RESOLVE_ACCEPT } });
  const contentType = res.headers.get('content-type') ?? undefined;
  const www = res.headers.get('www-authenticate') ?? undefined;
  let body: Json | undefined;
  if (method === 'GET') {
    const text = await res.text();
    try {
      body = contentType?.includes('json') ? (JSON.parse(text) as Json) : text;
    } catch {
      body = text;
    }
  }
  return {
    url,
    status: res.status,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(www !== undefined ? { wwwAuthenticate: www } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}
