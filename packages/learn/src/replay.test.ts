// The trace in figures and the replay of a run, over the counter plugin (PLAN.md §5, §6.5): a
// scene's frame drawn at a recorded event, an attempt replayed from its input log with each
// frame at the virtual time it happened, a reference solution drawn the same way, assist levels.

import { describe, expect, test } from 'vitest';
import { createRecorder, ENGINE_VERSION, validateEvents, type SessionHeader } from '@simlab/kernel';
import { assistAllows, assistFor, lowerAssist } from './assist.ts';
import { eventsOf } from './figure/events.ts';
import { figureWorlds, renderFigure } from './figure/render.ts';
import type { Figure } from './figure/types.ts';
import { variantOf } from './item/variant.ts';
import { replayAttempt, replaySolution, REPLAY_FRAMES } from './replay.ts';
import { buildBaseline, startSession } from './runner/build.ts';
import { counterItem, counterRegistry } from './testing.ts';
import { runSeed, staticProblems } from './validate.ts';
import type { Item } from './item/types.ts';
import type { Json } from '@simlab/kernel';

const registry = counterRegistry();
const START = 1_800_000_000_000;
const variant = variantOf(counterItem(), 3);
const baseline = buildBaseline(variant, registry, { startTime: START });
const env = { registry, baseline };
const ctx = { registry, competencies: new Set(['cka.workloads.deployments-rollouts']), skills: new Set(['test.counter']) };
const header: SessionHeader = { topology: 'counter-1', seed: 3, startTime: START, engine: ENGINE_VERSION };

describe('a session keeps the trace of its setup', () => {
  test('the session world can explain what the setup did', () => {
    const { kernel } = startSession(baseline);
    const events = eventsOf(registry, kernel);
    expect(events.map((e) => e.text)).toEqual(['bump 1', 'the counter went up by 1 to 1']);
    expect(validateEvents(events)).toEqual([]);
    // The change follows from the command, and the command has run to its end.
    expect(events[1]?.causes).toEqual([events[0]?.id]);
    expect(events[0]?.until).toBe(START);
  });
});

describe('a scene frame anchored to the trace', () => {
  const scene = (frames: Extract<Figure, { kind: 'scene' }>['frames']): Figure => ({ kind: 'scene', show: ['Value'], frames, caption: 'c', alt: 'a' });

  test('is drawn at the moment the event was recorded, and its caption quotes the cause', () => {
    const r = renderFigure(
      scene([
        { caption: 'At the start.' },
        { steps: [{ later: 7, after: 5000 }], at: { actor: 'timer', about: 'Counter/counter', text: '*to 7' }, caption: 'Five seconds on: {{@cause}}.' },
        { steps: [{ bump: 2 }], caption: 'Then a bump.' },
      ]),
      figureWorlds(env),
      env,
    );
    expect(r.problems).toEqual([]);
    if (r.figure?.kind !== 'scene') throw new Error('not a scene');
    const [first, second, third] = r.figure.frames;
    expect(first?.t).toBe(START);
    expect(second?.t).toBe(START + 5000);
    expect(second?.cause?.text).toBe('the timer set the counter to 7');
    expect(second?.caption).toBe('Five seconds on: the timer set the counter to 7.');
    // Motion only where the trace recorded a cause along a pair that is drawn.
    expect(first?.panel.links).toBeUndefined();
    expect(second?.panel.links).toEqual([{ from: 'box', to: 'box/counter' }]);
    expect(third?.cause).toBeUndefined();
    expect(third?.panel.links).toEqual([{ from: 'box', to: 'box/counter' }]);
  });

  test('an event that never comes, one that passed during the steps, and a quote without an anchor are problems', () => {
    const never = renderFigure(scene([{ caption: 'a' }, { at: { actor: 'timer', within: '30s' }, caption: 'b' }]), figureWorlds(env), env);
    expect(never.problems).toEqual(['frame 2: no event (actor timer) was recorded within 30s']);
    const passed = renderFigure(scene([{ caption: 'a' }, { steps: [{ later: 7, after: 1000 }, { advance: '10s' }], at: { actor: 'timer' }, caption: 'b' }]), figureWorlds(env), env);
    expect(passed.problems.join()).toContain('was recorded 9000 ms before the frame could be drawn');
    const quote = renderFigure(scene([{ caption: 'a' }, { steps: [{ bump: 1 }], caption: 'b {{@cause}}' }]), figureWorlds(env), env);
    expect(quote.problems.join()).toContain('quotes {{@cause}}, but the frame has no `at`');
  });

  test('content validation accepts the anchor and the reserved placeholder', () => {
    const item = counterItem();
    item.debrief = [{ figure: scene([{ caption: 'a' }, { steps: [{ later: 9, after: 2000 }], at: { text: '*timer*' }, caption: 'It says: {{@cause}}' }]) }, { text: 'Counters go up.' }];
    expect(staticProblems(item as unknown as Json, ctx)).toEqual([]);
    for (const seed of [1, 2, 3]) expect(runSeed(item, seed, registry).problems).toEqual([]);
  });
});

/** A recorded attempt: a command that changes nothing, a bump, a change that lands later, a last bump. */
function record() {
  const { kernel } = startSession(baseline);
  const rec = createRecorder(kernel, header);
  const stamps: Record<string, number> = {};
  const type = (name: string, input: Record<string, unknown>): void => {
    rec.deliver({ kind: 'counter.type', ...input });
    stamps[name] = kernel.now;
  };
  kernel.advance(4_000);
  type('look', { add: 0 });
  kernel.advance(6_000);
  type('bump', { add: 2 });
  kernel.advance(1_000);
  type('later', { add: 0, later: { value: 8, after: 30_000 } });
  kernel.advance(45_000);
  rec.deliver({ kind: 'learn.action', action: 'check', data: { passed: true } });
  type('last', { add: 1 });
  kernel.advance(5_000);
  return { log: rec.log(), stamps, final: kernel.hash(), now: kernel.now };
}

describe('the replay of an attempt', () => {
  test('draws the start, each change and how the world went on, at the virtual times of the input log', () => {
    const { log, stamps } = record();
    const r = replayAttempt(log, baseline, registry, { show: ['Value'] });
    const value = (i: number): string | undefined => r.frames[i]?.panel.model.entities.find((e) => e.id === 'box/counter')?.status;
    expect(r.frames.map((f) => [f.kind, f.t - START, f.labels])).toEqual([
      ['start', 0, []],
      ['change', stamps['bump'] as number - START, ['bump 2']],
      ['settled', (stamps['later'] as number) + 30_000 - START, []],
      ['change', stamps['last'] as number - START, ['bump 1']],
    ]);
    expect([value(0), value(1), value(2), value(3)]).toEqual(['1', '3', '8', '9']);
    // Every frame time is a time of the log: an input's stamp, or within the span it covers.
    for (const f of r.frames.filter((x) => x.kind === 'change')) expect(log.inputs.some((i) => i.t === f.t)).toBe(true);
    expect(r.start).toBe(START);
    expect(r.end).toBe(log.end);
    // The commands are all there, also the two that changed nothing in the drawing.
    expect(r.inputs.map((c) => [c.text, c.t - START])).toEqual([
      ['bump 0', 4_000],
      ['bump 2', 10_000],
      ['bump 0', 11_000],
      ['bump 1', 56_000],
    ]);
    // What each frame says happened, and what it marks as changed.
    expect(r.frames[1]?.events.map((e) => e.text)).toEqual(['the counter went up by 2 to 3']);
    expect(r.frames[2]?.events.map((e) => e.text)).toEqual(['the timer set the counter to 8']);
    expect(r.frames[2]?.panel.changes).toEqual({ 'box/counter': 'changed' });
    expect(r.frames[2]?.panel.links).toEqual([{ from: 'box', to: 'box/counter' }]);
    // The start explains what is broken with the trace of the setup: the counter is below 5.
    expect(r.causes.map((w) => [w.entity, w.summary, w.steps.map((s) => s.text)])).toEqual([['box/counter', 'The counter shows 1.', ['the counter went up by 1 to 1']]]);
    expect(r.omitted).toBe(0);
  });

  test('never touches the session, and gives the same replay every time', () => {
    const { log } = record();
    const before = baseline.kernel.hash();
    const a = replayAttempt(log, baseline, registry);
    const b = replayAttempt(log, baseline, registry);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(baseline.kernel.hash()).toBe(before);
  });

  test('a long run keeps its first and last frames and says how many it left out', () => {
    const { kernel } = startSession(baseline);
    const rec = createRecorder(kernel, header);
    for (let i = 0; i < REPLAY_FRAMES + 10; i++) {
      kernel.advance(1_000);
      rec.deliver({ kind: 'counter.type', add: 1 });
    }
    const r = replayAttempt(rec.log(), baseline, registry);
    expect(r.frames.length).toBe(REPLAY_FRAMES);
    expect(r.omitted).toBe(11);
    expect(r.frames[0]?.kind).toBe('start');
    expect(r.frames.at(-1)?.t).toBe(kernel.now);
  });
});

describe('the replay of a reference solution', () => {
  test('a frame after each step that changed the drawing; a waiting step shows how the world settled', () => {
    const r = replaySolution({ name: 'two ways', steps: [{ bump: 2 }, { later: 9, after: 20_000 }, { until: { assert: 'counter.atLeast', with: { value: 9 } }, timeout: '1m' }] }, baseline, registry, { show: ['Value'] });
    expect(r.frames.map((f) => [f.kind, f.labels])).toEqual([
      ['start', []],
      ['change', ['$ bump 2']],
      ['settled', []],
    ]);
    expect(r.frames[2]?.t).toBeGreaterThanOrEqual(START + 20_000);
    expect(r.frames[2]?.events.map((e) => e.text)).toEqual(['the timer set the counter to 9']);
    expect(r.inputs.map((c) => c.text)).toEqual(['bump 2']);
    expect(r.causes.length).toBe(1);
  });
});

describe('assist levels', () => {
  test('the lower of the item and the global setting applies; an exam task gets none', () => {
    expect(assistFor({})).toBe('full');
    expect(assistFor({ assist: 'view' })).toBe('view');
    expect(assistFor({ assist: 'view' }, 'full')).toBe('view');
    expect(assistFor({}, 'off')).toBe('off');
    expect(assistFor({ assist: 'off' }, 'full')).toBe('off');
    expect(assistFor({ assist: 'full' }, 'full', true)).toBe('off');
    expect(lowerAssist('view', 'full')).toBe('view');
    expect([assistAllows('full', 'full'), assistAllows('view', 'full'), assistAllows('view', 'view'), assistAllows('off', 'view')]).toEqual([true, false, true, false]);
  });

  test('an item may declare its level, and nothing else', () => {
    const ok: Item = { ...counterItem(), assist: 'view' };
    expect(staticProblems(ok as unknown as Json, ctx)).toEqual([]);
    expect(staticProblems({ ...counterItem(), assist: 'some' } as unknown as Json, ctx).join()).toContain('assist');
  });
});
