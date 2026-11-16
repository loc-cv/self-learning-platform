import { describe, expect, test } from 'vitest';
import { snapshot } from '@simlab/kernel';
import { counterItem, counterRegistry, type CounterSlice } from './testing.ts';
import { resolveParams, substituteString, variantOf } from './item/variant.ts';
import { buildBaseline, startSession } from './runner/build.ts';
import { grade, gradeCheck } from './runner/grader.ts';
import { runSteps, StepFailure } from './runner/steps.ts';
import { createLab } from './lab.ts';
import { parseItem, runSeed, seedsFor, staticProblems, variantProblems } from './validate.ts';
import { pollInterval } from './runner/evaluate.ts';
import { showSolution } from './show.ts';
import type { Check, Item } from './item/types.ts';

const registry = counterRegistry();
const counter = (k: { world: { slices: Record<string, unknown> } }): CounterSlice => k.world.slices['counter'] as CounterSlice;
const ctx = { registry, competencies: new Set(['cka.workloads.deployments-rollouts']), skills: new Set(['test.counter']) };
const withItem = (change: (i: Item) => void): Item => {
  const i = counterItem();
  change(i);
  return i;
};

describe('parameters and placeholders', () => {
  test('resolution is a function of the item id and the seed', () => {
    const item = counterItem();
    expect(resolveParams(item, 3)).toEqual(resolveParams(item, 3));
    const all = new Set(Array.from({ length: 40 }, (_, s) => JSON.stringify(resolveParams(item, s))));
    expect(all.size).toBeGreaterThan(3);
  });

  test('adding a parameter at the end leaves the others unchanged', () => {
    const item = counterItem();
    const more = withItem((i) => {
      (i.world.params as Record<string, unknown>)['extra'] = { pick: ['a', 'b'] };
    });
    for (let s = 1; s < 20; s++) {
      const { extra: _e, ...rest } = resolveParams(more, s);
      expect(rest).toEqual(resolveParams(item, s));
    }
  });

  test('a whole-string placeholder keeps the type; inside text it is inserted', () => {
    expect(substituteString('{{n}}', { n: 3 })).toBe(3);
    expect(substituteString('n={{ n }}!', { n: 3 })).toBe('n=3!');
    expect(substituteString('\\{{n}} {{n}}', { n: 'x' })).toBe('{{n}} x');
    expect(() => substituteString('{{m}}', { n: 1 }, 'ticket')).toThrow('ticket: {{m}} names no parameter');
  });

  test('when drops what does not apply to the variant', () => {
    const item = counterItem();
    const seed = [1, 2, 3, 4, 5, 6].find((s) => resolveParams(item, s)['how'] === 'twice') as number;
    const v = variantOf(item, seed);
    expect(v.solutions.map((s) => s.name)).toEqual(['Bump twice']);
    expect(v.debrief).toBe('Counters go up.\n\nYou bumped twice.\n');
    expect(v.checks[0]?.with['value']).toBe(v.params['target']);
    expect(v.checks[0]?.weight).toBe(2);
  });
});

describe('the schema', () => {
  test('the counter item is valid, and its problems are none', () => {
    expect(parseItem(counterItem() as never, registry).problems).toEqual([]);
    expect(staticProblems(counterItem() as never, ctx)).toEqual([]);
  });

  test('unknown fields, unknown checks and bad modifiers are errors', () => {
    const bad = withItem((i) => {
      (i as unknown as Record<string, unknown>)['colour'] = 'blue';
      (i.checks[0] as { assert: string }).assert = 'counter.nope';
      i.world.setup = [{ bump: 0 }];
    });
    const problems = parseItem(bad as never, registry).problems;
    expect(problems).toContain('colour is not a known field');
    expect(problems.some((p) => p.startsWith('checks[0].assert must be one of'))).toBe(true);
    expect(problems).toContain('world.setup[0].bump must be at least 1');
  });

  test('a typed argument accepts a placeholder before substitution and its type after', () => {
    const v = variantOf(counterItem(), 1);
    expect(variantProblems(v, registry)).toEqual([]);
    const wrong = withItem((i) => {
      i.world.params = { ...i.world.params, word: { pick: ['a', 'b'] } };
      (i.checks[0] as { with: Record<string, unknown> }).with = { value: '{{word}}' };
    });
    expect(variantProblems(variantOf(wrong, 1), registry)).toEqual(['check reached.with: value must be integer, is string']);
  });

  test('static rules: id and file name, skills, curriculum, placeholders, when values, unused parameters', () => {
    const bad = withItem((i) => {
      i.skills = ['test.unknown'];
      i.curriculum = ['cka.workloads.nope'];
      i.ticket = 'Reach {{goal}}.';
      i.debrief = [{ text: 'x', when: { how: 'thrice' } }];
      i.world.params = { ...i.world.params, spare: { pick: [1, 2] } };
    });
    expect(staticProblems(bad as never, { ...ctx, fileId: 'test.counter.other-01' })).toEqual([
      'id test.counter.reach-01 differs from the file name test.counter.other-01.yaml',
      'skills: test.unknown is not defined in a pack.yaml',
      'curriculum: cka.workloads.nope is not in docs/curriculum/competencies.yaml',
      'ticket: {{goal}} names no parameter',
      'debrief[0].when: "thrice" is not an option of how',
      'world.params.spare is never used',
    ]);
  });
});

describe('the runner', () => {
  test('setup runs on the topology; the baseline is plain data', () => {
    const b = buildBaseline(variantOf(counterItem(), 1), registry);
    expect(counter(b.kernel)).toEqual({ value: 1, touched: 1 });
    expect(b.entry).toEqual({ machine: 'box', user: 'tester' });
    expect(() => snapshot(b.kernel.world, registry)).not.toThrow();
  });

  test('a failing step names the list, the step and the reason', () => {
    const v = variantOf(withItem((i) => (i.world.setup = [{ bump: 1 }, { explode: 'boom' }])), 1);
    expect(() => buildBaseline(v, registry)).toThrow(new StepFailure('setup', 1, 'explode', 'boom', false));
  });

  test('a step during which the engine reports a gap fails', () => {
    const v = variantOf(withItem((i) => (i.world.setup = [{ unsupported: 'frobnicate' }])), 1);
    let failure: unknown;
    try {
      buildBaseline(v, registry);
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(StepFailure);
    expect((failure as StepFailure).gap).toBe(true);
    expect((failure as StepFailure).message).toBe('setup, step 1 (unsupported): the simulator does not support this: test: frobnicate');
  });

  test('until lets time pass until the check holds, and fails at its timeout', () => {
    const v = variantOf(withItem((i) => (i.world.setup = [{ later: 7, after: 42_000 }, { until: { assert: 'counter.atLeast', with: { value: 7 } }, timeout: '1m' }])), 1);
    const b = buildBaseline(v, registry);
    expect(counter(b.kernel).value).toBe(7);
    // Polled once a second: it noticed at the first poll after 42 s.
    expect(b.kernel.now - b.kernel.world.clock.start).toBe(42_000);
    const slow = variantOf(withItem((i) => (i.world.setup = [{ later: 7, after: 120_000 }, { until: { assert: 'counter.atLeast', with: { value: 7 } }, timeout: '1m' }])), 1);
    expect(() => buildBaseline(slow, registry)).toThrow('setup, step 2 (until): counter.atLeast did not hold within 1m: wanted the counter is at least 7; the counter is 0');
  });

  test('faults are injected through the registry', () => {
    const b = buildBaseline(variantOf(withItem((i) => (i.world.setup = [{ bump: 4 }, { fault: 'counter.zero', with: {} }])), 1), registry);
    expect(counter(b.kernel).value).toBe(0);
  });

  test('the poll interval is a second, or a sixtieth of the wait', () => {
    expect(pollInterval(30_000)).toBe(1000);
    expect(pollInterval(120_000)).toBe(2000);
    expect(pollInterval(600_000)).toBe(10_000);
  });
});

describe('the grader', () => {
  const v = variantOf(counterItem(), 1);
  const b = buildBaseline(v, registry);
  const env = { registry, entry: b.entry, baseline: b.kernel.world };
  const check = (c: Partial<Check>): Check => ({ id: 'c', title: 'C', assert: 'counter.atLeast', with: { value: 3 }, not: false, after: [], weight: 1, ...c });

  test('weights and partial credit; the item passes only when every check does', () => {
    const s = startSession(b).kernel;
    const r = grade(s, [check({ id: 'a', weight: 3, with: { value: 1 } }), check({ id: 'b', with: { value: 2 } })], env);
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([['a', 'pass'], ['b', 'fail']]);
    expect(r).toMatchObject({ passed: false, earned: 3, total: 4, score: 0.75 });
    expect(r.checks[1]).toMatchObject({ expected: 'the counter is at least 2', observed: 'the counter is 1' });
  });

  test('not inverts the result and says so', () => {
    const r = gradeCheck(startSession(b).kernel, check({ not: true, with: { value: 2 } }), env);
    expect(r).toMatchObject({ status: 'pass', expected: 'not: the counter is at least 2' });
  });

  test('after runs on the check fork; within waits on it', () => {
    const s = startSession(b).kernel;
    expect(gradeCheck(s, check({ after: [{ bump: 5 }] }), env).status).toBe('pass');
    const waits = gradeCheck(s, check({ after: [{ later: 9, after: 20_000 }], within: 30_000 }), env);
    expect(waits).toMatchObject({ status: 'pass', waited: 20_000 });
    const gives = gradeCheck(s, check({ after: [{ later: 9, after: 50_000 }], within: 30_000 }), env);
    expect(gives).toMatchObject({ status: 'fail', observed: 'the counter is 1 (still so after 30s)' });
    expect(counter(s).value).toBe(1);
  });

  test('a check that cannot be evaluated is an error, not a pass or a fail', () => {
    expect(gradeCheck(startSession(b).kernel, check({ assert: 'counter.broken', with: {} }), env)).toMatchObject({ status: 'error', error: 'cannot look' });
    expect(gradeCheck(startSession(b).kernel, check({ after: [{ unsupported: 'x' }] }), env)).toMatchObject({ status: 'error' });
    expect(gradeCheck(startSession(b).kernel, check({ after: [{ explode: 'no' }] }), env)).toMatchObject({ status: 'fail', observed: "step 1 of the check's preparation failed: no" });
  });

  test('checks do not mutate the session world', () => {
    const s = startSession(b).kernel;
    s.advance(5000);
    const before = s.hash();
    const now = s.now;
    grade(s, [check({ assert: 'counter.vandal', with: {} }), check({ after: [{ bump: 50 }], within: 60_000 }), check({ assert: 'counter.unchanged', with: {} })], env);
    expect(s.hash()).toBe(before);
    expect(s.now).toBe(now);
    expect(counter(s)).toEqual({ value: 1, touched: 1 });
  });

  test('constraint checks compare with the baseline, not with the session', () => {
    const lab = createLab(counterItem(), registry, { seed: 1 });
    lab.run([{ bump: 2 }]);
    expect(gradeCheck(lab.kernel, check({ assert: 'counter.unchanged', with: {} }), { ...env, baseline: lab.baseline.kernel.world })).toMatchObject({ status: 'fail', expected: 'the counter is still 1', observed: 'the counter is 3' });
  });
});

describe('a lab session', () => {
  test('hints are a ladder whose use is recorded; reset starts again from the baseline', () => {
    const lab = createLab(counterItem(), registry, { seed: 2 });
    const target = lab.variant.params['target'] as number;
    expect(lab.ticket).toBe(`Make the counter reach ${target}.`);
    expect(lab.check().passed).toBe(false);
    expect(lab.nextHint()).toEqual({ index: 0, text: 'Look at the counter.' });
    lab.kernel.advance(10_000);
    expect(lab.nextHint()?.index).toBe(1);
    expect(lab.nextHint()?.text).toBe(`Bump it by ${target}.`);
    expect(lab.nextHint()).toBeUndefined();
    lab.run([{ bump: target }]);
    expect(lab.check()).toMatchObject({ passed: true, score: 1 });
    const fresh = lab.reset();
    expect(counter(fresh).value).toBe(1);
    expect(lab.check().passed).toBe(false);
    expect(lab.hintsShown).toBe(3);
    expect(lab.events.map((e) => e.kind)).toEqual(['start', 'check', 'hint', 'hint', 'hint', 'check', 'reset', 'check']);
    expect(lab.events[3]).toMatchObject({ kind: 'hint', t: lab.baseline.kernel.now + 10_000 });
  });

  test('solutions are shown in the words of their steps, and viewing them is recorded', () => {
    const lab = createLab(counterItem(), registry, { seed: 1 });
    expect(lab.solutionViewed).toBe(false);
    const shown = lab.solutions().map((s) => showSolution(s, registry));
    expect(shown[0]).toMatch(/^\$ bump \d$/m);
    expect(lab.solutionViewed).toBe(true);
  });
});

describe('content validation', () => {
  test('seeds cover every value a when depends on', () => {
    const { seeds, uncovered } = seedsFor(counterItem(), 1);
    expect(uncovered).toEqual([]);
    expect(new Set(seeds.map((s) => resolveParams(counterItem(), s)['how']))).toEqual(new Set(['once', 'twice']));
  });

  test('a sound item: the untouched world fails, every solution passes', () => {
    for (const seed of [1, 2, 3]) {
      const r = runSeed(counterItem(), seed, registry);
      expect(r.problems).toEqual([]);
      expect(r.untouched?.passed).toBe(false);
      expect(r.solved.every((s) => s.report.passed)).toBe(true);
    }
  });

  test('an item already solved by its setup is refused, and so is a solution that does not solve it', () => {
    const solved = withItem((i) => (i.world.setup = [{ bump: 50 }]));
    expect(runSeed(solved, 1, registry).problems).toContain('untouched world: every check passes; the item must fail before it is solved');
    const lazy = withItem((i) => (i.solutions = [[{ bump: 1 }]]));
    const p = runSeed(lazy, 1, registry).problems;
    expect(p.some((x) => x.startsWith('solution 1: check reached fails: wanted the counter is at least'))).toBe(true);
  });

  test('a variant without enough hints or without a solution is refused', () => {
    const thin = withItem((i) => {
      i.hints = ['Only one.'];
      i.solutions = [{ name: 'Once', when: { how: 'once' }, steps: [{ bump: '{{target}}' }] }];
    });
    const seed = [1, 2, 3, 4, 5, 6].find((s) => resolveParams(thin, s)['how'] === 'twice') as number;
    expect(runSeed(thin, seed, registry).problems).toEqual(['1 hint for this variant; a lab needs at least 3', 'no reference solution applies to this variant']);
  });

  test('setup failures are reported per seed', () => {
    const r = runSeed(withItem((i) => (i.world.setup = [{ explode: 'bad setup' }])), 1, registry);
    expect(r.problems).toEqual(['setup failed: setup, step 1 (explode): bad setup']);
  });

  test('runSteps on a kernel the runner did not create still works through a hub', () => {
    const b = buildBaseline(variantOf(counterItem(), 1), registry);
    const s = startSession(b);
    runSteps(s.kernel, [{ bump: 1 }], { registry, entry: b.entry, hub: s.hub }, 'x');
    expect(counter(s.kernel).value).toBe(2);
  });
});
