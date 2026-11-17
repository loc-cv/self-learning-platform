import { expect, test } from 'vitest';
import { createRegistry } from './registry.ts';
import { buildEvents, buildView, buildWhy, validateEvents, validateView, VIEW, type ViewEvent, type ViewPart, type ViewProviderSpec } from './view.ts';
import type { TraceRecord } from './trace.ts';
import { emptyWorld } from './world.ts';

const part = (p: Partial<ViewPart>): ViewPart => ({ kinds: [], entities: [], relations: [], ...p });

const boxes: ViewProviderSpec = {
  name: 'b',
  view: (w) =>
    part({
      kinds: [{ kind: 'b.Box', shape: 'host', label: 'Box', plural: 'Boxes' }],
      entities: [
        { id: 'b/2', kind: 'b.Box', label: 'two', state: 'healthy', facts: [] },
        { id: 'b/1', kind: 'b.Box', label: `one at ${w.clock.now}`, state: 'failed', facts: [{ label: 'Seed', value: String(w.seed) }] },
      ],
    }),
};
const items: ViewProviderSpec = {
  name: 'a',
  view: () =>
    part({
      kinds: [{ kind: 'a.Item', shape: 'process', label: 'Item', plural: 'Items', placedIn: 'b.Box', unplaced: 'No box' }],
      entities: [
        { id: 'a/x', kind: 'a.Item', label: 'x', container: 'b/2', state: 'progressing', facts: [] },
        { id: 'a/y', kind: 'a.Item', label: 'y', state: 'progressing', facts: [] },
      ],
      relations: [
        { type: 'uses', from: 'a/y', to: 'a/x' },
        { type: 'owns', from: 'a/x', to: 'a/y' },
        { type: 'owns', from: 'a/x', to: 'a/y' },
        { type: 'owns', from: 'a/x', to: 'gone' },
      ],
    }),
};

test('the view merges every provider in a defined order and drops dangling or repeated relations', () => {
  const r = createRegistry([{ name: 'p', contributions: { [VIEW]: [boxes, items] } }]);
  const m = buildView(r, emptyWorld(7, 1000));
  expect(m.t).toBe(1000);
  expect(m.kinds.map((k) => k.kind)).toEqual(['a.Item', 'b.Box']);
  expect(m.entities.map((e) => e.id)).toEqual(['a/x', 'a/y', 'b/1', 'b/2']);
  expect(m.relations).toEqual([
    { type: 'owns', from: 'a/x', to: 'a/y' },
    { type: 'uses', from: 'a/y', to: 'a/x' },
  ]);
  expect(validateView(m)).toEqual([]);
  // A pure function of the world: the same world, the same model.
  expect(buildView(r, emptyWorld(7, 1000))).toEqual(m);
});

test('validation names duplicates, unknown kinds and containers, bad scopes and cycles', () => {
  const m = part({
    kinds: [
      { kind: 'k', shape: 'host', label: 'K', plural: 'Ks' },
      // @ts-expect-error: a shape the renderer does not know
      { kind: 'z', shape: 'cloud', label: 'Z', plural: 'Zs' },
    ],
    entities: [
      { id: '1', kind: 'k', label: '1', container: '2', state: 'healthy', facts: [] },
      { id: '2', kind: 'k', label: '2', container: '1', state: 'healthy', facts: [] },
      { id: '2', kind: 'q', label: '2', state: 'healthy', facts: [], scope: '1' },
      { id: '3', kind: 'k', label: '3', container: 'nope', state: 'healthy', facts: [] },
    ],
    relations: [{ type: 'owns', from: '1', to: '9' }],
  });
  expect(validateView(m)).toEqual([
    'kind z: unknown shape cloud',
    '2: two entities with this id',
    '2: kind q is not described',
    '2: containment cycle through 2',
    '2: scope 1 is not a scope entity',
    '3: container nope is not in the model',
    'relation owns 1 → 9: an end is not in the model',
  ]);
});

const rec = (id: number, kind: string, causes?: number[]): TraceRecord => ({ id, t: 100 + id, source: kind.split('.')[0] as string, kind, message: `${kind} ${id}`, during: 'x', ...(causes ? { causes } : {}) });
const ev = (r: TraceRecord, extra: Partial<ViewEvent> = {}): ViewEvent => ({ id: r.id, t: r.t, actor: r.source, text: r.message, about: [], level: 'key', tone: 'neutral', causes: r.causes ?? [], ...extra });

test('events of every provider merge in record order, and causes skip records no event shows', () => {
  const a: ViewProviderSpec = { name: 'a', view: () => part({}), events: (rs) => rs.filter((r) => r.kind.startsWith('a.') && r.kind !== 'a.hidden').map((r) => ev(r)) };
  const b: ViewProviderSpec = {
    name: 'b',
    view: () => part({}),
    events: (rs) => rs.filter((r) => r.kind.startsWith('b.')).map((r) => ev(r, { about: ['b/1'] })),
    why: (_w, events, entity) => (entity === 'b/1' ? { entity, summary: 'because', steps: events.filter((e) => e.about.includes(entity)) } : undefined),
  };
  const registry = createRegistry([{ name: 'p', contributions: { [VIEW]: [b, a] } }]);
  // 1 a.shown ← 2 a.hidden ← 3 a.hidden ← 4 b.act ; 5 b.act ← 4 and ← 2 (both reach 1 or 4)
  const records = [rec(1, 'a.shown'), rec(2, 'a.hidden', [1]), rec(3, 'a.hidden', [2]), rec(4, 'b.act', [3]), rec(5, 'b.act', [4, 2]), rec(6, 'c.unmapped', [5])];
  const events = buildEvents(registry, records);
  expect(events.map((e) => [e.id, e.causes])).toEqual([
    [1, []],
    [4, [1]],
    [5, [1, 4]],
  ]);
  expect(validateEvents(events)).toEqual([]);
  expect(buildWhy(registry, emptyWorld(1, 0), events, 'b/1')?.steps.map((e) => e.id)).toEqual([4, 5]);
  expect(buildWhy(registry, emptyWorld(1, 0), events, 'a/x')).toBeUndefined();
});

test('validateEvents names what is wrong', () => {
  const bad: ViewEvent[] = [
    ev(rec(2, 'a.x'), { causes: [2] }),
    ev(rec(1, 'a.x'), { actor: '' }),
    ev(rec(1, 'a.x'), { tone: 'loud' as never, items: [{ label: '', value: 'v', tone: 'good' }] }),
  ];
  const problems = validateEvents(bad).join('\n');
  for (const want of ['cause 2 does not precede', 'out of record order', 'names who acted', 'two events with this id', 'unknown tone loud', 'malformed item']) expect(problems).toContain(want);
});
