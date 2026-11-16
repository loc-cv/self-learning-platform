// nginx as the official images run it: `nginx -g 'daemon off;'`, a master process (PID 1) and
// worker_processes workers, logging to the error log, which the image links to /dev/stderr
// (var/log/nginx/error.log -> /dev/stderr in the nginx:1.31.8, nginx:alpine and nginx:1.14.2
// layers, read 2026-11-16).
//
// upstream: nginx release-1.31.8 (.upstream/nginx). Line format: src/core/ngx_log.c
// ngx_log_error_core ("%4d/%02d/%02d %02d:%02d:%02d" from src/core/ngx_times.c ngx_time_update,
// " [%V] ", "%P#" NGX_TID_T_FMT ": "; the tid is gettid(), equal to the pid in a single-threaded
// process, src/os/unix/ngx_thread_id.c, since the images are built --with-threads).
//
// The image's nginx.conf decides what is printed (`error_log /var/log/nginx/error.log notice;`
// and `worker_processes auto;` in the images with /docker-entrypoint.sh, read from the
// nginx:1.31.8 and nginx:alpine layers; `warn` and `1` in nginx:1.14.2, which has no entrypoint).
// Every line below is NOTICE, so at `warn` the program is silent. Tags that share a
// representative's files (catalog.data.ts filesFrom) are taken to share its nginx.conf too.

import type { Json, Millis } from '@simlab/kernel';
import type { ModelGap, ModelStep, Output, ProcessInput, ProgramModel, Signal } from '../types.ts';
import { CONTAINER_NOFILE, NODE_KERNEL_RELEASE, getenv, pad, scriptShell, until, utc } from './common.ts';
import { ENTRYPOINT_PIDS_USED } from './nginx-entrypoint.ts';

/**
 * NGX_COMPILER of each captured binary: the `built by gcc …` string in /usr/sbin/nginx (strings
 * of the binary from the image layers, read 2026-11-16), trailing space included, as configure
 * takes it from `gcc -v`. Versions not listed were not captured: their `built by` line is left out.
 */
const BUILT_BY: Readonly<Record<string, { debian?: string; alpine?: string }>> = {
  '1.31.8': { debian: 'gcc 14.2.0 (Debian 14.2.0-19) ', alpine: 'gcc 15.2.0 (Alpine 15.2.0) ' },
  '1.14.2': { debian: 'gcc 6.3.0 20170516 (Debian 6.3.0-18+deb9u1) ' },
};

/** --conf-path of the images' builds (configure arguments in the binary). */
const CONF_PATH = '/etc/nginx/nginx.conf';

/** Signal numbers and names as ngx_signal_handler prints them (src/os/unix/ngx_process.c signals[]). */
const SIGNO: Readonly<Record<Signal, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15, SIGWINCH: 28 };

interface NginxState {
  phase: 'running' | 'exiting';
  version: string;
  notice: boolean;
  workers: number[];
  exitAt?: Millis;
}

/** ngx_log_error's line: `2026/11/16 05:47:37 [notice] 1#1: msg`. */
function errorLogLine(t: Millis, pid: number, msg: string): string {
  const c = utc(t);
  return `${pad(c.year, 4)}/${pad(c.month)}/${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)} [notice] ${pid}#${pid}: ${msg}\n`;
}

/** ngx_log_stderr: `nginx: msg` (src/core/ngx_log.c). */
const stderrLine = (msg: string): Output => ({ stream: 'stderr', text: `nginx: ${msg}\n` });

interface Options {
  version: boolean;
  help: boolean;
  configure: boolean;
  test: boolean;
  dump: boolean;
  quiet: boolean;
  params?: string;
  other: string[];
  error?: string;
}

/** ngx_get_options (src/core/nginx.c): single-letter flags, bundled; -p -e -c -g -s -l take a value. */
function parseOptions(argv: string[]): Options {
  const o: Options = { version: false, help: false, configure: false, test: false, dump: false, quiet: false, other: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('-')) return { ...o, error: `invalid option: "${a}"` };
    let j = 1;
    while (j < a.length) {
      const ch = a[j++] as string;
      switch (ch) {
        case '?':
        case 'h':
          o.version = o.help = true;
          break;
        case 'v':
          o.version = true;
          break;
        case 'V':
          o.version = o.configure = true;
          break;
        case 't':
          o.test = true;
          break;
        case 'T':
          o.test = o.dump = true;
          break;
        case 'q':
          o.quiet = true;
          break;
        case 'p':
        case 'e':
        case 'c':
        case 'g':
        case 's':
        case 'l': {
          const value = j < a.length ? a.slice(j) : argv[++i];
          if (value === undefined) {
            const need: Record<string, string> = { p: 'option "-p" requires directory name', e: 'option "-e" requires file name', c: 'option "-c" requires file name', g: 'option "-g" requires parameter', s: 'option "-s" requires parameter', l: 'option "-l" requires listen address' };
            return { ...o, error: need[ch] as string };
          }
          if (ch === 's' && !['stop', 'quit', 'reopen', 'reload'].includes(value)) return { ...o, error: `invalid option: "-s ${value}"` };
          if (ch === 'g') o.params = value;
          else o.other.push(`-${ch} ${value}`);
          j = a.length;
          break;
        }
        default:
          return { ...o, error: `invalid option: "${ch}"` };
      }
    }
  }
  return o;
}

interface Image {
  version: string;
  builtBy?: string;
  notice: boolean;
  workerCount: number;
  firstWorkerPid: number;
  gaps: ModelGap[];
}

function image(p: ProcessInput): Image | undefined {
  const raw = getenv(p, 'NGINX_VERSION');
  if (raw === undefined) return undefined;
  // NGINX_VERSION is the bare version in current images, `1.14.2-1~stretch` (the package version) in old ones.
  const version = raw.split('-')[0] as string;
  const shell = scriptShell(p);
  const variant = shell === 'busybox' ? 'alpine' : 'debian';
  const entrypointEra = p.which('/docker-entrypoint.sh') !== undefined;
  const builtBy = BUILT_BY[version]?.[variant];
  const gaps: ModelGap[] = [];
  const notice = entrypointEra;
  if (notice && builtBy === undefined) gaps.push({ what: `nginx ${version} (${variant}): build compiler not captured`, detail: 'the "built by" notice is left out' });
  return {
    version,
    ...(builtBy !== undefined ? { builtBy } : {}),
    notice,
    // worker_processes auto: ngx_ncpu, sysconf(_SC_NPROCESSORS_ONLN) (src/os/unix/ngx_posix_init.c).
    workerCount: entrypointEra ? Math.max(1, p.cpus) : 1,
    // Assumes nginx was exec'd by the image's entrypoint when the image has one (the model cannot
    // tell a `command:` override apart); see ENTRYPOINT_PIDS_USED.
    firstWorkerPid: entrypointEra ? 2 + ENTRYPOINT_PIDS_USED[shell] : 2,
    gaps,
  };
}

function withGaps(step: ModelStep, gaps: ModelGap[]): ModelStep {
  return gaps.length ? { ...step, gaps: [...(step.gaps ?? []), ...gaps] } : step;
}

function start(p: ProcessInput): ModelStep {
  const o = parseOptions(p.argv);
  if (o.error !== undefined) return { output: [stderrLine(o.error)], next: { exit: 1 } };
  const img = image(p);
  if (!img) return { gaps: [{ what: 'nginx without NGINX_VERSION in its environment', detail: 'the binary version is unknown' }], next: { wait: true, state: null } };
  if (o.help || o.configure || o.dump || o.other.length > 0) {
    return { gaps: [{ what: `nginx ${p.argv.slice(1).join(' ')}`, detail: 'only -v, -t, -q and -g "daemon off;" are modeled' }], next: { exit: 0 } };
  }
  const output: Output[] = [];
  // ngx_show_version_info: written with ngx_write_stderr before anything else (src/core/nginx.c).
  if (o.version) output.push({ stream: 'stderr', text: `nginx version: nginx/${img.version}\n` });
  if (o.version && !o.test) return { output, next: { exit: 0 } };

  const params = (o.params ?? '').replace(/\s+/g, ' ').trim();
  if (params !== '' && params !== 'daemon off;' && params !== 'daemon on;') {
    return { gaps: [{ what: `nginx -g '${o.params ?? ''}'`, detail: 'only "daemon off;" and "daemon on;" are modeled' }], next: { exit: 0 } };
  }
  if (o.test) {
    // ngx_init_cycle and main (src/core/ngx_cycle.c, src/core/nginx.c) with the image's valid configuration.
    if (!o.quiet) output.push(stderrLine(`the configuration file ${CONF_PATH} syntax is ok`), stderrLine(`configuration file ${CONF_PATH} test is successful`));
    return { ...(output.length ? { output } : {}), next: { exit: 0 } };
  }

  // The notices of a start, in the order main() logs them: the event module's init in
  // ngx_init_cycle (src/event/ngx_event.c ngx_event_module_init: "using the "%s" event method",
  // epoll on Linux), then ngx_os_status (src/os/unix/ngx_posix_init.c: NGINX_VER_BUILD, which is
  // "nginx/<version>" as the images define no NGX_BUILD; "built by " NGX_COMPILER;
  // src/os/unix/ngx_linux_init.c "OS: %s %s" from uname; "getrlimit(RLIMIT_NOFILE): %r:%r").
  const t = p.now;
  const notices: string[] = ['using the "epoll" event method', `nginx/${img.version}`];
  if (img.builtBy !== undefined) notices.push(`built by ${img.builtBy}`);
  notices.push(`OS: Linux ${NODE_KERNEL_RELEASE}`, `getrlimit(RLIMIT_NOFILE): ${CONTAINER_NOFILE.soft}:${CONTAINER_NOFILE.hard}`);
  // `daemon` defaults to on (src/core/nginx.c ngx_core_module_init_conf) and the image's
  // nginx.conf does not set it: only `-g 'daemon off;'` keeps the master in the foreground.
  if (params !== 'daemon off;') {
    // ngx_daemon() forks after ngx_os_status and the parent, PID 1, exits 0 (src/os/unix/ngx_daemon.c):
    // the container ends, and the kernel kills the daemon with the rest of the PID namespace.
    // Whether the daemon logs "start worker processes" before it dies is a race; it is left out.
    if (img.notice) output.push(...notices.map((m) => ({ stream: 'stderr' as const, text: errorLogLine(t, 1, m) })));
    return withGaps({ ...(output.length ? { output } : {}), next: { exit: 0, after: 1 } }, img.gaps);
  }
  const workers = Array.from({ length: img.workerCount }, (_, i) => img.firstWorkerPid + i);
  // ngx_master_process_cycle → ngx_start_worker_processes ("start worker processes") →
  // ngx_spawn_process ("start %s %P", name "worker process") (src/os/unix/ngx_process_cycle.c,
  // src/os/unix/ngx_process.c).
  notices.push('start worker processes', ...workers.map((w) => `start worker process ${w}`));
  if (img.notice) output.push(...notices.map((m) => ({ stream: 'stderr' as const, text: errorLogLine(t, 1, m) })));
  const state: NginxState = { phase: 'running', version: img.version, notice: img.notice, workers };
  // Port 80 from conf.d/default.conf (`listen 80;`, plus `listen [::]:80;` once the entrypoint enabled IPv6).
  return withGaps({ ...(output.length ? { output } : {}), listen: [{ port: 80, protocol: 'tcp' }], next: { wait: true, state: state as unknown as Json } }, img.gaps);
}

/**
 * Shutdown. The master logs the signal (ngx_signal_handler: "signal %d (%s) received%s"; no
 * "from <pid>", since containerd's kill comes from outside the PID namespace and si_pid is 0)
 * and tells each worker over its channel (NGX_CMD_QUIT or NGX_CMD_TERMINATE, so the workers log
 * no signal). A worker logs "gracefully shutting down" for quit, then "exiting" and, in
 * ngx_worker_process_exit, "exit". The master reaps each worker from SIGCHLD ("signal 17
 * (SIGCHLD) received from %P", which a sibling in the namespace does carry; ngx_process_get_status
 * "%s %P exited with code %d"), and closing a reaped worker's channel while a later worker still
 * holds its end raises SIGIO on the master (F_SETOWN in ngx_spawn_process): "signal 29 (SIGIO)
 * received". With no worker left, ngx_master_process_exit logs "exit" and exits 0.
 * The real interleaving depends on scheduling; this is one order the code allows: workers in
 * spawn order, each finishing before the master reaps them in the same order.
 */
function shutdown(p: ProcessInput, st: NginxState, signal: 'SIGQUIT' | 'SIGTERM' | 'SIGINT'): ModelStep {
  const t = p.now;
  const quit = signal === 'SIGQUIT';
  const msgs: [Millis, number, string][] = [[0, 1, `signal ${SIGNO[signal]} (${signal}) received, ${quit ? 'shutting down' : 'exiting'}`]];
  for (const w of st.workers) {
    if (quit) msgs.push([1, w, 'gracefully shutting down']);
    msgs.push([1, w, 'exiting'], [1, w, 'exit']);
  }
  st.workers.forEach((w, i) => {
    msgs.push([2 + i, 1, `signal 17 (SIGCHLD) received from ${w}`], [2 + i, 1, `worker process ${w} exited with code 0`]);
    if (i < st.workers.length - 1) msgs.push([2 + i, 1, 'signal 29 (SIGIO) received']);
  });
  const end = 2 + st.workers.length;
  msgs.push([end, 1, 'exit']);
  const output: Output[] = st.notice ? msgs.map(([after, pid, m]) => ({ ...(after ? { after } : {}), stream: 'stderr' as const, text: errorLogLine(t + after, pid, m) })) : [];
  const next: NginxState = { ...st, phase: 'exiting', exitAt: t + end };
  return { ...(output.length ? { output } : {}), listen: [], next: { wake: end, state: next as unknown as Json } };
}

function signal(p: ProcessInput, state: Json, sig: Signal): ModelStep | 'default' {
  const st = state as unknown as NginxState | null;
  if (st === null) return 'default';
  if (st.phase === 'exiting') return { next: { wake: until(st.exitAt ?? p.now, p.now), state } };
  switch (sig) {
    case 'SIGQUIT':
    case 'SIGTERM':
    case 'SIGINT':
      return shutdown(p, st, sig);
    case 'SIGWINCH':
      // NGX_NOACCEPT_SIGNAL is acted on only by a daemonized master: with daemon off the action is empty.
      return { ...(st.notice ? { output: [{ stream: 'stderr', text: errorLogLine(p.now, 1, 'signal 28 (SIGWINCH) received') }] } : {}), next: { wait: true, state } };
    default:
      return { gaps: [{ what: `nginx master: ${sig}`, detail: 'reconfiguring, reopening logs and changing the binary are not modeled' }], next: { wait: true, state } };
  }
}

export const nginxModel: ProgramModel = {
  name: 'nginx',
  start,
  resume(_p, state: Json): ModelStep {
    const st = state as unknown as NginxState | null;
    if (st?.phase === 'exiting') return { next: { exit: 0 } };
    return { next: { wait: true, state } };
  },
  signal,
};
