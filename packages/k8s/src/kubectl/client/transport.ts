// Where a client's requests go: the server URL of its configuration, resolved to an API server of
// the world or to the error a real client would get dialing it (docs/ARCHITECTURE.md §4.2,
// "API server not running"). Phase 17's network model replaces the address lookup; the API server
// becoming a process (phase 27) decides whether it listens.
//   upstream: staging/src/k8s.io/client-go/rest/url_utils.go DefaultServerURL (a server without a
//             scheme gets http:// when no TLS is configured, which kubeadm's files cannot have yet)
//   upstream: Go net/http (*url.Error).Error: `<Op> "<URL>": <Err>`; net.OpError
//             `dial tcp <addr>: connect: connection refused`

import { hostSlice } from '@simlab/host';
import type { Ctx } from '@simlab/kernel';
import type { ApiServerConfig } from '../../apiserver/config.ts';
import { k8sSlice } from '../../apiserver/store.ts';

export interface ServerUrl {
  scheme: 'http' | 'https';
  host: string;
  port: number;
  /** `scheme://host[:port]` as the client prints it in URLs (no trailing slash). */
  base: string;
  /** host:port as dialed: `localhost` as the workstation's capture shows it (docs/FIDELITY.md §6.9). */
  dialAddress: string;
}

export type Connection =
  | { ok: true; server: ApiServerConfig; url: ServerUrl }
  /** The address answers but nothing listens on the port. */
  | { ok: false; refused: true; url: ServerUrl }
  /** The simulator cannot tell what this address reaches. */
  | { ok: false; notSimulated: string; url?: ServerUrl }
  | { ok: false; invalid: string };

/** Parses the configured server the way rest.DefaultServerURL does, for host forms kubeconfigs use. */
export function parseServerUrl(server: string): ServerUrl | { invalid: string } {
  let s = server;
  let scheme: 'http' | 'https' = 'http';
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
  if (m) {
    const sc = (m[1] as string).toLowerCase();
    if (sc !== 'http' && sc !== 'https') return { invalid: `unsupported scheme ${sc}` };
    scheme = sc;
    s = s.slice(m[0].length);
  }
  const slash = s.indexOf('/');
  const hostport = slash >= 0 ? s.slice(0, slash) : s;
  let host = hostport;
  let port = scheme === 'https' ? 443 : 80;
  let explicitPort = false;
  const v6 = /^\[([^\]]*)\](?::(\d+))?$/.exec(hostport);
  if (v6) {
    host = v6[1] as string;
    if (v6[2]) [port, explicitPort] = [Number(v6[2]), true];
  } else {
    const c = hostport.lastIndexOf(':');
    if (c >= 0) {
      const p = hostport.slice(c + 1);
      if (!/^\d+$/.test(p)) return { invalid: `invalid port "${p}"` };
      host = hostport.slice(0, c);
      port = Number(p);
      explicitPort = true;
    }
  }
  const shownHost = host.includes(':') ? `[${host}]` : host;
  const base = `${scheme}://${shownHost}${explicitPort ? `:${port}` : ''}`;
  // The workstation resolves localhost to ::1 first (docs/FIDELITY.md §6.9).
  const dialHost = host === 'localhost' ? '[::1]' : shownHost;
  return { scheme, host, port, base, dialAddress: `${dialHost}:${port}` };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** The machine an address reaches from `from`, if the simulator knows it. */
function machineOf(ctx: Ctx, from: string, host: string): string | undefined {
  if (LOOPBACK.has(host) || /^127\./.test(host)) return from;
  const machines = hostSlice(ctx).machines;
  for (const id of Object.keys(machines).sort()) {
    if (machines[id]?.addresses?.includes(host)) return id;
  }
  return undefined;
}

/** Connects a client on machine `from` to the configured server. */
export function connect(ctx: Ctx, from: string, server: string): Connection {
  const url = parseServerUrl(server);
  if ('invalid' in url) return { ok: false, invalid: url.invalid };
  const target = machineOf(ctx, from, url.host);
  if (target === undefined) return { ok: false, notSimulated: `connecting to ${url.host}`, url };
  const machines = hostSlice(ctx).machines;
  if (machines[target]?.boot.state !== 'running') return { ok: false, notSimulated: `connecting to a machine that is off`, url };
  // An API server listens on every address of its machine (kube-apiserver --bind-address 0.0.0.0).
  const servers = k8sSlice(ctx).apiServers;
  for (const key of Object.keys(servers).sort()) {
    const s = servers[key] as ApiServerConfig;
    if (s.securePort !== url.port) continue;
    if (machineOf(ctx, from, s.advertiseAddress) !== target) continue;
    if (url.scheme === 'http') return { ok: false, notSimulated: 'plain HTTP to the API server\'s secure port', url };
    return { ok: true, server: s, url };
  }
  return { ok: false, refused: true, url };
}
