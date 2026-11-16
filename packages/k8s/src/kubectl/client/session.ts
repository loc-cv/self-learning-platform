// A kubectl invocation's connection to its API server: the kubeconfig and global flags resolved
// (kubeconfig.ts), the server reached (transport.ts), and requests sent through the API server's
// pipeline with its warnings printed as kubectl prints them.
//   upstream: staging/src/k8s.io/client-go/rest/warnings.go WarningWriter (`Warning: <text>` on
//             standard error, each text once per invocation: kubectl sets Deduplicate)
//   upstream: staging/src/k8s.io/client-go/discovery/cached/memory/memcache.go:381 (the klog line
//             a failed discovery request logs) — five attempts before get gives up, as captured in
//             fixtures/golden/v1.37.2/client/no-server.yaml
//   upstream: staging/src/k8s.io/klog/v2 header: `Lmmdd hh:mm:ss.uuuuuu threadid file:line] `

import { civilFromMillis, type Ctx } from '@simlab/kernel';
import { FsError, type ProcApi } from '@simlab/host';
import type { Op } from '@simlab/host';
import type { ApiServerConfig } from '../../apiserver/config.ts';
import { handle, openWatch, watchEvents } from '../../apiserver/pipeline.ts';
import { closeSubscription, watchTopic, type WatchEventType } from '../../apiserver/store.ts';
import type { ApiRequest, ApiResponse } from '../../apiserver/types.ts';
import type { JsonObject } from '../../apimachinery/json.ts';
import type { Status } from '../../apimachinery/errors.ts';
import { errorMessage, type KubectlError } from '../cli/errors.ts';
import { clientConfig, loadKubeconfig, type ClientConfig, type Overrides, type ParseYaml, type ReadFile } from './kubeconfig.ts';
import { connect, type ServerUrl } from './transport.ts';

export interface Session {
  p: ProcApi;
  config: ClientConfig;
  server: ApiServerConfig;
  url: ServerUrl;
  /** Warnings already printed (deduplicated per invocation). */
  warned: Set<string>;
}

/** Overrides from the global flags kubectl simulates. */
export function overridesOf(values: Record<string, unknown>): Overrides {
  const s = (k: string) => (typeof values[k] === 'string' && values[k] !== '' ? (values[k] as string) : undefined);
  const o: Overrides = {};
  const set = (k: keyof Overrides, flag: string) => {
    const v = s(flag);
    if (v !== undefined) o[k] = v;
  };
  set('kubeconfig', 'kubeconfig');
  set('context', 'context');
  set('cluster', 'cluster');
  set('user', 'user');
  set('namespace', 'namespace');
  set('server', 'server');
  return o;
}

/** Reads a kubeconfig file as the process: ENOENT is a missing file, other errors are Go's texts. */
function reader(p: ProcApi): ReadFile {
  const fs = p.fs();
  return (path) => {
    try {
      return fs.readFile(path);
    } catch (e) {
      if (e instanceof FsError) {
        if (e.code === 'ENOENT') return { missing: true };
        if (e.code === 'EISDIR') return { error: `read ${path}: is a directory` };
        if (e.code === 'EACCES') return { error: `open ${path}: permission denied` };
        if (e.code === 'ENOTDIR') return { missing: true };
      }
      throw e;
    }
  };
}

/** Writes CheckErr's output for `err`; returns the exit status. */
export function* fail(p: ProcApi, err: KubectlError): Op<number> {
  if (err.type === 'notSimulated') return yield* p.unsupported({ kind: 'behavior', what: err.what });
  const m = errorMessage(err);
  if (m.text !== '') yield* p.write(2, m.text);
  return m.code;
}

/** The client configuration (Namespace() and ClientConfig()), or the error kubectl prints. */
export function resolveConfig(p: ProcApi, overrides: Overrides, parseYaml: ParseYaml): ClientConfig | KubectlError {
  const home = p.env.HOME ?? '';
  const cfg = loadKubeconfig(reader(p), parseYaml, p.env, home, overrides.kubeconfig);
  if ('type' in cfg) return cfg;
  return clientConfig(cfg, overrides);
}

function klogHeader(ctx: Ctx, pid: string, file: string): string {
  const c = civilFromMillis(ctx.now);
  const two = (n: number) => String(n).padStart(2, '0');
  return `E${two(c.month)}${two(c.day)} ${two(c.hour)}:${two(c.minute)}:${two(c.second)}.${String(c.ms * 1000).padStart(6, '0')} ${pid.padStart(7)} ${file}] `;
}

/**
 * Opens the session: connects to the configured server. A refused connection prints what kubectl's
 * discovery logs and the final error, and returns the exit status; a destination the simulator
 * cannot model prints a notice.
 */
export function* openSession(p: ProcApi, config: ClientConfig): Op<Session | number> {
  const c = connect(p.ctx, p.machine, config.server);
  if (c.ok) return { p, config, server: c.server, url: c.url, warned: new Set() };
  if ('invalid' in c) return yield* fail(p, { type: 'message', message: c.invalid });
  if ('notSimulated' in c) return yield* p.unsupported({ kind: 'behavior', what: c.notSimulated });
  const url = `${c.url.base}/api?timeout=32s`;
  const dial = `dial tcp ${c.url.dialAddress}: connect: connection refused`;
  const err = `Get \\"${url}\\": ${dial}`;
  const pid = p.pid.replace(/^\D+/, '');
  let logged = '';
  for (let i = 0; i < 5; i++) logged += `${klogHeader(p.ctx, pid, 'memcache.go:381')}"Couldn't get current server API group list" err="${err}"\n`;
  yield* p.write(2, logged);
  return yield* fail(p, { type: 'url', op: 'Get', url, err: dial });
}

/** Sends a request; prints the response's warnings once each. */
export function* request(s: Session, req: ApiRequest): Op<ApiResponse> {
  const r = handle(s.p.ctx, s.server, req);
  yield* printWarnings(s, r.warnings);
  return r;
}

export function* printWarnings(s: Session, warnings: readonly string[]): Op<void> {
  for (const w of warnings) {
    if (s.warned.has(w)) continue;
    s.warned.add(w);
    yield* s.p.write(2, `Warning: ${w}\n`);
  }
}

export type WatchOpen = { id: string; topic: string } | { status: Status } | { notSimulated: string };

/** Opens a watch owned by this process. */
export function openProcessWatch(s: Session, req: ApiRequest): WatchOpen {
  const r = openWatch(s.p.ctx, s.server, req, { machine: s.p.machine, pid: s.p.pid });
  if ('ok' in r) return { id: r.ok.id, topic: watchTopic(r.ok.id) };
  return r;
}

export function takeWatchEvents(s: Session, id: string): { type: WatchEventType; object: JsonObject }[] {
  return watchEvents(s.p.ctx, s.server, id);
}

export function closeWatch(s: Session, id: string): void {
  closeSubscription(s.p.ctx, id);
}
