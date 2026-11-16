import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import type { ModelStep } from '../types.ts';
import { redisEntrypointModel, redisServerModel } from './redis.ts';
import { T0, lines, processInput, type FakeImage } from './testing.ts';

const IMG: FakeImage = {
  files: {
    '/usr/local/bin/docker-entrypoint.sh': { model: 'redis-entrypoint', variant: 'script' },
    '/usr/local/bin/redis-server': { model: 'redis-server', variant: 'redis-server' },
    '/usr/local/bin/redis-cli': { model: 'unmodeled', variant: 'redis-cli' },
    '/bin/sh': { model: 'sh', variant: 'dash' },
    '/bin/bash': { model: 'sh', variant: 'bash' },
  },
};
const env = (v: string): [string, string][] => [
  ['PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  ['REDIS_VERSION', v],
];
const MODULE_ARGS = ['--loadmodule', '/usr/local/lib/redis/modules//redisbloom.so', '--loadmodule', '/usr/local/lib/redis/modules//redisearch.so', '--loadmodule', '/usr/local/lib/redis/modules//redistimeseries.so', '--loadmodule', '/usr/local/lib/redis/modules//rejson.so'];
const SERVER = { path: '/usr/local/bin/redis-server', model: 'redis-server', variant: 'redis-server' };

function state(step: ModelStep): Json {
  const n = step.next;
  if (!('state' in n)) throw new Error('no state');
  return n.state;
}

describe('redis entrypoint', () => {
  test('redis 8: "Starting Redis Server", then redis-server with the bundled modules', () => {
    const step = redisEntrypointModel.start(processInput(IMG, '/usr/local/bin/docker-entrypoint.sh', ['docker-entrypoint.sh', 'redis-server'], env('8.10.3')));
    expect(lines(step)).toEqual(['O +0 Starting Redis Server']);
    expect(step.next).toEqual({ exec: { exe: SERVER, argv: ['redis-server', ...MODULE_ARGS] }, after: 5 });
  });

  test('redis 7: silent, plain redis-server; options get redis-server prepended', () => {
    const step = redisEntrypointModel.start(processInput(IMG, '/usr/local/bin/docker-entrypoint.sh', ['docker-entrypoint.sh', 'redis-server'], env('7.4.12')));
    expect(step.output).toBeUndefined();
    expect(step.next).toEqual({ exec: { exe: SERVER, argv: ['redis-server'] }, after: 5 });
    const opt = redisEntrypointModel.start(processInput(IMG, '/usr/local/bin/docker-entrypoint.sh', ['docker-entrypoint.sh', '--port', '6380'], env('7.4.12')));
    expect(opt.next).toMatchObject({ exec: { argv: ['redis-server', '--port', '6380'] } });
  });

  test('another program is exec’d as is; a missing one fails with bash’s exec error', () => {
    const cli = redisEntrypointModel.start(processInput(IMG, '/usr/local/bin/docker-entrypoint.sh', ['docker-entrypoint.sh', 'redis-cli'], env('8.10.3')));
    expect(cli.output).toBeUndefined();
    expect(cli.next).toMatchObject({ exec: { argv: ['redis-cli'] } });
    const missing = redisEntrypointModel.start(processInput(IMG, '/usr/local/bin/docker-entrypoint.sh', ['docker-entrypoint.sh', 'nope'], env('8.10.3')));
    expect(lines(missing)).toEqual(['E +0 /usr/local/bin/docker-entrypoint.sh: line 184: exec: nope: not found']);
    expect(missing.next).toEqual({ exit: 127 });
  });
});

describe('redis-server', () => {
  const start = (v: string, argv = ['redis-server']): ModelStep => redisServerModel.start(processInput(IMG, '/usr/local/bin/redis-server', argv, env(v)));

  test('7.4.12 with no arguments', () => {
    const step = start('7.4.12');
    expect(lines(step)).toEqual([
      'O +0 1:C 16 Nov 2026 05:47:37.250 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo',
      'O +0 1:C 16 Nov 2026 05:47:37.250 * Redis version=7.4.12, bits=64, commit=00000000, modified=0, pid=1, just started',
      'O +0 1:C 16 Nov 2026 05:47:37.250 # Warning: no config file specified, using the default config. In order to specify a config file use redis-server /path/to/redis.conf',
      'O +1 1:M 16 Nov 2026 05:47:37.251 * monotonic clock: POSIX clock_gettime',
      'O +1 1:M 16 Nov 2026 05:47:37.251 * Running mode=standalone, port=6379.',
      'O +2 1:M 16 Nov 2026 05:47:37.252 * Server initialized',
      'O +2 1:M 16 Nov 2026 05:47:37.252 * Ready to accept connections tcp',
    ]);
    expect(step.listen).toEqual([{ port: 6379, protocol: 'tcp' }]);
    expect(step.gaps).toBeUndefined();
  });

  test('6.2.24: WARNING levels and the untyped ready line', () => {
    const out = lines(start('6.2.24'));
    expect(out[0]).toBe('O +0 1:C 16 Nov 2026 05:47:37.250 # oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo');
    expect(out.slice(-2)).toEqual(['O +2 1:M 16 Nov 2026 05:47:37.252 # Server initialized', 'O +2 1:M 16 Nov 2026 05:47:37.252 * Ready to accept connections']);
  });

  test('8.10.3 as the entrypoint runs it: modules (lines left out, a gap) and the insecure-config warning', () => {
    const step = start('8.10.3', ['redis-server', ...MODULE_ARGS]);
    const out = lines(step);
    expect(out[1]).toBe('O +0 1:C 16 Nov 2026 05:47:37.250 * Redis version=8.10.3, bits=64, commit=00000000, modified=1, pid=1, just started');
    expect(out[2]).toBe('O +0 1:C 16 Nov 2026 05:47:37.250 * Configuration loaded');
    expect(out.slice(-3)).toEqual([
      'O +20 1:M 16 Nov 2026 05:47:37.270 * Server initialized',
      'O +20 1:M 16 Nov 2026 05:47:37.270 * Ready to accept connections tcp',
      'O +20 1:M 16 Nov 2026 05:47:37.270 # WARNING: Redis does not require authentication and is not protected by network restrictions. Redis will accept connections from any IP address on any network interface.',
    ]);
    expect(step.gaps?.[0]?.what).toBe('redis-server: module log lines (4 modules)');
  });

  test('SIGTERM: the handler line now, the shutdown at the next serverCron tick, exit 0', () => {
    const s0 = start('7.4.12');
    const p1 = processInput(IMG, '/usr/local/bin/redis-server', ['redis-server'], env('7.4.12'), { now: T0 + 10_030 });
    const s1 = redisServerModel.signal?.(p1, state(s0), 'SIGTERM') as ModelStep;
    expect(lines(s1)).toEqual([`O +0 1:signal-handler (${Math.floor((T0 + 10_030) / 1000)}) Received SIGTERM scheduling shutdown...`]);
    expect(s1.next).toMatchObject({ wake: 70 });
    const p2 = processInput(IMG, '/usr/local/bin/redis-server', ['redis-server'], env('7.4.12'), { now: T0 + 10_100 });
    const s2 = redisServerModel.resume(p2, state(s1));
    expect(lines(s2)).toEqual([
      'O +0 1:M 16 Nov 2026 05:47:47.350 * User requested shutdown...',
      'O +0 1:M 16 Nov 2026 05:47:47.350 * Saving the final RDB snapshot before exiting.',
      'O +1 1:M 16 Nov 2026 05:47:47.351 * DB saved on disk',
      'O +1 1:M 16 Nov 2026 05:47:47.351 # Redis is now ready to exit, bye bye...',
    ]);
    expect(s2.next).toEqual({ exit: 0, after: 1 });
  });

  test('a second SIGINT before the shutdown ran: "You insist", exit 1', () => {
    const p = processInput(IMG, '/usr/local/bin/redis-server', ['redis-server'], env('7.4.12'));
    const s1 = redisServerModel.signal?.(p, state(start('7.4.12')), 'SIGINT') as ModelStep;
    const s2 = redisServerModel.signal?.(p, state(s1), 'SIGINT') as ModelStep;
    expect(lines(s2)).toEqual([`O +0 1:signal-handler (${Math.floor(T0 / 1000)}) You insist... exiting now.`]);
    expect(s2.next).toEqual({ exit: 1 });
  });

  test('configuration it cannot follow is a gap', () => {
    expect(start('7.4.12', ['redis-server', '--port', '6380'])).toMatchObject({ next: { wait: true }, gaps: [{ what: 'redis-server --port 6380' }] });
    expect(start('5.0.14')).toMatchObject({ gaps: [{ what: 'redis-server 5.0.14' }] });
  });
});
