// The official redis images: /usr/local/bin/docker-entrypoint.sh and redis-server with the
// default configuration (no config file), as a Pod runs them: stdout is a pipe, not a tty.
//
// upstream: redis 8.10.3, 7.4.12, 7.2.17 and 6.2.24 (.upstream/redis-<version>/src), the
// versions the image catalog carries; the model follows the major version in REDIS_VERSION
// (7.2 and 7.4 print the same lines). Other majors are a gap.

import type { Json, Millis } from '@simlab/kernel';
import type { ModelGap, ModelStep, Output, ProcessInput, ProgramModel, Signal } from '../types.ts';
import { getenv, line, MONTHS, pad, scriptExec, scriptShell, until, utc } from './common.ts';

type Major = 6 | 7 | 8;

function majorOf(p: ProcessInput): Major | undefined {
  const m = Number((getenv(p, 'REDIS_VERSION') ?? '').split('.')[0]);
  return m === 6 || m === 7 || m === 8 ? m : undefined;
}

/**
 * The modules the redis 8 images ship in /usr/local/lib/redis/modules/, all mode 0755 (layer
 * listings of redis:8.10.3 and redis:alpine, read 2026-11-16), in the glob's order.
 */
const MODULES = ['redisbloom.so', 'redisearch.so', 'redistimeseries.so', 'rejson.so'];
const MODULES_DIR = '/usr/local/lib/redis/modules/';

/**
 * docker-entrypoint.sh. Two scripts:
 * - redis 8 (fixtures/reference/images/scripts/redis/ and redis-alpine/; #!/bin/bash on Debian,
 *   #!/bin/sh on Alpine): as root with CAP_SETUID and CAP_SETGID (containerd's defaults) it
 *   leaves an empty /data as it is (owned by redis in the image) and re-execs itself through
 *   setpriv as redis; the second pass sets umask 0077, prints "Starting Redis Server" and appends
 *   `--loadmodule <dir>/<file>` for each module (the glob keeps the directory's trailing slash,
 *   so the paths have `//`), then `exec "$@"` on line 184.
 * - redis 6.2, 7.2 and 7.4 (the script in those images' last layer, 24 lines, #!/bin/sh, read
 *   2026-11-16; not yet in fixtures/): chown of /data, the same setpriv re-exec, umask, then
 *   `exec "$@"` on line 24. It prints nothing.
 * Both prepend redis-server when the first argument is an option or a .conf file. The re-exec
 * through setpriv is not modeled as its own step: it changes the user (which models do not see)
 * and leaves the same process running the same script.
 */
function entrypointStart(p: ProcessInput): ModelStep {
  const major = majorOf(p);
  let args = p.argv.slice(1);
  const first = args[0] ?? '';
  if (first.startsWith('-') || first.endsWith('.conf')) args = ['redis-server', ...args];
  const v8 = major === 8;
  const shell = scriptShell(p, v8 && p.which('/bin/bash') ? '/bin/bash' : '/bin/sh');
  const execLine = v8 ? 184 : 24;
  const server = args[0] !== undefined && p.which(args[0])?.model === 'redis-server';
  const gaps: ModelGap[] = [];
  if (major === undefined) gaps.push({ what: `redis entrypoint of REDIS_VERSION ${getenv(p, 'REDIS_VERSION') ?? '(unset)'}`, detail: 'only the scripts of redis 6.2, 7.x and 8.x were captured' });
  if (args.includes('--sentinel')) gaps.push({ what: 'redis-server --sentinel', detail: 'sentinel mode is not modeled' });
  const output: Output[] = [];
  if (v8 && server && !args.includes('--sentinel')) {
    output.push(line('stdout', 'Starting Redis Server'));
    for (const m of MODULES) args.push('--loadmodule', `${MODULES_DIR}/${m}`);
  }
  // A few milliseconds for id, setpriv, find and the re-exec: a model choice.
  const step = scriptExec(p, shell, execLine, args, output, server ? 5 : undefined);
  return gaps.length ? { ...step, gaps } : step;
}

export const redisEntrypointModel: ProgramModel = {
  name: 'redis-entrypoint',
  start: entrypointStart,
  resume: () => ({ next: { exit: 0 } }),
};

/**
 * serverLogRaw (server.c): `<pid>:<role> <strftime "%d %b %Y %H:%M:%S."><ms %03d> <mark> <msg>`,
 * mark ".-*#"[level] (NOTICE `*`, WARNING `#`); role `C` while server.pid is still 0 (before
 * initServer sets it, so getpid() != server.pid), `M` after. Local time, UTC in the container.
 */
function logLine(t: Millis, role: 'C' | 'M', mark: '*' | '#', msg: string): string {
  const c = utc(t);
  return `1:${role} ${pad(c.day)} ${MONTHS[c.month - 1] as string} ${pad(c.year, 4)} ${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}.${pad(c.ms, 3)} ${mark} ${msg}`;
}

/** serverLogRawFromHandler (server.c): `<pid>:signal-handler (<time(NULL)>) <msg>`. */
const handlerLine = (t: Millis, msg: string): string => `1:signal-handler (${Math.floor(t / 1000)}) ${msg}`;

/**
 * Release facts compiled in (release.h from mkreleasehdr.sh in a tarball build: no .git, so the
 * SHA1 is 00000000). The dirty flag is `git diff … | wc -l` > 0: redis 8's script diffs
 * `-- ../src ../deps`, which outside a repository compares the two directories, so 8.10.3 says
 * modified=1; 6.2 and 7.x diff nothing. reference: REDIS_BUILD_ID_RAW and the DIRTY string in the
 * images' redis-server binaries (strings, 2026-11-16): 8.10.3 "461804", 7.4.12/7.2.17/6.2.24 "0".
 */
const MODIFIED: Readonly<Record<Major, number>> = { 6: 0, 7: 0, 8: 1 };

interface RedisState {
  phase: 'running' | 'stopping';
  major: Major;
  startedAt: Millis;
  stopAt?: Millis;
}

/** serverCron runs every 1000/hz ms (hz 10 by default) from the start; the next tick after `t`. */
function nextCron(startedAt: Millis, t: Millis): Millis {
  return startedAt + (Math.floor((t - startedAt) / 100) + 1) * 100;
}

/**
 * Startup with the default configuration. The conditional warnings stay silent on a kubeadm node:
 * - memory overcommit (syscheck.c checkOvercommit; 6.2 linuxMemoryWarnings): the kubelet sets
 *   vm.overcommit_memory=1 (upstream kubernetes v1.37.2 pkg/kubelet/cm/container_manager_linux.go
 *   setupKernelTunables);
 * - transparent huge pages: only for `[always]`, and disable-thp (default yes) turns them off for
 *   the process anyway; Ubuntu 24.04 has `madvise` (/sys/kernel/mm/transparent_hugepage/enabled
 *   on the workstation, 2026-11-16);
 * - TCP backlog: only when somaxconn < 511; the Pod's network namespace has 4096 (the default since
 *   Linux 5.4; /proc/sys/net/core/somaxconn on the workstation, 2026-11-16);
 * - "Increased maximum number of open files": only when RLIMIT_NOFILE < maxclients + 32 = 10032;
 *   containers get 1048576 (CONTAINER_NOFILE).
 * No dump.rdb in /data: rdbLoad returns RDB_NOT_EXIST silently. (A volume with a saved file would
 * add "DB loaded from disk"; models cannot see files yet.)
 */
function serverStart(p: ProcessInput): ModelStep {
  const major = majorOf(p);
  const version = getenv(p, 'REDIS_VERSION') ?? '';
  if (major === undefined) return { gaps: [{ what: `redis-server ${version || '(no REDIS_VERSION)'}`, detail: 'only redis 6.2, 7.x and 8.x are modeled' }], next: { wait: true, state: null } };
  const args = p.argv.slice(1);
  const modules: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--loadmodule' || args[i + 1] === undefined) {
      return { gaps: [{ what: `redis-server ${args.join(' ')}`, detail: 'only the default configuration (and the image’s --loadmodule arguments) is modeled' }], next: { wait: true, state: null } };
    }
    modules.push(args[i + 1] as string);
  }
  const t = p.now;
  const gaps: ModelGap[] = [];
  const out: [Millis, 'C' | 'M', '*' | '#', string][] = [];
  // redis 6.2 logs the banner, the version line and "Server initialized" at WARNING (server.c main).
  const loud: '*' | '#' = major === 6 ? '#' : '*';
  out.push([0, 'C', loud, 'oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo']);
  out.push([0, 'C', loud, `Redis version=${version}, bits=64, commit=00000000, modified=${MODIFIED[major]}, pid=1, just started`]);
  if (args.length === 0) {
    out.push([0, 'C', '#', `Warning: no config file specified, using the default config. In order to specify a config file use ${p.argv[0] ?? 'redis-server'} /path/to/redis.conf`]);
  } else {
    out.push([0, 'C', major === 6 ? '#' : '*', 'Configuration loaded']);
  }
  // initServer: "monotonic clock: %s" (USE_PROCESSOR_CLOCK is commented out in monotonic.c, so
  // the POSIX clock), then redisAsciiArt's one-line form when stdout is not a tty.
  out.push([1, 'M', '*', 'monotonic clock: POSIX clock_gettime']);
  out.push([1, 'M', '*', 'Running mode=standalone, port=6379.']);
  let at = 2;
  if (modules.length > 0) {
    // moduleLoadFromQueue: each module logs its own `<name> …` lines (module.c moduleLogRaw), then
    // "Module '%s' loaded from %s" with the name the module registers. Both come from the
    // modules' sources (RediSearch, RedisJSON, RedisTimeSeries, RedisBloom), which are not
    // captured: the lines are left out. Loading them takes time; 20 ms is a model choice.
    gaps.push({ what: `redis-server: module log lines (${modules.length} modules)`, detail: 'the bundled modules’ startup and shutdown lines are not grounded; left out' });
    at = 20;
  }
  out.push([at, 'M', loud, 'Server initialized']);
  out.push([at, 'M', '*', major === 6 ? 'Ready to accept connections' : 'Ready to accept connections tcp']);
  if (major === 8) {
    // warnAboutInsecureConfig (8.x): the default user has no password, the images patch
    // protected-mode to no (its default in the binaries' static configs), and bind is "* -::*".
    out.push([at, 'M', '#', 'WARNING: Redis does not require authentication and is not protected by network restrictions. Redis will accept connections from any IP address on any network interface.']);
  }
  const output = out.map(([after, role, mark, msg]) => line('stdout', logLine(t + after, role, mark, msg), after));
  const state: RedisState = { phase: 'running', major, startedAt: t };
  const step: ModelStep = { output, listen: [{ port: 6379, protocol: 'tcp' }], next: { wait: true, state: state as unknown as Json } };
  return gaps.length ? { ...step, gaps } : step;
}

/**
 * The shutdown serverCron runs once shutdown_asap is set (prepareForShutdown, finishShutdown):
 * "User requested shutdown..." (WARNING in 6.2), the final RDB save, since the default save
 * points (3600 1 300 100 60 10000) are set whatever the dataset ("Saving the final RDB snapshot
 * before exiting.", rdb.c "DB saved on disk"), no pid file to remove (no daemonize, no pidfile),
 * then "%s is now ready to exit, bye bye..." with "Redis" and exit(0). No replicas, so no wait.
 */
function shutdownLines(major: Major, t: Millis): Output[] {
  const msgs: [Millis, '*' | '#', string][] = [
    [0, major === 6 ? '#' : '*', 'User requested shutdown...'],
    [0, '*', 'Saving the final RDB snapshot before exiting.'],
    [1, '*', 'DB saved on disk'],
    [1, '#', 'Redis is now ready to exit, bye bye...'],
  ];
  return msgs.map(([d, mark, msg]) => line('stdout', logLine(t + d, 'M', mark, msg), d));
}

/**
 * sigShutdownHandler (server.c): SIGTERM and SIGINT log from the handler and set shutdown_asap; a
 * second SIGINT before the shutdown ran is "You insist... exiting now." and exit(1).
 * shutdown-on-sigterm and shutdown-on-sigint default to "default", so both shut down the same way.
 */
function serverSignal(p: ProcessInput, state: Json, sig: Signal): ModelStep | 'default' {
  const st = state as unknown as RedisState | null;
  if (st === null) return 'default';
  if (sig !== 'SIGTERM' && sig !== 'SIGINT') return 'default';
  const t = p.now;
  if (st.phase === 'stopping') {
    if (sig === 'SIGINT') return { output: [line('stdout', handlerLine(t, 'You insist... exiting now.'))], next: { exit: 1 } };
    return { output: [line('stdout', handlerLine(t, 'Received SIGTERM scheduling shutdown...'))], next: { wake: until(st.stopAt ?? t, t), state } };
  }
  const stopAt = nextCron(st.startedAt, t);
  const next: RedisState = { ...st, phase: 'stopping', stopAt };
  return { output: [line('stdout', handlerLine(t, `Received ${sig} scheduling shutdown...`))], next: { wake: stopAt - t, state: next as unknown as Json } };
}

function serverResume(p: ProcessInput, state: Json): ModelStep {
  const st = state as unknown as RedisState | null;
  if (st?.phase !== 'stopping') return { next: { wait: true, state } };
  const output = shutdownLines(st.major, p.now);
  return { output, listen: [], next: { exit: 0, after: 1 } };
}

export const redisServerModel: ProgramModel = {
  name: 'redis-server',
  start: serverStart,
  resume: serverResume,
  signal: serverSignal,
};
