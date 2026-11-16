import { expect, test } from 'vitest';
import { createRegistry } from './registry.ts';
import { buildView, validateView, VIEW, type ViewPart, type ViewProviderSpec } from './view.ts';
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
