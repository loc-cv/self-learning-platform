import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import type { ModelStep } from '../types.ts';
import { nginxEntrypointModel } from './nginx-entrypoint.ts';
import { nginxModel } from './nginx.ts';
import { T0, lines, processInput, type FakeImage } from './testing.ts';

const DEBIAN: FakeImage = {
  files: {
    '/docker-entrypoint.sh': { model: 'nginx-entrypoint', variant: 'script' },
    '/bin/sh': { model: 'sh', variant: 'dash' },
    '/usr/sbin/nginx': { model: 'nginx', variant: 'nginx' },
    '/usr/bin/sleep': { model: 'sleep', variant: 'gnu' },
  },
};
const ALPINE: FakeImage = {
  files: { ...DEBIAN.files, '/bin/sh': { model: 'sh', variant: 'busybox' } },
};
/** nginx:1.14.2: no entrypoint, its nginx.conf logs at `warn`. */
const OLD: FakeImage = { files: { '/bin/sh': { model: 'sh', variant: 'dash' }, '/usr/sbin/nginx': { model: 'nginx', variant: 'nginx' } } };

const ENV: [string, string][] = [
  ['PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  ['NGINX_VERSION', '1.31.8'],
  ['NJS_VERSION', '1.0.2'],
];
const CMD = ['nginx', '-g', 'daemon off;'];

function state(step: ModelStep): Json {
  const n = step.next;
  if (!('state' in n)) throw new Error('no state');
  return n.state;
}

describe('nginx-entrypoint', () => {
  test('default command: configuration lines on stdout, then exec nginx', () => {
    const p = processInput(DEBIAN, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', ...CMD], ENV);
    const step = nginxEntrypointModel.start(p);
    expect(lines(step)).toEqual([
      'O +0 /docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration',
      'O +2 /docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/',
      'O +4 /docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh',
      'O +6 10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf',
      'O +8 10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf',
      'O +10 /docker-entrypoint.sh: Sourcing /docker-entrypoint.d/15-local-resolvers.envsh',
      'O +12 /docker-entrypoint.sh: Launching /docker-entrypoint.d/20-envsubst-on-templates.sh',
      'O +14 /docker-entrypoint.sh: Launching /docker-entrypoint.d/30-tune-worker-processes.sh',
      'O +16 /docker-entrypoint.sh: Configuration complete; ready for start up',
    ]);
    expect(step.next).toEqual({ exec: { exe: { path: '/usr/sbin/nginx', model: 'nginx', variant: 'nginx' }, argv: CMD }, after: 18 });
    expect(step.gaps).toBeUndefined();
  });

  test('NGINX_ENTRYPOINT_QUIET_LOGS silences it; an empty value does not', () => {
    const quiet = nginxEntrypointModel.start(processInput(DEBIAN, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', ...CMD], [...ENV, ['NGINX_ENTRYPOINT_QUIET_LOGS', '1']]));
    expect(quiet.output).toBeUndefined();
    expect('exec' in quiet.next).toBe(true);
    const empty = nginxEntrypointModel.start(processInput(DEBIAN, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', ...CMD], [...ENV, ['NGINX_ENTRYPOINT_QUIET_LOGS', '']]));
    expect(lines(empty)).toHaveLength(9);
  });

  test('another command is exec’d without configuration', () => {
    const step = nginxEntrypointModel.start(processInput(DEBIAN, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', 'sleep', '10'], ENV));
    expect(step.output).toBeUndefined();
    expect(step.next).toEqual({ exec: { exe: { path: '/usr/bin/sleep', model: 'sleep', variant: 'gnu' }, argv: ['sleep', '10'] } });
  });

  test('a missing command fails as the shell’s exec does: dash and ash texts, status 127', () => {
    const dash = nginxEntrypointModel.start(processInput(DEBIAN, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', 'nope'], ENV));
    expect(lines(dash)).toEqual(['E +0 /docker-entrypoint.sh: 47: exec: nope: not found']);
    expect(dash.next).toEqual({ exit: 127 });
    const ash = nginxEntrypointModel.start(processInput(ALPINE, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', 'nope'], ENV));
    expect(lines(ash)).toEqual(['E +0 /docker-entrypoint.sh: exec: line 47: nope: not found']);
  });

  test('environment that takes a branch the model cannot follow is a gap', () => {
    const step = nginxEntrypointModel.start(processInput(DEBIAN, '/docker-entrypoint.sh', ['/docker-entrypoint.sh', ...CMD], [...ENV, ['NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE', '1']]));
    expect(step.gaps?.map((g) => g.what)).toEqual(['nginx entrypoint: NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE']);
  });
});

describe('nginx', () => {
  const start = (img = DEBIAN, argv = CMD, env = ENV): ModelStep => nginxModel.start(processInput(img, '/usr/sbin/nginx', argv, env));

  test('startup notices of 1.31.8 on Debian, workers after the entrypoint’s processes', () => {
    const step = start();
    expect(lines(step)).toEqual([
      'E +0 2026/11/16 05:47:37 [notice] 1#1: using the "epoll" event method',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: nginx/1.31.8',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: built by gcc 14.2.0 (Debian 14.2.0-19) ',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: OS: Linux 6.8.0-88-generic',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: getrlimit(RLIMIT_NOFILE): 1048576:1048576',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: start worker processes',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: start worker process 24',
      'E +0 2026/11/16 05:47:37 [notice] 1#1: start worker process 25',
    ]);
    expect(step.listen).toEqual([{ port: 80, protocol: 'tcp' }]);
    expect('wait' in step.next).toBe(true);
    expect(step.gaps).toBeUndefined();
  });

  test('Alpine: its own compiler and pids', () => {
    const out = lines(start(ALPINE));
    expect(out[2]).toBe('E +0 2026/11/16 05:47:37 [notice] 1#1: built by gcc 15.2.0 (Alpine 15.2.0) ');
    expect(out.slice(-2)).toEqual(['E +0 2026/11/16 05:47:37 [notice] 1#1: start worker process 25', 'E +0 2026/11/16 05:47:37 [notice] 1#1: start worker process 26']);
  });

  test('a version whose build was not captured leaves out "built by" and says so', () => {
    const step = start(DEBIAN, CMD, [['NGINX_VERSION', '1.27.5']]);
    expect(lines(step)[1]).toBe('E +0 2026/11/16 05:47:37 [notice] 1#1: nginx/1.27.5');
    expect(lines(step).some((l) => l.includes('built by'))).toBe(false);
    expect(step.gaps?.[0]?.what).toBe('nginx 1.27.5 (debian): build compiler not captured');
  });

  test('SIGQUIT: graceful shutdown, exit 0', () => {
    const s0 = start();
    const p = processInput(DEBIAN, '/usr/sbin/nginx', CMD, ENV, { now: T0 + 60_000 });
    const step = nginxModel.signal?.(p, state(s0), 'SIGQUIT');
    if (step === undefined || step === 'default') throw new Error('handled');
    expect(lines(step)).toEqual([
      'E +0 2026/11/16 05:48:37 [notice] 1#1: signal 3 (SIGQUIT) received, shutting down',
      'E +1 2026/11/16 05:48:37 [notice] 24#24: gracefully shutting down',
      'E +1 2026/11/16 05:48:37 [notice] 24#24: exiting',
      'E +1 2026/11/16 05:48:37 [notice] 24#24: exit',
      'E +1 2026/11/16 05:48:37 [notice] 25#25: gracefully shutting down',
      'E +1 2026/11/16 05:48:37 [notice] 25#25: exiting',
      'E +1 2026/11/16 05:48:37 [notice] 25#25: exit',
      'E +2 2026/11/16 05:48:37 [notice] 1#1: signal 17 (SIGCHLD) received from 24',
      'E +2 2026/11/16 05:48:37 [notice] 1#1: worker process 24 exited with code 0',
      'E +2 2026/11/16 05:48:37 [notice] 1#1: signal 29 (SIGIO) received',
      'E +3 2026/11/16 05:48:37 [notice] 1#1: signal 17 (SIGCHLD) received from 25',
      'E +3 2026/11/16 05:48:37 [notice] 1#1: worker process 25 exited with code 0',
      'E +4 2026/11/16 05:48:37 [notice] 1#1: exit',
    ]);
    expect(step.next).toMatchObject({ wake: 4 });
    // A second signal while exiting changes nothing.
    const again = nginxModel.signal?.(processInput(DEBIAN, '/usr/sbin/nginx', CMD, ENV, { now: T0 + 60_001 }), state(step), 'SIGTERM');
    expect(again).toMatchObject({ next: { wake: 3 } });
    expect(nginxModel.resume(p, state(step))).toEqual({ next: { exit: 0 } });
  });

  test('SIGTERM: fast shutdown', () => {
    const step = nginxModel.signal?.(processInput(DEBIAN, '/usr/sbin/nginx', CMD, ENV), state(start()), 'SIGTERM');
    if (step === undefined || step === 'default') throw new Error('handled');
    const out = lines(step);
    expect(out[0]).toBe('E +0 2026/11/16 05:47:37 [notice] 1#1: signal 15 (SIGTERM) received, exiting');
    expect(out.slice(1, 3)).toEqual(['E +1 2026/11/16 05:47:37 [notice] 24#24: exiting', 'E +1 2026/11/16 05:47:37 [notice] 24#24: exit']);
    expect(out.at(-1)).toBe('E +4 2026/11/16 05:47:37 [notice] 1#1: exit');
  });

  test('nginx:1.14.2 logs at warn: silent start and stop', () => {
    const env: [string, string][] = [['NGINX_VERSION', '1.14.2-1~stretch']];
    const s0 = start(OLD, CMD, env);
    expect(s0.output).toBeUndefined();
    expect(s0.gaps).toBeUndefined();
    const step = nginxModel.signal?.(processInput(OLD, '/usr/sbin/nginx', CMD, env), state(s0), 'SIGTERM');
    expect(step).toMatchObject({ next: { wake: 3 } });
    expect((step as ModelStep).output).toBeUndefined();
  });

  test('-v, -t, -q and invalid options', () => {
    expect(lines(start(DEBIAN, ['nginx', '-v']))).toEqual(['E +0 nginx version: nginx/1.31.8']);
    expect(lines(start(DEBIAN, ['nginx', '-t']))).toEqual([
      'E +0 nginx: the configuration file /etc/nginx/nginx.conf syntax is ok',
      'E +0 nginx: configuration file /etc/nginx/nginx.conf test is successful',
    ]);
    expect(start(DEBIAN, ['nginx', '-tq']).output).toBeUndefined();
    const bad = start(DEBIAN, ['nginx', '-x']);
    expect(lines(bad)).toEqual(['E +0 nginx: invalid option: "x"']);
    expect(bad.next).toEqual({ exit: 1 });
    expect(start(DEBIAN, ['nginx', '-V'])).toMatchObject({ next: { exit: 0 }, gaps: [{ what: 'nginx -V' }] });
  });

  test('without daemon off the master daemonizes and PID 1 exits 0', () => {
    const step = start(DEBIAN, ['nginx']);
    expect(lines(step).at(-1)).toBe('E +0 2026/11/16 05:47:37 [notice] 1#1: getrlimit(RLIMIT_NOFILE): 1048576:1048576');
    expect(step.next).toEqual({ exit: 0, after: 1 });
  });
});
