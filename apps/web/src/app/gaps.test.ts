import { expect, test, vi } from 'vitest';
import type { GapEvent } from '@simlab/kernel';
import { createGapSink, type SinkState } from './gaps.ts';

const gap: GapEvent = { v: 1, kind: 'flag', program: 'kubectl', what: '--raw', commandLine: 'kubectl get --raw /', key: 'flag:kubectl:--raw', context: { machine: 'controlplane', seed: 3, virtualTime: 5 } };

test('new notices are posted with the item and the engine versions; replayed ones are not', async () => {
  vi.useFakeTimers();
  const bodies: string[] = [];
  const states: SinkState[] = [];
  const sink = createGapSink(async (b) => (bodies.push(b), { ok: true }), (s) => states.push(s));
  const engine = { version: '0.10.0', kubernetes: 'v1.37.2' };
  sink.add({ gap, item: 'lab-1', seenAt: 0, replayed: true }, engine);
  sink.add({ gap, item: 'lab-1', seenAt: 0, replayed: false }, engine);
  sink.add({ gap: { ...gap, what: '--v' }, item: 'lab-1', seenAt: 0, replayed: false }, engine);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  expect(bodies).toHaveLength(1);
  const posted = JSON.parse(bodies[0] as string) as { records: { what: string; context: { item: string }; engine: object }[] };
  expect(posted.records.map((r) => r.what)).toEqual(['--raw', '--v']);
  expect(posted.records[0]?.context.item).toBe('lab-1');
  expect(posted.records[0]?.engine).toEqual(engine);
  expect(states).toEqual(['ok']);
});

test('notices still queued when the page goes away leave by beacon', () => {
  const beacons: string[] = [];
  const sink = createGapSink(async () => ({ ok: true }), () => undefined, (b) => (beacons.push(b), true));
  sink.add({ gap, item: 'lab-1', seenAt: 0, replayed: false }, { version: '0', kubernetes: 'v1.37.2' });
  sink.flush(true);
  expect(beacons).toHaveLength(1);
  sink.flush(true);
  expect(beacons).toHaveLength(1);
});
