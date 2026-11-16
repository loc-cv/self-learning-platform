// A tiny plugin for testing the runner without a domain: one slice with a counter and a file
// list, a topology, steps, checks and a fault over it. Test support only.

import { CHECK, createRegistry, FAULT, STEP, TOPOLOGY, VIEW, type CheckSpec, type Contribution, type FaultSpec, type Json, type Plugin, type Registry, type SliceSpec, type StepSpec, type TopologySpec, type ViewProviderSpec } from '@simlab/kernel';
import type { Item } from './item/types.ts';

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

const bump: StepSpec = {
  name: 'bump',
  args: { type: 'object', properties: { bump: { type: 'integer', minimum: 1 } }, required: ['bump'], additionalProperties: false },
  run(ctx, args) {
    ctx.kernel.act('bump', (c) => {
      slice(c).value += Number((args as { bump: number }).bump);
      slice(c).touched++;
    });
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
