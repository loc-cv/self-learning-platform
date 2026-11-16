import { describe, expect, test } from 'vitest';
import type { ViewEntity, ViewModel } from '@simlab/kernel';
import { assignSlots, CARD, emptyMemory, FACT_LINE, factLayout, fit, layout, wrapValue, type Box, type Layout } from './layout.ts';

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

describe('facts in a still drawing', () => {
  const e = (facts: { label: string; value: string; items?: string[] }[]) => ({ id: 'x', kind: 'k', label: 'x', state: 'healthy' as const, facts });

  test('long values wrap at natural breaks instead of being cut', () => {
    expect(wrapValue('dedicated=shop:NoSchedule', 22)).toEqual(['dedicated=shop:', 'NoSchedule']);
    expect(wrapValue('node-role.kubernetes.io/control-plane:NoSchedule', 25)).toEqual(['node-role.kubernetes.io/', 'control-plane:NoSchedule']);
    expect(wrapValue('short', 22)).toEqual(['short']);
    expect(wrapValue('x'.repeat(30), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(10)]);
  });

  test('labels sit beside values when there is room, above them when not', () => {
    const facts = e([{ label: 'Labels', value: 'a=1,b=2', items: ['a=1', 'b=2'] }, { label: 'Images', value: 'nginx:1.31.8' }]);
    expect(factLayout(facts, 300)).toEqual({ labelW: 44, lines: [{ label: 'Labels', text: 'a=1' }, { label: '', text: 'b=2' }, { label: 'Images', text: 'nginx:1.31.8' }] });
    expect(factLayout(facts, 120).lines).toEqual([{ label: 'Labels', text: '' }, { label: '', text: 'a=1' }, { label: '', text: 'b=2' }, { label: 'Images', text: '' }, { label: '', text: 'nginx:1.31.8' }]);
    expect(factLayout(e([{ label: 'L', value: '', items: ['1', '2', '3', '4', '5'] }]), 300).lines.map((l) => l.text)).toEqual(['1', '2', '3', '+2 more']);
  });

  test('a card is as tall as its facts, and a row as its tallest card', () => {
    const model: ViewModel = {
      t: 0,
      kinds: [{ kind: 'p', shape: 'process', label: 'P', plural: 'Ps' }],
      entities: [
        { id: 'a', kind: 'p', label: 'a', state: 'healthy', facts: [{ label: 'F', value: 'v' }] },
        { id: 'b', kind: 'p', label: 'b', state: 'healthy', facts: [] },
      ],
      relations: [],
    };
    const lay = layout({ model, visible: () => true, width: 420, facts: true }, emptyMemory());
    const [a, b] = ['a', 'b'].map((id) => lay.boxes.find((x) => x.id === id));
    // One fact with a short value: one line beside its label.
    expect(a?.h).toBe(CARD.h + FACT_LINE * factLayout(a?.entity as ViewEntity, (a?.w ?? 0) - 28).lines.length);
    expect(a?.h).toBe(CARD.h + FACT_LINE);
    expect(b?.h).toBe(CARD.h);
    expect(layout({ model, visible: () => true, width: 600 }, emptyMemory()).boxes.every((x) => x.h === CARD.h)).toBe(true);
  });
});
