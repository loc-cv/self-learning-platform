// The kubelet's container log reader: which container a request means (validateContainerLogStatus,
// every branch), the tail start (findTailLineStartIndex), and ReadLogs over a CRI log file: partial
// lines, timestamps only at the start of a line, since, the byte limit, malformed lines skipped.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME } from '@simlab/kernel';
import { createFs, createMachine, hostPlugin } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { k8sPlugin } from '../plugin.ts';
import { containerForLogs, readContainerLog, tailStart, type LogStream } from './logs.ts';

const pod = (cs: JsonObject): JsonObject => ({ metadata: { name: 'web' }, status: { containerStatuses: [{ name: 'c', ...cs }] } });

describe('containerForLogs', () => {
  test.each([
    [{ state: { running: {} }, containerID: 'containerd://abc' }, false, { id: 'abc' }],
    [{ state: { waiting: { reason: 'ContainerCreating' } } }, false, { error: 'container "c" in pod "web" is waiting to start: ContainerCreating' }],
    [{ state: { waiting: { reason: 'ErrImagePull' } } }, false, { error: 'container "c" in pod "web" is waiting to start: image can\'t be pulled' }],
    [{ state: { waiting: { reason: 'ImagePullBackOff' } } }, false, { error: 'container "c" in pod "web" is waiting to start: trying and failing to pull image' }],
    [{ state: {} }, false, { error: 'container "c" in pod "web" is waiting to start - no logs yet' }],
    [{ state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { containerID: 'containerd://old' } } }, false, { id: 'old' }],
    [{ state: { terminated: { containerID: 'containerd://t' } } }, false, { id: 't' }],
    [{ state: { terminated: {} } }, false, { error: 'container "c" in pod "web" is terminated' }],
    [{ state: { terminated: {} }, lastState: { terminated: { containerID: 'containerd://old' } } }, false, { id: 'old' }],
    [{ state: { running: {} }, lastState: { terminated: { containerID: 'containerd://old' } } }, true, { id: 'old' }],
    [{ state: { running: {} }, lastState: {} }, true, { error: 'previous terminated container "c" in pod "web" not found' }],
  ])('%j previous=%s', (cs, previous, want) => {
    expect(containerForLogs(pod(cs as JsonObject), 'c', previous)).toEqual(want);
  });

  test('a container with no status yet', () => {
    expect(containerForLogs({ metadata: { name: 'web' }, status: {} }, 'c', false)).toEqual({ error: 'container "c" in pod "web" is not available' });
  });
});

test('tailStart counts complete lines from the end', () => {
  expect(tailStart('a\nb\nc\n', 2)).toBe(2);
  expect(tailStart('a\nb\nc\n', 0)).toBe(6);
  expect(tailStart('a\nb\nc\n', 9)).toBe(0);
  expect(tailStart('a\nb\nc', 1)).toBe(2);
  expect(tailStart('a\nb\n', undefined)).toBe(0);
});

describe('readContainerLog', () => {
  const registry = createRegistry([hostPlugin, k8sPlugin]);
  const text = [
    '2026-11-13T09:00:01.5Z stdout F one',
    '2026-11-13T09:00:02.000000001Z stderr P par',
    '2026-11-13T09:00:02.1Z stderr F tial',
    'not a log line',
    '2026-11-13T09:00:03Z stdout F three',
    '',
  ].join('\n');
  function read(s: Partial<LogStream>): string {
    const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
    return k.act('t', (ctx) => {
      createMachine(ctx, { id: 'n', hostname: 'n', kind: 'node' });
      createFs(ctx, 'n', { cred: { uid: 0, gid: 0, groups: [] }, umask: 0o022 }).writeFile('/log', text);
      const base: LogStream = { node: 'n', containerId: 'x', path: '/log', offset: 0, follow: false, timestamps: false, newLine: true, done: false };
      const r = readContainerLog(ctx, { ...base, ...s });
      expect(r.stream.done).toBe(true);
      return r.data;
    });
  }
  test('partial lines join; malformed lines are skipped', () => {
    expect(read({})).toBe('one\npartial\nthree\n');
  });
  test('timestamps only where a line starts, nine digits', () => {
    expect(read({ timestamps: true })).toBe('2026-11-13T09:00:01.500000000Z one\n2026-11-13T09:00:02.000000001Z partial\n2026-11-13T09:00:03.000000000Z three\n');
  });
  test('since skips older lines, with nanoseconds', () => {
    expect(read({ since: [DEFAULT_START_TIME + 2000, 1] })).toBe('partial\nthree\n');
  });
  test('the byte limit cuts the line it reaches', () => {
    expect(read({ remain: 6 })).toBe('one\npa');
  });
  test('a tail without follow stops after its lines', () => {
    expect(read({ offset: tailStart(text, 2), lines: 2 })).toBe('three\n');
  });
});
