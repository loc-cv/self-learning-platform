import { describe, expect, test } from 'vitest';
import type { ViewEntity, ViewModel } from '@simlab/kernel';
import { assignSlots, emptyMemory, fit, layout, type Box, type Layout } from './layout.ts';

const e = (id: string, kind: string, container?: string, extra: Partial<ViewEntity> = {}): ViewEntity => ({ id, kind, label: id, state: 'healthy', facts: [], ...(container ? { container } : {}), ...extra });

function model(entities: ViewEntity[]): ViewModel {
  return {
    t: 0,
    kinds: [
      { kind: 'Machine', shape: 'host', label: 'Machine', plural: 'Machines' },
      { kind: 'Agent', shape: 'host', label: 'Agent', plural: 'Agents' },
      { kind: 'Group', shape: 'scope', label: 'Group', plural: 'Groups' },
      { kind: 'Job', shape: 'workload', label: 'Job', plural: 'Jobs' },
      { kind: 'Task', shape: 'process', label: 'Task', plural: 'Tasks', placedIn: 'Agent', unplaced: 'Tasks with no agent' },
    ],
    entities,
    relations: [],
  };
}

const run = (m: ViewModel, memory = emptyMemory(), width = 600, leaving?: Map<string, ViewEntity>): Layout => layout({ model: m, visible: () => true, width, ...(leaving ? { leaving } : {}) }, memory);
const box = (l: Layout, id: string): Box => {
  const b = l.boxes.find((x) => x.id === id);
  if (!b) throw new Error(`no box ${id}`);
  return b;
};
const inside = (a: Box, b: Box): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

const world = (tasks: string[], unplaced: string[] = []): ViewModel =>
  model([
    e('m1', 'Machine'),
    e('m2', 'Machine'),
    e('m3', 'Machine'),
    e('a1', 'Agent', 'm1'),
    e('a2', 'Agent', 'm2'),
    e('a3', 'Agent', 'm3'),
    e('g', 'Group'),
    e('job', 'Job', 'g'),
    ...tasks.map((t) => e(t, 'Task', 'a1')),
    ...unplaced.map((t) => e(t, 'Task')),
  ]);

describe('layout', () => {
  test('containers hold their children; scopes come first, then the unplaced lane, then the hosts side by side', () => {
    const l = run(world(['t1', 't2'], ['u1']));
    expect(inside(box(l, 'a1'), box(l, 'm1'))).toBe(true);
    expect(inside(box(l, 't1'), box(l, 'a1'))).toBe(true);
    expect(inside(box(l, 'job'), box(l, 'g'))).toBe(true);
    expect(l.lanes).toEqual([expect.objectContaining({ label: 'Tasks with no agent' })]);
    const lane = l.lanes[0] as Layout['lanes'][number];
    expect(box(l, 'u1').y).toBeGreaterThan(lane.y);
    expect(box(l, 'g').y).toBeLessThan(lane.y);
    expect(box(l, 'm1').y).toBeGreaterThan(lane.y + lane.h);
    // Three hosts fit one row of 600 px.
    expect(new Set(['m1', 'm2', 'm3'].map((id) => box(l, id).y)).size).toBe(1);
    expect(box(l, 'm1').x).toBeLessThan(box(l, 'm2').x);
  });

  test('a narrow width wraps hosts to more rows', () => {
    const l = run(world([]), emptyMemory(), 320);
    expect(box(l, 'm2').y).toBeGreaterThan(box(l, 'm1').y);
  });

  test('an entity keeps its place while others come and go', () => {
    const memory = emptyMemory();
    const before = run(world(['t1', 't2', 't3']), memory);
    const t3 = box(before, 't3');
    // t2 leaves: t3 does not move up; a newcomer takes the free slot.
    const after = run(world(['t1', 't3']), memory);
    expect(box(after, 't3')).toMatchObject({ x: t3.x, y: t3.y });
    const next = run(world(['t1', 't3', 't0']), memory);
    expect(box(next, 't0')).toMatchObject({ x: box(before, 't2').x, y: box(before, 't2').y });
    expect(box(next, 't3')).toMatchObject({ x: t3.x, y: t3.y });
  });

  test('a leaving entity keeps its slot until it is gone', () => {
    const memory = emptyMemory();
    const before = run(world(['t1', 't2']), memory);
    const ghost = e('t2', 'Task', 'a1');
    const during = run(world(['t1', 'tn']), memory, 600, new Map([['t2', ghost]]));
    expect(box(during, 't2')).toMatchObject({ leaving: true, x: box(before, 't2').x, y: box(before, 't2').y });
    expect(box(during, 'tn').y).toBeGreaterThan(box(before, 't2').y);
  });

  test('the same input lays out the same way', () => {
    expect(run(world(['t1', 't2'], ['u']))).toEqual(run(world(['t1', 't2'], ['u'])));
  });
});

test('slots: kept, freed, refilled in order', () => {
  const m = emptyMemory();
  expect(assignSlots(m, 'k', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  expect(assignSlots(m, 'k', ['a', 'c'])).toEqual(['a', null, 'c']);
  expect(assignSlots(m, 'k', ['d', 'a', 'c', 'e'])).toEqual(['a', 'd', 'c', 'e']);
});

test('names keep their start and their end', () => {
  expect(fit('web-5d7f9c8b6d-x2x9k', 12)).toBe('web-5d…x2x9k');
  expect(fit('short', 12)).toBe('short');
});
