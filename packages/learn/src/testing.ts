// A tiny plugin for testing the runner without a domain: one slice with a counter and a file
// list, a topology, steps, checks and a fault over it. Test support only.

import { CHECK, createRegistry, FAULT, STEP, TOPOLOGY, VIEW, type CheckSpec, type Contribution, type FaultSpec, type Json, type Plugin, type Registry, type SliceSpec, type StepSpec, type TopologySpec, type Ctx, type ViewEvent, type ViewProviderSpec } from '@simlab/kernel';
import type { CardItem, ExamItem, Item, LessonItem } from './item/types.ts';

export interface CounterSlice {
  value: number;
  /** Incremented by `bump`, never by a check: lets tests see whether a check reached the session. */
  touched: number;
}

const slice = (ctx: { slice<S>(n: string): S }): CounterSlice => ctx.slice<CounterSlice>('counter');

const topology: TopologySpec = {
  name: 'counter-1',
  params: { type: 'object', properties: { start: { type: 'integer' } }, additionalProperties: false },
  build(ctx, params) {
    slice(ctx).value = Number((params as { start?: number }).start ?? 0);
    return { entry: { machine: 'box', user: 'tester' }, machines: ['box'] };
  },
};

/** What `bump` does, as a command someone typed: the trace has the command and what it changed. */
function add(c: Ctx, n: number): void {
  const cmd = c.trace({ source: 'counter.shell', kind: 'counter.command', message: `bump ${n}` });
  if (n !== 0) {
    slice(c).value += n;
    c.trace({ source: 'counter.box', kind: 'counter.changed', message: `the counter went up by ${n} to ${slice(c).value}`, causes: [cmd] });
  }
  slice(c).touched++;
  c.trace({ source: 'counter.shell', kind: 'counter.command.done', message: 'done', causes: [cmd] });
}

const bump: StepSpec = {
  name: 'bump',
  args: { type: 'object', properties: { bump: { type: 'integer', minimum: 1 } }, required: ['bump'], additionalProperties: false },
  run(ctx, args) {
    ctx.kernel.act('bump', (c) => add(c, Number((args as { bump: number }).bump)));
  },
  show: (args) => `$ bump ${String((args as { bump: number }).bump)}`,
};

/** Sets the counter after a delay, as a controller would converge. */
const later: StepSpec = {
  name: 'later',
  args: { type: 'object', properties: { later: { type: 'integer' }, after: { type: 'integer', minimum: 0 } }, required: ['later', 'after'], additionalProperties: false },
  run(ctx, args) {
    const a = args as { later: number; after: number };
    ctx.kernel.act('later', (c) => c.schedule(a.after, 'counter.set', a.later));
  },
};

/** Reports a gap, as a command that prints a `[sim]` notice does. */
const unsupported: StepSpec = {
  name: 'unsupported',
  args: { type: 'object', properties: { unsupported: { type: 'string' } }, required: ['unsupported'], additionalProperties: false },
  run(ctx, args) {
    ctx.kernel.act('unsupported', (c) => c.gap({ kind: 'command', program: 'test', what: String((args as { unsupported: string }).unsupported), commandLine: '', machine: 'box' }));
  },
};

const failing: StepSpec = {
  name: 'explode',
  args: { type: 'object', properties: { explode: { type: 'string' } }, required: ['explode'], additionalProperties: false },
  run(_ctx, args) {
    throw new Error(String((args as { explode: string }).explode));
  },
};

const atLeast: CheckSpec = {
  name: 'counter.atLeast',
  args: { type: 'object', properties: { value: { type: 'integer', description: 'The least value.' } }, required: ['value'], additionalProperties: false },
  run(ctx, args) {
    const want = Number((args as { value: number }).value);
    const v = slice(ctx.kernel.act('read', (c) => c)).value;
    return { pass: v >= want, expected: `the counter is at least ${want}`, observed: `the counter is ${v}` };
  },
};

/** Passes when the counter equals its baseline value. */
const unchanged: CheckSpec = {
  name: 'counter.unchanged',
  args: { type: 'object', properties: {}, additionalProperties: false },
  run(ctx) {
    const now = slice(ctx.kernel.act('read', (c) => c)).value;
    const before = (ctx.baseline.slices['counter'] as CounterSlice).value;
    return { pass: now === before, expected: `the counter is still ${before}`, observed: `the counter is ${now}` };
  },
};

/** A check that changes its fork freely, then looks: proves forks keep the session untouched. */
const vandal: CheckSpec = {
  name: 'counter.vandal',
  args: { type: 'object', properties: {}, additionalProperties: false },
  run(ctx) {
    ctx.kernel.act('vandal', (c) => {
      slice(c).value = -1000;
    });
    ctx.kernel.advance(3_600_000);
    return { pass: true, expected: 'anything', observed: 'scribbled on its fork' };
  },
};

const broken: CheckSpec = {
  name: 'counter.broken',
  args: { type: 'object', properties: {}, additionalProperties: false },
  run: () => ({ pass: false, expected: 'something', observed: '', error: 'cannot look' }),
};

const zero: FaultSpec = {
  name: 'counter.zero',
  args: { type: 'object', properties: {}, additionalProperties: false },
  inject(ctx) {
    slice(ctx).value = 0;
  },
};

/** The box and its counter, for figures: the counter's state is healthy from 5 up. */
const view: ViewProviderSpec = {
  name: 'counter',
  view(world) {
    const c = world.slices['counter'] as CounterSlice | undefined;
    if (!c) return { kinds: [], entities: [], relations: [] };
    return {
      kinds: [
        { kind: 'counter.Box', shape: 'host', label: 'Box', plural: 'Boxes' },
        { kind: 'counter.Counter', shape: 'process', label: 'Counter', plural: 'Counters', placedIn: 'counter.Box', unplaced: 'Counters with no box' },
      ],
      entities: [
        { id: 'box', kind: 'counter.Box', label: 'box', state: 'healthy', facts: [] },
        { id: 'box/counter', kind: 'counter.Counter', label: 'counter', container: 'box', state: c.value >= 5 ? 'healthy' : 'degraded', status: String(c.value), facts: [{ label: 'Value', value: String(c.value) }, { label: 'Touched', value: String(c.touched) }] },
      ],
      relations: [],
    };
  },
  events(records) {
    const out: ViewEvent[] = [];
    for (const r of records) {
      if (r.kind === 'counter.command') {
        const done = records.find((d) => d.kind === 'counter.command.done' && d.causes?.[0] === r.id);
        out.push({ id: r.id, t: r.t, ...(done ? { until: done.t } : {}), actor: 'tester@box', text: r.message, about: ['box'], level: 'key', tone: 'neutral', input: true, causes: [] });
      } else if (r.kind === 'counter.changed') {
        out.push({ id: r.id, t: r.t, actor: r.source === 'counter.timer' ? 'timer' : 'box', text: r.message, about: ['box/counter', 'box'], level: 'key', tone: 'good', link: { from: 'box', to: 'box/counter' }, causes: r.causes ?? [] });
      }
    }
    return out;
  },
  why(world, events, entity) {
    const c = world.slices['counter'] as CounterSlice | undefined;
    if (!c || entity !== 'box/counter') return undefined;
    return { entity, summary: `The counter shows ${c.value}.`, steps: events.filter((e) => e.about[0] === entity) };
  },
};

export const counterPlugin: Plugin = {
  name: 'counter',
  slice: {
    name: 'counter',
    version: 1,
    init: (): CounterSlice => ({ value: 0, touched: 0 }),
    adopt: () => {},
  } as SliceSpec<unknown>,
  handlers: [
    {
      type: 'counter.set',
      handle(ctx, payload: Json) {
        slice(ctx).value = Number(payload);
        ctx.trace({ source: 'counter.timer', kind: 'counter.changed', message: `the timer set the counter to ${Number(payload)}` });
      },
    },
  ],
  // What a learner's terminal would deliver: `add` bumps now, `later` sets a value after a delay.
  inputs: [
    {
      kind: 'counter.type',
      handle(ctx, input) {
        const i = input as unknown as { add?: number; later?: { value: number; after: number } };
        if (i.add !== undefined) add(ctx, i.add);
        if (i.later) ctx.schedule(i.later.after, 'counter.set', i.later.value);
      },
    },
  ],
  contributions: {
    [TOPOLOGY]: [topology],
    [STEP]: [bump, later, unsupported, failing] as unknown as Contribution[],
    [CHECK]: [atLeast, unchanged, vandal, broken] as unknown as Contribution[],
    [FAULT]: [zero] as unknown as Contribution[],
    [VIEW]: [view] as unknown as Contribution[],
  },
};

export function counterRegistry(): Registry {
  return createRegistry([counterPlugin]);
}

/** A valid item over the counter plugin; tests change copies of it. */
export function counterItem(): Item {
  return {
    id: 'test.counter.reach-01',
    kind: 'lab',
    title: 'Reach the target',
    skills: ['test.counter'],
    curriculum: ['cka.workloads.deployments-rollouts'],
    difficulty: 1,
    targetMinutes: 1,
    world: {
      topology: 'counter-1',
      params: { target: { int: { min: 5, max: 9 } }, how: { pick: ['once', 'twice'] } },
      setup: [{ bump: 1 }],
    },
    ticket: 'Make the counter reach {{target}}.',
    hints: ['Look at the counter.', 'It only goes up.', 'Bump it by {{target}}.'],
    checks: [
      { id: 'reached', title: 'The counter is at least {{target}}', assert: 'counter.atLeast', with: { value: '{{target}}' }, weight: 2 },
      { id: 'not-huge', title: 'The counter is not absurd', assert: 'counter.atLeast', with: { value: 100 }, not: true },
    ],
    solutions: [
      { name: 'Bump once', when: { how: 'once' }, steps: [{ bump: '{{target}}' }] },
      { name: 'Bump twice', when: { how: 'twice' }, steps: [{ bump: 2 }, { bump: '{{target}}' }] },
    ],
    debrief: [
      { figure: { kind: 'compare', left: { of: 'start' }, right: { of: 'solved' }, show: ['Value'], caption: 'The counter went from 1 to {{target}}.', alt: 'The counter on the box, before and after.' } },
      { text: 'Counters go up.' },
      { text: 'You bumped once.', when: { how: 'once' } },
      { text: 'You bumped twice.', when: { how: 'twice' } },
    ],
  } as unknown as Item;
}

/** A valid lesson over the counter plugin: prose, a figure, a prediction and two guided tasks. */
export function counterLesson(): LessonItem {
  return {
    id: 'test.counter.lesson-01',
    kind: 'lesson',
    title: 'Counters only go up',
    skills: ['test.counter'],
    curriculum: ['cka.workloads.deployments-rollouts'],
    difficulty: 1,
    targetMinutes: 5,
    world: { topology: 'counter-1', params: { first: { int: { min: 2, max: 4 } }, way: { pick: ['short', 'long'] } }, setup: [{ bump: 1 }] },
    steps: [
      { text: 'A counter holds a number. `bump` adds to it.' },
      { figure: { kind: 'view', of: 'start', show: ['Value'], caption: 'The counter starts at 1.', alt: 'A box with a counter that shows 1.' } },
      { predict: { prompt: 'What does the counter show after `bump {{first}}`?', choices: ['{{first}}', 'One more than {{first}}'], answer: 1, explain: 'It adds; it does not set.' } },
      { task: { text: 'Bump the counter by {{first}}.', hints: ['Use `bump`.'], checks: [{ id: 'bumped', title: 'The counter is past {{first}}', assert: 'counter.atLeast', with: { value: '{{first}}' } }], solution: [{ bump: '{{first}}' }] } },
      { text: 'The long way takes two bumps.', when: { way: 'long' } },
      { predict: { prompt: 'Can a counter go down?', explain: 'No: nothing here subtracts.' } },
      { task: { text: 'Take it to at least 10.', checks: [{ id: 'ten', title: 'The counter is at least 10', assert: 'counter.atLeast', with: { value: 10 } }], solution: [{ bump: 10 }] } },
      { figure: { kind: 'compare', left: { of: 'start' }, right: { of: 'solved' }, show: ['Value'], caption: 'From 1 to past 10.', alt: 'The counter before the lesson and after its tasks.' } },
    ],
  } as unknown as LessonItem;
}

/** Three valid cards: self-graded with a diagram, checked by choice, checked by command. */
export function counterCards(): { plain: CardItem; choice: CardItem; command: CardItem } {
  const header = { kind: 'card', skills: ['test.counter'], curriculum: ['cka.workloads.deployments-rollouts'], difficulty: 1, targetMinutes: 0.5 };
  return {
    plain: {
      ...header,
      id: 'test.counter.card-plain-01',
      title: 'What bump does',
      prompt: 'What does `bump 3` do to a counter at 4?',
      figure: { kind: 'diagram', caption: 'A box and its counter.', alt: 'A box that holds a counter.', entities: [{ id: 'box', shape: 'host', label: 'box' }, { id: 'c', shape: 'process', label: 'counter', container: 'box', status: '4' }] },
      answer: 'It adds 3: the counter shows 7.',
    } as unknown as CardItem,
    choice: {
      ...header,
      id: 'test.counter.card-choice-01',
      title: 'Add or set',
      prompt: 'After `bump 3` on a counter at 4, the counter shows…',
      choices: ['3', '7', '12'],
      correct: 1,
      answer: '7: `bump` adds.',
    } as unknown as CardItem,
    command: {
      ...header,
      id: 'test.counter.card-command-01',
      title: 'Reach a value',
      world: { topology: 'counter-1', params: { goal: { int: { min: 3, max: 6 } } }, setup: [{ bump: 1 }] },
      prompt: 'Make the counter show at least {{goal}}.',
      figure: { kind: 'view', of: 'solved', show: ['Value'], caption: 'The counter once bumped.', alt: 'A counter that shows the goal.' },
      answer: '`bump {{goal}}`',
      checks: [{ id: 'goal', title: 'The counter is at least {{goal}}', assert: 'counter.atLeast', with: { value: '{{goal}}' } }],
      solution: [{ bump: '{{goal}}' }],
    } as unknown as CardItem,
  };
}

export function counterExam(): ExamItem {
  return { id: 'test.counter.exam-01', kind: 'exam', title: 'Counter exam', minutes: 10, passPercent: 66, tasks: [{ item: 'test.counter.reach-01', weight: 100 }] };
}
