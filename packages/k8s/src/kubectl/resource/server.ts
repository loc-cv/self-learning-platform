// The server as the commands that read manifests reach it. Their clients are built before any file
// is read (f.Validator, f.ToRESTMapper: a configuration error is reported first), but nothing is
// sent until a document needs the server: the OpenAPI document that field validation checks
// against, and discovery for the document's mapping. With nothing listening, each of those fails
// on its own, and the command goes on with the next document or file.
//   fixtures/golden/v1.37.2/create/no-server.yaml (the texts of both failures)
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/query_param_verifier.go HasSupport
//             ("failed to download openapi: %v"); staging/src/k8s.io/client-go/discovery/cached/
//             memory/memcache.go:381 (the klog line of a failed discovery request);
//             net/url Error.Error (`Get "<url>": <err>`)

import type { Op, ProcApi } from '@simlab/host';
import type { ClientConfig } from '../client/kubeconfig.ts';
import { fail, klogLine, type Session } from '../client/session.ts';
import { connect, type ServerUrl } from '../client/transport.ts';

export type ServerState = { session: Session } | { refused: ServerUrl };

/** Builds the clients: the server state, or the exit status after the error or notice. */
export function* openServer(p: ProcApi, config: ClientConfig): Op<ServerState | number> {
  const c = connect(p.ctx, p.machine, config.server);
  if (c.ok) return { session: { p, config, server: c.server, url: c.url, warned: new Set() } };
  if ('invalid' in c) return yield* fail(p, { type: 'message', message: c.invalid });
  if ('notSimulated' in c) return yield* p.unsupported({ kind: 'behavior', what: c.notSimulated });
  return { refused: c.url };
}

function refusedGet(url: ServerUrl, path: string): string {
  return `Get "${url.base}${path}?timeout=32s": dial tcp ${url.dialAddress}: connect: connection refused`;
}

/** The OpenAPI download field validation makes: undefined, or its error text. */
export function openApiError(s: ServerState): string | undefined {
  if ('session' in s) return undefined;
  return `failed to download openapi: ${refusedGet(s.refused, '/openapi/v2')}`;
}

/** Discovery for a mapping: undefined, or (after the klog line discovery logs) its error text. */
export function* discoveryError(p: ProcApi, s: ServerState): Op<string | undefined> {
  if ('session' in s) return undefined;
  const err = refusedGet(s.refused, '/api');
  yield* p.write(2, klogLine(p, 'E', 'memcache.go:381', `"Couldn't get current server API group list" err="${err.replace(/"/g, '\\"')}"`));
  return err;
}

/** The session for a request that must reach the server; undefined when it is refused. */
export function sessionOf(s: ServerState): Session | undefined {
  return 'session' in s ? s.session : undefined;
}
