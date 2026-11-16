// The official httpd images: /usr/local/bin/httpd-foreground and Apache httpd 2.4 with the
// event MPM, as the image's httpd.conf configures it (the same file in the Debian and Alpine
// images, read from the httpd:2.4.71 and httpd:alpine layers 2026-11-16): `Listen 80`,
// `LoadModule mpm_event_module`, no ServerName, `ErrorLog /proc/self/fd/2`, `LogLevel warn`, no
// ErrorLogFormat, no ServerTokens, mod_ssl not loaded.
//
// upstream: apache/httpd 2.4.71 (.upstream/httpd).

import type { Json, Millis } from '@simlab/kernel';
import type { ModelGap, ModelStep, Output, ProcessInput, ProgramModel, Signal } from '../types.ts';
import { MONTHS, WEEKDAYS, getenv, line, pad, scriptExec, scriptShell, until, utc } from './common.ts';

/**
 * httpd-foreground (fixtures/reference/images/scripts/httpd/usr/local/bin/httpd-foreground, the
 * same in httpd-alpine/): `rm -f /usr/local/apache2/logs/httpd.pid`, then on line 7
 * `exec httpd -DFOREGROUND "$@"` under #!/bin/sh (dash on Debian, BusyBox ash on Alpine).
 */
export const httpdForegroundModel: ProgramModel = {
  name: 'httpd-foreground',
  start: (p) => scriptExec(p, scriptShell(p), 7, ['httpd', '-DFOREGROUND', ...p.argv.slice(1)]),
  resume: () => ({ next: { exit: 0 } }),
};

/**
 * The error log's default format (server/log.c do_errorlog_default, no ErrorLogFormat):
 * `[<ctime with usec>] [<module>:<level>] [pid <pid>:tid <tid>] <message>`. The time is
 * ap_recent_ctime_ex with AP_CTIME_OPTION_USEC (server/util_time.c): `Mon Nov 16 05:47:37.123456 2026`,
 * day of month zero-padded, local time, which is UTC in the container.
 */
function ctimeUsec(t: Millis, usec: number): string {
  const c = utc(t);
  return `${WEEKDAYS[c.weekday] as string} ${MONTHS[c.month - 1] as string} ${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}.${pad(c.ms * 1000 + usec, 6)} ${pad(c.year, 4)}`;
}

/**
 * The clock gives milliseconds; the microseconds within one are a deterministic function of the
 * line (a model choice, so that every line does not end in 000).
 */
function usecOf(t: Millis, salt: number): number {
  return (Math.imul(t ^ (salt * 0x9e3779b1), 2654435761) >>> 0) % 1000;
}

/**
 * The tid field: apr_os_thread_current() printed with %pT, the main thread's pthread_t as an
 * unsigned decimal (server/log.c log_tid; threaded MPMs only). It is the address of the thread's
 * control block, which ASLR moves on every start; the model derives a value of the same shape
 * (page-aligned, in the 0x7f… mmap range of x86-64) from the Pod name, so it stays deterministic.
 */
function mainTid(hostname: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < hostname.length; i++) h = Math.imul(h ^ hostname.charCodeAt(i), 0x01000193) >>> 0;
  return 0x7f0000000000 + (h % 0xffffff) * 0x1000 + 0x740;
}

function errorLog(t: Millis, tid: number, module: string, msg: string, salt: number): string {
  return `[${ctimeUsec(t, usecOf(t, salt))}] [${module}:notice] [pid 1:tid ${tid}] ${msg}`;
}

/**
 * What ap_get_local_host (server/util.c) resolves the Pod name to: getaddrinfo, then
 * getnameinfo of the address, through /etc/hosts, which the kubelet writes (`<podIP>\t<podName>`,
 * or `<podIP>\t<fqdn>\t<host>` with hostname and subdomain set). A dotted reverse name means a
 * fully qualified name was found and nothing is logged; otherwise the server name is the hostname
 * if it has a dot, else the address. Undefined when /etc/hosts cannot be read.
 */
function localHost(p: ProcessInput): { fqdn: true } | { name: string } | { failed: true } | undefined {
  const hosts = p.file('/etc/hosts');
  if (hosts === undefined) return undefined;
  const entries = hosts
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim().split(/\s+/))
    .filter((f) => f.length >= 2 && f[0] !== '');
  const forward = entries.find((f) => f.slice(1).includes(p.hostname));
  // Not in /etc/hosts: the cluster DNS does not answer for a bare Pod name either (assumed).
  if (!forward) return { failed: true };
  const ip = forward[0] as string;
  const reverse = entries.find((f) => f[0] === ip)?.[1] ?? ip;
  if (reverse.includes('.') && reverse !== ip) return { fqdn: true };
  return { name: p.hostname.includes('.') ? p.hostname : ip };
}

/** AH00557 and AH00558: logged with APLOG_STARTUP, so plain lines without the error log prefix (server/log.c). */
function serverNameLines(p: ProcessInput): { lines: string[]; gaps: ModelGap[] } {
  const r = localHost(p);
  if (r === undefined) return { lines: [], gaps: [{ what: 'httpd: ServerName lookup', detail: '/etc/hosts is not readable by models; the AH00558 lines are left out' }] };
  if ('fqdn' in r) return { lines: [], gaps: [] };
  const lines: string[] = [];
  let name: string;
  if ('failed' in r) {
    lines.push(`AH00557: httpd: apr_sockaddr_info_get() failed for ${p.hostname}`);
    name = '127.0.0.1';
  } else {
    name = r.name;
  }
  lines.push(`AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${name}. Set the 'ServerName' directive globally to suppress this message`);
  return { lines, gaps: [] };
}

/**
 * ap_mpm_rewrite_args (server/mpm_unix.c): argv[0], then each option apr_getopt finds in
 * "k:" AP_SERVER_BASEARGS ("C:c:D:d:E:e:f:vVlLtTSMh?X", include/http_main.h) as `-X` with its
 * argument as a separate word (`-k start|stop|…` is swallowed), then the rest verbatim.
 */
function rewriteArgs(argv: string[]): { words: string[]; options: [string, string | undefined][] } {
  const words = [argv[0] ?? 'httpd'];
  const options: [string, string | undefined][] = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a.length < 2) break;
    let j = 1;
    let stop = false;
    while (j < a.length) {
      const c = a[j++] as string;
      if ('kCcDdEef'.includes(c)) {
        const arg = j < a.length ? a.slice(j) : argv[++i];
        options.push([c, arg]);
        if (!(c === 'k' && arg !== undefined && ['start', 'stop', 'restart', 'graceful', 'graceful-stop'].includes(arg))) {
          words.push(`-${c}`);
          if (arg !== undefined) words.push(arg);
        }
        break;
      }
      if ('vVlLtTSMh?X'.includes(c)) {
        options.push([c, undefined]);
        words.push(`-${c}`);
      } else {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }
  words.push(...argv.slice(i));
  return { words, options };
}

/** ap_escape_errorlog_item: backslash before `"` and `\`, \xNN for control characters (server/util.c). */
function escapeErrorlog(s: string): string {
  let r = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    r += ch === '"' || ch === '\\' ? `\\${ch}` : c < 0x20 || c === 0x7f ? `\\x${c.toString(16).padStart(2, '0')}` : ch;
  }
  return r;
}

interface HttpdState {
  phase: 'running' | 'exiting';
  tid: number;
  exitAt?: Millis;
}

function start(p: ProcessInput): ModelStep {
  const { words, options } = rewriteArgs(p.argv);
  const defines = options.filter(([c]) => c === 'D').map(([, v]) => v);
  const others = options.filter(([c]) => c !== 'D');
  if (others.length > 0 || words.length !== 1 + 2 * options.length) {
    return { gaps: [{ what: `httpd ${p.argv.slice(1).join(' ')}`, detail: 'only -D FOREGROUND runs are modeled' }], next: { exit: 0 } };
  }
  if (!defines.includes('FOREGROUND')) {
    return { gaps: [{ what: `httpd ${p.argv.slice(1).join(' ')}`, detail: 'httpd without -DFOREGROUND detaches; not modeled' }], next: { exit: 0 } };
  }
  const version = getenv(p, 'HTTPD_VERSION');
  if (version === undefined) return { gaps: [{ what: 'httpd without HTTPD_VERSION in its environment', detail: 'the server version is unknown' }], next: { wait: true, state: null } };
  const gaps: ModelGap[] = defines.filter((d) => d !== 'FOREGROUND').map((d) => ({ what: `httpd -D ${d ?? ''}`, detail: '<IfDefine> sections and MPM switches are not evaluated' }));

  const t = p.now;
  const tid = mainTid(p.hostname);
  const sn = serverNameLines(p);
  gaps.push(...sn.gaps);
  const output: Output[] = [];
  // The configuration is read twice (server/main.c: the preflight pass and the first pass of the
  // main loop), and ap_fini_vhost_config (server/vhost.c) looks the name up on each.
  sn.lines.forEach((l) => output.push(line('stderr', l)));
  sn.lines.forEach((l) => output.push(line('stderr', l, 4)));
  // event_run (server/mpm/event/event.c), after the children are started:
  // AH00489 "%s configured -- resuming normal operations" with ap_get_server_description(),
  // AP_SERVER_BASEVERSION " (" PLATFORM ")" (server/core.c set_banner, include/ap_release.h,
  // os/unix/os.h PLATFORM "Unix"), then ap_log_command_line (server/log.c) AH00094 "Command
  // line: '%s'" in the core module. Both NOTICE, which LogLevel does not filter (server/log.c).
  // AH00490 (Server built) is INFO and not printed at `warn`.
  const at = 10;
  output.push(
    line('stderr', errorLog(t + at, tid, 'mpm_event', `AH00489: Apache/${version} (Unix) configured -- resuming normal operations`, 1), at),
    line('stderr', errorLog(t + at, tid, 'core', `AH00094: Command line: '${escapeErrorlog(words.join(' '))}'`, 2), at),
  );
  const state: HttpdState = { phase: 'running', tid };
  const step: ModelStep = { output, listen: [{ port: 80, protocol: 'tcp' }], next: { wait: true, state: state as unknown as Json } };
  return gaps.length ? { ...step, gaps } : step;
}

/**
 * Stopping (os/unix/unixd.c sig_term: SIGTERM, SIGINT and SIGWINCH set shutdown_pending; all but
 * SIGWINCH also is_ungraceful; server/mpm/event/event.c event_run):
 * - ungraceful: the children are sent SIGTERM and reaped (ap_reclaim_child_processes in
 *   server/mpm_unix.c sleeps 16.384 ms before its first check), then AH00491 "caught SIGTERM,
 *   shutting down" (the text names SIGTERM whatever the signal);
 * - graceful (SIGWINCH, AP_SIG_GRACEFUL_STOP, the images' StopSignal): AH00492 "caught SIGWINCH,
 *   shutting down gracefully" at once, then one-second sleeps until no child is left (idle
 *   children leave at once, so one sleep); GracefulShutdownTimeout defaults to 0, no limit.
 * Then main returns and destroy_and_exit_process (server/main.c) sleeps 10 ms and exits 0.
 * Long requests that keep a child busy are not modeled: there are no requests yet.
 */
function signal(p: ProcessInput, state: Json, sig: Signal): ModelStep | 'default' {
  const st = state as unknown as HttpdState | null;
  if (st === null) return 'default';
  if (st.phase === 'exiting') return { next: { wake: until(st.exitAt ?? p.now, p.now), state } };
  const t = p.now;
  if (sig === 'SIGWINCH') {
    const end = 1000 + 10;
    return {
      output: [line('stderr', errorLog(t, st.tid, 'mpm_event', 'AH00492: caught SIGWINCH, shutting down gracefully', 3))],
      listen: [],
      next: { wake: end, state: { ...st, phase: 'exiting', exitAt: t + end } as unknown as Json },
    };
  }
  if (sig === 'SIGTERM' || sig === 'SIGINT') {
    const at = 16;
    const end = at + 10;
    return {
      output: [line('stderr', errorLog(t + at, st.tid, 'mpm_event', 'AH00491: caught SIGTERM, shutting down', 4), at)],
      listen: [],
      next: { wake: end, state: { ...st, phase: 'exiting', exitAt: t + end } as unknown as Json },
    };
  }
  // SIGHUP and SIGUSR1 restart (unixd.c sig_restart): rereading the configuration is not modeled.
  return { gaps: [{ what: `httpd: ${sig}`, detail: 'restarts are not modeled' }], next: { wait: true, state } };
}

export const httpdModel: ProgramModel = {
  name: 'httpd',
  start,
  resume(_p, state: Json): ModelStep {
    const st = state as unknown as HttpdState | null;
    if (st?.phase === 'exiting') return { next: { exit: 0 } };
    return { next: { wait: true, state } };
  },
  signal,
};
