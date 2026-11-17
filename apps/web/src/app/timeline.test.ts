import { describe, expect, it } from 'vitest';
import type { ViewEvent } from '@simlab/kernel';
import { cluster, createLatest, nextSpeed, formatJump, formatOffset, hit, itemAt, laneOf, mergeEvents, scaleOf, stepTime, ticks, timelineItems, tOf, xOf, type TraceState } from './timeline.ts';

const ev = (id: number, t: number, extra: Partial<ViewEvent> = {}): ViewEvent => ({ id, t, actor: 'a', text: `event ${id}`, about: [], level: 'key', tone: 'neutral', causes: [], ...extra });

describe('mergeEvents', () => {
  it('appends new events, replaces one whose id it has, keeps id order', () => {
    const a = mergeEvents([], [ev(2, 10), ev(1, 5)], true);
    expect(a.map((e) => e.id)).toEqual([1, 2]);
    const b = mergeEvents(a, [ev(3, 20)], false);
    expect(b.map((e) => e.id)).toEqual([1, 2, 3]);
    const c = mergeEvents(b, [ev(2, 10, { until: 15 })], false);
    expect(c.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(c[1]?.until).toBe(15);
  });

  it('reset replaces everything; nothing new keeps the same array', () => {
    const a = mergeEvents([], [ev(1, 5)], true);
    expect(mergeEvents(a, [], false)).toBe(a);
    expect(mergeEvents(a, [ev(9, 1)], true).map((e) => e.id)).toEqual([9]);
  });
});

describe('offsets and jumps', () => {
  it('formats offsets from the start, and moments before it', () => {
    expect(formatOffset(0)).toBe('+0:00');
    expect(formatOffset(47_900)).toBe('+0:47');
    expect(formatOffset(725_000)).toBe('+12:05');
    expect(formatOffset(3_723_000)).toBe('+1:02:03');
    expect(formatOffset(-12_000)).toBe('−0:12');
  });

  it('formats a skip', () => {
    expect(formatJump(400)).toBe('+0.4s');
    expect(formatJump(47_000)).toBe('+47s');
    expect(formatJump(125_000)).toBe('+2m 05s');
    expect(formatJump(3_600_000)).toBe('+1h 00m');
  });
});

describe('scale and ticks', () => {
  it('maps time to x and back, clamped to the span', () => {
    const s = scaleOf(1000, 11_000, 220, 10);
    expect(xOf(s, 1000)).toBe(10);
    expect(xOf(s, 11_000)).toBe(210);
    expect(xOf(s, 6000)).toBe(110);
    expect(xOf(s, 50_000)).toBe(210);
    expect(tOf(s, 110)).toBe(6000);
    expect(tOf(s, -5)).toBe(1000);
  });

  it('never divides by a zero span', () => {
    const s = scaleOf(1000, 1000, 100, 0);
    expect(s.end - s.start).toBe(1000);
    expect(Number.isFinite(xOf(s, 1000))).toBe(true);
  });

  it('puts ticks at a round step', () => {
    const s = scaleOf(0, 600_000, 600, 0);
    const t = ticks(s, 90);
    expect(t.map((x) => x.label)).toEqual(['+2:00', '+4:00', '+6:00', '+8:00']);
    expect(t[0]?.x).toBe(120);
  });
});

describe('items, clusters, hits and steps', () => {
  const trace: TraceState = {
    start: 0,
    events: [ev(1, 1000, { input: true }), ev(2, 1500), ev(3, 1600, { level: 'detail' }), ev(4, 1700, { tone: 'bad' }), ev(5, 9000, { tone: 'good' })],
    marks: [{ t: 5000, action: 'check', passed: false }],
  };

  it('leaves detail events out unless asked, and orders by time', () => {
    expect(timelineItems(trace, false).map((i) => i.t)).toEqual([1000, 1500, 1700, 5000, 9000]);
    expect(timelineItems(trace, true)).toHaveLength(6);
    expect(timelineItems(trace, true).map(laneOf)).toEqual(['input', 'key', 'detail', 'key', 'input', 'key']);
  });

  it('clusters close marks per lane, at the newest one, with the worst tone', () => {
    const s = scaleOf(0, 10_000, 1000, 0);
    const c = cluster(timelineItems(trace, false), s, 30);
    const key = c.filter((x) => x.lane === 'key');
    expect(key.map((x) => x.items.length)).toEqual([2, 1]);
    expect(key[0]).toMatchObject({ x: 170, t0: 1500, t1: 1700, tone: 'bad' });
    expect(c.filter((x) => x.lane === 'input').map((x) => x.tone)).toEqual(['neutral', 'bad']);
  });

  it('hits the nearest cluster within the radius, in a lane when given', () => {
    const s = scaleOf(0, 10_000, 1000, 0);
    const c = cluster(timelineItems(trace, false), s, 30);
    expect(hit(c, 172)?.t1).toBe(1700);
    expect(hit(c, 104, 'input')?.t1).toBe(1000);
    expect(hit(c, 104, 'key')).toBeUndefined();
    expect(hit(c, 400)).toBeUndefined();
  });

  it('steps the playhead between distinct moments, back from now and forward to now', () => {
    const items = timelineItems(trace, false);
    expect(stepTime(items, undefined, -1)).toBe(9000);
    expect(stepTime(items, 9000, -1)).toBe(5000);
    expect(stepTime(items, 1000, -1)).toBe(1000);
    expect(stepTime(items, 1500, 1)).toBe(1700);
    expect(stepTime(items, 9000, 1)).toBeUndefined();
    expect(stepTime(items, undefined, 1)).toBeUndefined();
    expect(itemAt(items, 1650)?.t).toBe(1500);
    expect(itemAt(items, 500)).toBeUndefined();
  });
});

describe('createLatest', () => {
  it('keeps one request in flight and applies only the newest answer', async () => {
    const sent: number[] = [];
    const applied: number[] = [];
    const answers: ((v: number) => void)[] = [];
    const l = createLatest<number, number>(
      (v) => {
        sent.push(v);
        return new Promise((ok) => answers.push(ok));
      },
      (r) => applied.push(r),
    );
    l.push(1);
    l.push(2);
    l.push(3);
    expect(sent).toEqual([1]);
    answers[0]?.(10);
    await Promise.resolve();
    await Promise.resolve();
    // The answer to 1 is stale: 3 is asked for instead, and 2 never is.
    expect(applied).toEqual([]);
    expect(sent).toEqual([1, 3]);
    answers[1]?.(30);
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([30]);
  });

  it('drops a late answer after cancel', async () => {
    const applied: number[] = [];
    let answer: (v: number) => void = () => undefined;
    const l = createLatest<number, number>(
      () => new Promise((ok) => (answer = ok)),
      (r) => applied.push(r),
    );
    l.push(1);
    l.cancel();
    answer(10);
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([]);
  });
});

it('cycles the speeds', () => {
  expect(nextSpeed(1, [1, 2, 5, 10])).toBe(2);
  expect(nextSpeed(10, [1, 2, 5, 10])).toBe(1);
  expect(nextSpeed(3, [1, 2, 5, 10])).toBe(1);
});
