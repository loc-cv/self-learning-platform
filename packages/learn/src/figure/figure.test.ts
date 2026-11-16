// Figures over the counter plugin (docs/SCENARIO_FORMAT.md §11): what a focus selects, how a
// comparison marks changes, what content validation refuses, and that rendering never touches the
// learner's session.

import { describe, expect, test } from 'vitest';
import type { ViewModel } from '@simlab/kernel';
import { counterItem, counterRegistry } from '../testing.ts';
import { variantOf } from '../item/variant.ts';
import { buildBaseline } from '../runner/build.ts';
import { createLab } from '../lab.ts';
import { runSeed, staticProblems } from '../validate.ts';
import { blocksText } from './blocks.ts';
import { focusView, resolveRef, showFacts } from './focus.ts';
import { figureWorlds, renderFigure } from './render.ts';
import type { Block, Figure } from './types.ts';
import type { Item } from '../item/types.ts';

const registry = counterRegistry();
const ctx = { registry, competencies: new Set(['cka.workloads.deployments-rollouts']), skills: new Set(['test.counter']) };

/** The counter item with these debrief blocks first (a figure must open it). */
const withDebrief = (blocks: Block[], change?: (i: Item) => void): Item => {
  const i = counterItem();
  i.debrief = [...blocks, { text: 'Counters go up.' }];
  change?.(i);
  return i;
};
const fig = (f: Figure): Block => ({ figure: f });

const model: ViewModel = {
  t: 0,
  kinds: [
    { kind: 'x.Scope', shape: 'scope', label: 'Scope', plural: 'Scopes' },
    { kind: 'x.Host', shape: 'host', label: 'Host', plural: 'Hosts' },
    { kind: 'x.Machine', shape: 'host', label: 'Machine', plural: 'Machines' },
    { kind: 'x.Proc', shape: 'process', label: 'Proc', plural: 'Procs', placedIn: 'x.Host', unplaced: 'Procs with no host' },
    { kind: 'x.Unit', shape: 'workload', label: 'Unit', plural: 'Units' },
  ],
  entities: [
    { id: 'm1', kind: 'x.Machine', label: 'm1', state: 'healthy', facts: [] },
    { id: 'h1', kind: 'x.Host', label: 'h1', container: 'm1', state: 'healthy', facts: [{ label: 'Labels', value: 'a=1,disk=ssd', items: ['a=1', 'disk=ssd'] }] },
    { id: 'h2', kind: 'x.Host', label: 'h2', container: 'm1', state: 'healthy', facts: [] },
    { id: 's/a', kind: 'x.Scope', label: 'a', state: 'healthy', facts: [] },
    { id: 's/b', kind: 'x.Scope', label: 'b', state: 'healthy', facts: [] },
    { id: 's/sys', kind: 'x.Scope', label: 'sys', state: 'healthy', system: true, facts: [] },
    { id: 'u/a/web', kind: 'x.Unit', label: 'web', container: 's/a', state: 'healthy', facts: [] },
    { id: 'p/a/web-1', kind: 'x.Proc', label: 'web-1', container: 'h1', scope: 's/a', state: 'healthy', facts: [{ label: 'Status', value: 'Running' }] },
    { id: 'p/b/db-1', kind: 'x.Proc', label: 'db-1', container: 'h2', scope: 's/b', state: 'healthy', facts: [] },
    { id: 'p/sys/agent', kind: 'x.Proc', label: 'agent', container: 'h1', scope: 's/sys', state: 'healthy', system: true, facts: [] },
  ],
  relations: [
    { type: 'owns', from: 'u/a/web', to: 'p/a/web-1' },
    { type: 'owns', from: 'u/a/web', to: 'p/b/db-1' },
  ],
};
const ids = (m: ViewModel): string[] => m.entities.map((e) => e.id);

describe('focus', () => {
  test('no focus: everything but the platform', () => {
    expect(ids(focusView(model, undefined, undefined))).toEqual(['m1', 'h1', 'h2', 's/a', 's/b', 'u/a/web', 'p/a/web-1', 'p/b/db-1']);
    expect(focusView(model, undefined, undefined).entities.every((e) => e.facts.length === 0)).toBe(true);
  });

  test('a scope keeps what belongs to it and what belongs to none; an instance pulls in its host', () => {
    const m = focusView(model, { scope: 'a', kinds: ['Unit', 'Proc'] }, undefined);
    expect(ids(m)).toEqual(['h1', 's/a', 'u/a/web', 'p/a/web-1']);
    // h1 came in for the Proc on it; its machine did not, so h1 stands at the top level.
    expect(m.entities.find((e) => e.id === 'h1')?.container).toBeUndefined();
    expect(m.entities.find((e) => e.id === 'p/a/web-1')?.container).toBe('h1');
    expect(m.relations).toEqual([{ type: 'owns', from: 'u/a/web', to: 'p/a/web-1' }]);
    expect(m.kinds.map((k) => k.kind)).toEqual(['x.Scope', 'x.Host', 'x.Proc', 'x.Unit']);
  });

  test('entities by reference, with a wildcard', () => {
    expect(ids(focusView(model, { entities: ['Proc/*-1'] }, undefined))).toEqual(['h1', 'h2', 'p/a/web-1', 'p/b/db-1']);
    expect(resolveRef(model, 'Host/h*')).toEqual(['h1', 'h2']);
    expect(resolveRef(model, 'Pod/web-1')).toEqual([]);
    expect(resolveRef(model, 'nothing')).toEqual([]);
  });

  test('system entities only when asked for', () => {
    expect(ids(focusView(model, { scope: 'sys', system: true, kinds: ['Proc'] }, undefined))).toEqual(['h1', 'p/sys/agent']);
    expect(ids(focusView(model, { kinds: ['Proc'] }, undefined))).toEqual(['h1', 'h2', 'p/a/web-1', 'p/b/db-1']);
  });

  test('show picks facts by label, and entries of a list fact by key', () => {
    const facts = model.entities[1]?.facts ?? [];
    expect(showFacts(facts, ['labels'])).toEqual([{ label: 'Labels', value: 'a=1,disk=ssd', items: ['a=1', 'disk=ssd'] }]);
    expect(showFacts(facts, [{ fact: 'Labels', keys: ['disk'] }])).toEqual([{ label: 'Labels', value: 'disk=ssd', items: ['disk=ssd'] }]);
    expect(showFacts(facts, [{ fact: 'Labels', keys: ['dis'] }])).toEqual([]);
    expect(showFacts(facts, ['Taints'])).toEqual([]);
  });
});

describe('rendering', () => {
  const baseline = buildBaseline(variantOf(counterItem(), 1), registry);
  const env = { registry, baseline };

  test('a comparison marks what changed, on the right', () => {
    const r = renderFigure({ kind: 'compare', left: { of: 'start' }, right: { of: 'solved' }, show: ['Value'], caption: 'c', alt: 'a' }, figureWorlds(env), env);
    expect(r.problems).toEqual([]);
    if (r.figure?.kind !== 'compare') throw new Error('not a comparison');
    expect(r.figure.left.title).toBe('At the start');
    expect(r.figure.right.title).toBe('Solved');
    expect(r.figure.right.changes).toEqual({ 'box/counter': 'changed' });
    expect(r.figure.left.changes).toEqual({});
    expect(r.figure.left.model.entities.find((e) => e.id === 'box/counter')?.facts).toEqual([{ label: 'Value', value: '1' }]);
  });

  test('a scene runs on its own fork, frame by frame, with each frame’s marks numbered after the figure’s', () => {
    const scene: Figure = {
      kind: 'scene',
      show: ['Value'],
      notes: [{ on: 'Counter/counter', text: 'the counter' }],
      frames: [{ caption: 'one' }, { caption: 'two', steps: [{ bump: 2 }], notes: [{ text: 'whole figure' }] }, { caption: 'later', steps: [{ later: 9, after: 1000 }, { advance: '2s' }] }],
      caption: 'c',
      alt: 'a',
    };
    const r = renderFigure(scene, figureWorlds(env), env);
    expect(r.problems).toEqual([]);
    if (r.figure?.kind !== 'scene') throw new Error('not a scene');
    expect(r.figure.frames.map((f) => f.panel.model.entities.find((e) => e.id === 'box/counter')?.status)).toEqual(['1', '3', '9']);
    expect(r.figure.frames[1]?.panel.notes).toEqual([
      { n: 1, on: ['box/counter'], text: 'the counter' },
      { n: 2, on: [], text: 'whole figure' },
    ]);
    // The baseline was forked, never run.
    expect((baseline.kernel.world.slices['counter'] as { value: number }).value).toBe(1);
  });

  test('a scene of its own small world', () => {
    const r = renderFigure({ kind: 'scene', world: { setup: [{ bump: 6 }] }, frames: [{ caption: 'a' }, { caption: 'b', steps: [{ bump: 1 }] }], caption: 'c', alt: 'a' }, figureWorlds(env), env);
    expect(r.problems).toEqual([]);
    if (r.figure?.kind !== 'scene') throw new Error('not a scene');
    expect(r.figure.frames.map((f) => f.panel.model.entities.find((e) => e.id === 'box/counter')?.state)).toEqual(['healthy', 'healthy']);
  });

  test('a diagram is a view model drawn by hand, checked like one', () => {
    const r = renderFigure({ kind: 'diagram', entities: [{ id: 'a', shape: 'process', label: 'A', state: 'healthy' }, { id: 'b', shape: 'rule', label: 'B' }], relations: [{ type: 'uses', from: 'a', to: 'c' }], notes: [{ on: 'z', text: 'n' }], caption: 'c', alt: 'a' }, figureWorlds(env), env);
    expect(r.problems).toEqual(['diagram: relation uses a → c: an end is not in the model', 'diagram: a note is on z, which is not an entity']);
  });

  test('the terminal shows a figure as its caption and alt text', () => {
    expect(blocksText([{ text: 'Before.' }, { figure: { kind: 'view', of: 'start', caption: 'The box.', alt: 'One box, one counter.' } }])).toBe('Before.\n\n[Figure] The box.\nOne box, one counter.\n');
  });
});

describe('content validation of figures', () => {
  const problemsOf = (i: Item): string[] => [...staticProblems(i as never, ctx), ...[1, 2, 3, 4].flatMap((s) => runSeed(i, s, registry).problems)];

  test('the counter item passes with its comparison', () => {
    expect(problemsOf(counterItem())).toEqual([]);
  });

  test('a focus that selects nothing, and marks that name nothing, are refused', () => {
    const i = withDebrief([fig({ kind: 'view', of: 'start', focus: { kinds: ['Pod'] }, caption: 'c', alt: 'a' }), fig({ kind: 'view', of: 'solved', highlight: ['Counter/nope'], caption: 'c', alt: 'a' })]);
    expect(runSeed(i, 1, registry).problems).toEqual(['debrief figure 1 (view): the focus selects nothing in the start world', 'debrief figure 2 (view): Counter/nope names no entity in the solved world']);
  });

  test('a scene with a gap, and a frame that changes nothing, are refused', () => {
    const gap = withDebrief([fig({ kind: 'scene', frames: [{ caption: 'a' }, { caption: 'b', steps: [{ unsupported: 'teleport' }] }], caption: 'c', alt: 'a' })]);
    expect(runSeed(gap, 1, registry).problems).toEqual(['debrief figure 1 (scene): scene frame 2, step 1 (unsupported): the simulator does not support this: test: teleport']);
    const still = withDebrief([fig({ kind: 'scene', frames: [{ caption: 'a' }, { caption: 'b', steps: [{ advance: '1m' }] }], caption: 'c', alt: 'a' })]);
    expect(runSeed(still, 1, registry).problems).toEqual(['debrief figure 1 (scene): frame 2 shows the same as frame 1; a frame must change something']);
  });

  test('a figure under `when` is checked with its variant only', () => {
    const i = withDebrief([fig({ kind: 'view', of: 'start', caption: 'c', alt: 'a' }), { figure: { kind: 'view', of: 'start', focus: { kinds: ['Pod'] }, caption: 'c', alt: 'a' }, when: { how: 'twice' } }]);
    const by = (how: string): string[] => [1, 2, 3, 4, 5, 6].filter((s) => variantOf(i, s).params['how'] === how).flatMap((s) => runSeed(i, s, registry).problems);
    expect(by('once')).toEqual([]);
    expect(new Set(by('twice'))).toEqual(new Set(['debrief figure 2 (view): the focus selects nothing in the start world']));
  });

  test('a debrief that does not open with a figure is refused', () => {
    const i = withDebrief([], (x) => {
      x.debrief = 'Only words.';
    });
    expect(runSeed(i, 1, registry).problems).toEqual(['the debrief of this variant does not open with a figure']);
  });

  test("a ticket's figure is a view of the start or now, or a diagram, and names what it shows", () => {
    const i = counterItem();
    i.ticket = [
      { text: 'Reach {{target}}.' },
      fig({ kind: 'view', of: 'start', show: [], caption: 'c', alt: 'a' }),
      fig({ kind: 'view', of: 'now', caption: 'c', alt: 'a' }),
      fig({ kind: 'view', of: 'solved', show: [], caption: 'c', alt: 'a' }),
      fig({ kind: 'compare', left: { of: 'start' }, right: { of: 'solved' }, caption: 'c', alt: 'a' }),
    ];
    expect(staticProblems(i as never, ctx)).toEqual([
      "ticket[2].figure: a ticket's view names the facts it shows (`show`, [] for none)",
      "ticket[3].figure: a ticket's figure never shows the solved world",
      "ticket[4].figure: a ticket's figure is a view or a diagram, not a compare",
    ]);
  });

  test('the schema refuses a figure without its alt text or with an unknown kind', () => {
    const i = withDebrief([fig({ kind: 'view', of: 'start', caption: 'c' } as unknown as Figure)]);
    expect(staticProblems(i as never, ctx).length).toBeGreaterThan(0);
    const j = withDebrief([fig({ kind: 'movie', caption: 'c', alt: 'a' } as unknown as Figure)]);
    expect(staticProblems(j as never, ctx).length).toBeGreaterThan(0);
  });
});

describe('figures in a lab', () => {
  test('`now` is the session world; rendering changes neither it nor the lab’s events', () => {
    const lab = createLab(counterItem(), registry, { seed: 1 });
    lab.run([{ bump: 3 }]);
    const hash = lab.kernel.hash();
    const events = lab.events.length;
    const [b] = lab.render([{ figure: { kind: 'compare', left: { of: 'now' }, right: { of: 'solved' }, show: ['Value'], caption: 'c', alt: 'a' } }]);
    if (!b || !('figure' in b) || b.figure.kind !== 'compare') throw new Error(`not rendered: ${JSON.stringify(b)}`);
    expect(b.figure.left.title).toBe('Your world now');
    expect(b.figure.left.model.entities.find((e) => e.id === 'box/counter')?.status).toBe('4');
    expect(lab.kernel.hash()).toBe(hash);
    expect(lab.events.length).toBe(events);
  });

  test('a figure that cannot be built is reported in its place', () => {
    const lab = createLab(counterItem(), registry, { seed: 1 });
    const [b, now] = lab.render([{ figure: { kind: 'view', of: 'start', focus: { kinds: ['Pod'] }, caption: 'c', alt: 'a' } }, { figure: { kind: 'view', of: 'now', focus: { kinds: ['Pod'] }, caption: 'c', alt: 'a' } }]);
    expect(b).toEqual({ failed: { caption: 'c', alt: 'a', problems: ['the focus selects nothing in the start world'] } });
    // The learner's world may hold nothing the figure shows: an empty drawing, not a failure.
    expect(now && 'figure' in now && now.figure.kind === 'view' && now.figure.panel.model.entities).toEqual([]);
  });
});
