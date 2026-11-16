// The kubelet's pure pieces: back-off arithmetic and Go durations, the container process (argv and
// environment) and the Pod phase.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { IMAGE_CATALOG } from '../runtime/images/catalog.data.ts';
import { CRASHLOOP_BACKOFF, current, goDuration, inBackoffSince, next, type BackoffTable } from './backoff.ts';
import { containerProcess, expand, serviceEnv } from './env.ts';
import { podPhase } from './status.ts';

describe('Go time.Duration.String() of whole milliseconds', () => {
  test.each([
    [0, '0s'],
    [523, '523ms'],
    [1000, '1s'],
    [1234, '1.234s'],
    [1500, '1.5s'],
    [10_000, '10s'],
    [80_000, '1m20s'],
    [160_000, '2m40s'],
    [300_000, '5m0s'],
    [123_456, '2m3.456s'],
    [3_600_000, '1h0m0s'],
  ])('%d ms is %s', (ms, s) => expect(goDuration(ms)).toBe(s));
});

describe('flowcontrol.Backoff as the crash-loop back-off', () => {
  test('doubles from 10 s to 5 m, and an entry idle for 10 m starts over', () => {
    let t: BackoffTable = {};
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      t = next(t, 'k', i * 1000, i * 1000, CRASHLOOP_BACKOFF);
      seen.push(current(t, 'k'));
    }
    expect(seen).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(inBackoffSince(t, 'k', 7000, 7000 + 299_999, CRASHLOOP_BACKOFF)).toBe(true);
    expect(inBackoffSince(t, 'k', 7000, 7000 + 300_000, CRASHLOOP_BACKOFF)).toBe(false);
    t = next(t, 'k', 6000 + 600_001, 6000 + 600_001, CRASHLOOP_BACKOFF);
    expect(current(t, 'k')).toBe(10_000);
  });
});

describe('the container process', () => {
  const nginx = IMAGE_CATALOG.find((i) => i.repository === 'docker.io/library/nginx' && i.tags.includes('latest'));
  if (!nginx) throw new Error('nginx:latest not captured');
  const pod = (container: JsonObject, spec: JsonObject = {}): ApiObject => ({ metadata: { name: 'web', namespace: 'shop' }, spec: { containers: [container], ...spec } }) as ApiObject;
  const kubernetesSvc = { metadata: { name: 'kubernetes', namespace: 'default' }, spec: { clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, protocol: 'TCP' }] } } as ApiObject;
  const shopSvc = { metadata: { name: 'db-main', namespace: 'shop' }, spec: { clusterIP: '10.96.5.5', ports: [{ port: 5432 }] } } as ApiObject;

  test('command replaces Entrypoint and drops Cmd; args alone replace Cmd', () => {
    expect(containerProcess(pod({ name: 'c' }), { name: 'c' }, nginx, [], 'web').argv).toEqual(['/docker-entrypoint.sh', 'nginx', '-g', 'daemon off;']);
    expect(containerProcess(pod({}), { name: 'c', command: ['sleep'] }, nginx, [], 'web').argv).toEqual(['sleep']);
    expect(containerProcess(pod({}), { name: 'c', args: ['nginx-debug'] }, nginx, [], 'web').argv).toEqual(['/docker-entrypoint.sh', 'nginx-debug']);
  });

  test('PATH, HOSTNAME, the image, the Pod, the services, then HOME; the last duplicate wins', () => {
    const p = containerProcess(pod({}), { name: 'c', env: [{ name: 'NGINX_VERSION', value: 'mine' }, { name: 'GREETING', value: 'hi $(DB_MAIN_SERVICE_HOST) $$(X) $(NOPE)' }] }, nginx, [kubernetesSvc, shopSvc], 'web');
    const names = p.env.map(([k]) => k);
    expect(names.slice(0, 2)).toEqual(['PATH', 'HOSTNAME']);
    expect(p.env.find(([k]) => k === 'HOSTNAME')?.[1]).toBe('web');
    expect(names.filter((k) => k === 'NGINX_VERSION')).toHaveLength(1);
    expect(p.env.find(([k]) => k === 'NGINX_VERSION')?.[1]).toBe('mine');
    expect(names.indexOf('NGINX_VERSION')).toBeGreaterThan(names.indexOf('NJS_VERSION'));
    expect(p.env.find(([k]) => k === 'GREETING')?.[1]).toBe('hi 10.96.5.5 $(X) $(NOPE)');
    expect(p.env.find(([k]) => k === 'KUBERNETES_SERVICE_HOST')?.[1]).toBe('10.96.0.1');
    expect(p.env.find(([k]) => k === 'KUBERNETES_PORT_443_TCP')?.[1]).toBe('tcp://10.96.0.1:443');
    expect(p.env[p.env.length - 1]).toEqual(['HOME', '/root']);
  });

  test('enableServiceLinks: false keeps only the kubernetes Service', () => {
    const env = serviceEnv([kubernetesSvc, shopSvc], 'shop', false);
    expect(Object.keys(env).some((k) => k.startsWith('DB_MAIN'))).toBe(false);
    expect(env.KUBERNETES_SERVICE_PORT_HTTPS).toBe('443');
  });

  test('$(VAR) expansion', () => {
    const look = (n: string) => ({ A: '1' })[n];
    expect(expand('$(A)-$$(A)-$(B)-$(', look)).toBe('1-$(A)-$(B)-$(');
  });
});

describe('getPhase', () => {
  const p = (restartPolicy: string): ApiObject => ({ spec: { restartPolicy, containers: [{ name: 'a' }, { name: 'b' }] } }) as ApiObject;
  const term = (code: number): JsonObject => ({ terminated: { exitCode: code } });
  const s = (name: string, state: JsonObject, lastState: JsonObject = {}): JsonObject => ({ name, state, lastState });

  test.each([
    ['Always', [s('a', { running: {} }), s('b', { waiting: { reason: 'ContainerCreating' } })], 'Pending'],
    ['Always', [s('a', { running: {} }), s('b', { running: {} })], 'Running'],
    ['Always', [s('a', { waiting: { reason: 'CrashLoopBackOff' } }, term(1)), s('b', { running: {} })], 'Running'],
    ['Never', [s('a', term(0)), s('b', term(0))], 'Succeeded'],
    ['Never', [s('a', term(0)), s('b', term(2))], 'Failed'],
    ['OnFailure', [s('a', term(0)), s('b', term(2))], 'Running'],
    ['OnFailure', [s('a', term(0)), s('b', term(0))], 'Succeeded'],
  ])('%s %j → %s', (policy, statuses, phase) => {
    expect(podPhase(p(policy), statuses, false)).toBe(phase);
  });
});
