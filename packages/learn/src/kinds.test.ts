// Lessons, cards and exams (docs/LEARNING_MODEL.md §2): the schema, the static rules and the run
// rules, on fixtures over the counter plugin.

import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import { counterCards, counterExam, counterItem, counterLesson, counterRegistry } from './testing.ts';
import { cardVariantOf, lessonVariantOf } from './item/variant.ts';
import type { AnyItem, CardItem, ItemKind, LessonItem } from './item/types.ts';
import { parseItem, runSeed, seedsFor, staticProblems } from './validate.ts';

const registry = counterRegistry();
const items = new Map<string, ItemKind>([['test.counter.reach-01', 'lab'], ['test.counter.lesson-01', 'lesson']]);
const ctx = { registry, competencies: new Set(['cka.workloads.deployments-rollouts']), skills: new Set(['test.counter']), items };
const problems = (item: unknown): string[] => staticProblems(item as Json, ctx);
type Loose = Record<string, unknown>;
const changed = <T extends AnyItem>(item: T, change: (i: Loose) => void): T => {
  change(item as unknown as Loose);
  return item;
};
const step = (l: Loose, i: number): Loose => (l['steps'] as Loose[])[i] as Loose;

describe('a lesson', () => {
  test('the fixture is valid for every seed that reaches each `when` value', () => {
    const lesson = counterLesson();
    expect(problems(lesson)).toEqual([]);
    const { seeds, uncovered } = seedsFor(lesson, 3);
    expect(uncovered).toEqual([]);
    for (const seed of seeds) {
      const r = runSeed(lesson, seed, registry);
      expect(r.problems).toEqual([]);
      expect(r.solved.map((s) => s.name)).toEqual(['task 1', 'task 2']);
    }
  });

  test('a variant keeps the order of the steps, drops what does not apply and substitutes', () => {
    const lesson = counterLesson();
    const short = lessonVariantOf(lesson, 1, { first: 3, way: 'short' });
    const long = lessonVariantOf(lesson, 1, { first: 3, way: 'long' });
    expect(long.steps.length).toBe(short.steps.length + 1);
    expect(short.steps.map((s) => Object.keys(s)[0])).toEqual(['text', 'figure', 'predict', 'task', 'predict', 'task', 'figure']);
    expect(short.steps[2]).toEqual({ predict: { prompt: 'What does the counter show after `bump 3`?', choices: ['3', 'One more than 3'], answer: 1, explain: 'It adds; it does not set.' } });
    expect(short.steps[3]).toMatchObject({ task: { text: 'Bump the counter by 3.', hints: ['Use `bump`.'], checks: [{ id: 'bumped', with: { value: 3 } }], solution: [{ bump: 3 }] } });
  });

  test('a task whose checks already pass, or whose solution does not make them pass, is refused', () => {
    const early = changed(counterLesson(), (l) => ((step(l, 3)['task'] as Loose)['checks'] = [{ id: 'bumped', title: 'x', assert: 'counter.atLeast', with: { value: 1 } }]));
    expect(runSeed(early, 1, registry).problems).toContain('task 1, before its solution: every check passes; the item must fail before it is solved');
    const short = changed(counterLesson(), (l) => ((step(l, 6)['task'] as Loose)['solution'] = [{ bump: 1 }]));
    expect(runSeed(short, 1, registry).problems.join('\n')).toMatch(/task 2: check ten fails: wanted the counter is at least 10/);
  });

  test('tasks run in order: a later task sees what the earlier ones did', () => {
    // Task 2 alone would need 9 more from the start; after task 1 the counter is already past 1.
    const l = changed(counterLesson(), (x) => ((step(x, 6)['task'] as Loose)['solution'] = [{ bump: 6 }]));
    // first is 2 to 4, so after setup (1) and task 1 the counter is 3 to 5, and 6 more reaches 10 only from 4 up.
    const results = [1, 2, 3, 4, 5, 6].map((s) => runSeed(l, s, registry));
    for (const r of results) expect(r.problems.length > 0).toBe(Number((r.params as { first: number }).first) < 3);
  });

  test('needs a task and a figure, a correct prediction index, and unique check ids', () => {
    const noTask = changed(counterLesson(), (l) => (l['steps'] = (l['steps'] as Loose[]).filter((s) => !('task' in s) && !('figure' in s))));
    expect(runSeed(changed(noTask, (l) => ((l['world'] as Loose)['params'] = { first: { int: { min: 2, max: 4 } }, way: { pick: ['short', 'long'] } })), 1, registry).problems).toEqual([
      'no task applies to this variant; a lesson has at least one guided task',
      'no figure applies to this variant; a lesson shows at least one',
    ]);
    expect(problems(changed(counterLesson(), (l) => ((step(l, 2)['predict'] as Loose)['answer'] = 2)))).toEqual(['steps[2].predict: `answer` is 2, and there are 2 choices']);
    expect(problems(changed(counterLesson(), (l) => delete (step(l, 2)['predict'] as Loose)['answer']))).toEqual(['steps[2].predict: `choices` need `answer`, the index of the correct one']);
    expect(problems(changed(counterLesson(), (l) => ((step(l, 5)['predict'] as Loose)['answer'] = 0)))).toEqual(['steps[5].predict: `answer` needs `choices`']);
    expect(problems(changed(counterLesson(), (l) => (((step(l, 6)['task'] as Loose)['checks'] as Loose[])[0] as Loose)['id'] = 'bumped'))).toEqual(['checks: id bumped is used twice']);
    expect(problems(changed(counterLesson(), (l) => ((step(l, 6)['task'] as Loose)['solution'] = [{ fault: 'counter.zero', with: {} }])))).toEqual(['steps[6].task.solution[0]: solutions never inject faults']);
  });

  test('the schema refuses a step with two kinds, an unknown field and a ticket', () => {
    expect(problems(changed(counterLesson(), (l) => (step(l, 0)['figure'] = step(l, 1)['figure']))).length).toBeGreaterThan(0);
    expect(problems(changed(counterLesson(), (l) => (l['ticket'] = 'Do it.'))).join('\n')).toMatch(/ticket/);
    expect(parseItem(counterLesson() as unknown as Json, registry).problems).toEqual(['a lesson is not a lab, drill or incident']);
  });
});

describe('a card', () => {
  test('the three fixtures are valid', () => {
    const cards = counterCards();
    for (const card of Object.values(cards)) {
      expect(problems(card)).toEqual([]);
      for (const seed of [1, 2, 3]) expect(runSeed(card, seed, registry).problems).toEqual([]);
    }
    const r = runSeed(cards.command, 2, registry);
    expect(r.untouched?.passed).toBe(false);
    expect(r.solved[0]?.report.passed).toBe(true);
  });

  test('a variant substitutes the prompt, the answer and the check', () => {
    const v = cardVariantOf(counterCards().command, 1, { goal: 5 });
    expect(v).toMatchObject({ prompt: 'Make the counter show at least 5.', answer: '`bump 5`', checks: [{ id: 'goal', with: { value: 5 } }], solution: [{ bump: 5 }], world: { topology: 'counter-1' } });
    expect(cardVariantOf(counterCards().choice, 1)).toMatchObject({ choices: ['3', '7', '12'], correct: 1, checks: [], solution: [] });
  });

  test('is checked one way, and what it shows needs the world it shows', () => {
    const { plain, choice, command } = counterCards();
    const p = (c: CardItem, change: (i: Loose) => void): string[] => problems(changed(c, change));
    expect(p(choice, (c) => (c['correct'] = 3))).toEqual(['card: `correct` is 3, and there are 3 choices']);
    expect(p(counterCards().choice, (c) => delete c['correct'])).toEqual(['card: `choices` need `correct`, the index of the correct one']);
    expect(p(command, (c) => Object.assign(c, { choices: ['a', 'b'], correct: 0 }))).toEqual(['a card is checked by choice or by command, not both (`choices` and `checks`)']);
    expect(p(counterCards().command, (c) => delete c['solution'])).toEqual(['`checks` and `solution` go together: the solution proves the checks can pass', 'figure: the solved world needs `solution`']);
    expect(p(plain, (c) => (c['figure'] = { kind: 'view', of: 'start', caption: 'x', alt: 'y' }))).toEqual(['figure: a view shows a world; without `world` only a diagram is possible']);
    expect(p(counterCards().plain, (c) => (c['prompt'] = 'About {{thing}}?'))).toEqual(['prompt: {{thing}} names no parameter']);
  });

  test('checks that pass untouched are refused, as for a lab', () => {
    const c = changed(counterCards().command, (x) => (((x['checks'] as Loose[])[0] as Loose)['with'] = { value: 0 }));
    expect(runSeed(c, 1, registry).problems).toContain('untouched world: every check passes; the item must fail before it is solved');
  });
});

describe('an exam', () => {
  test('is a definition: tasks name lab-like items, each once', () => {
    expect(problems(counterExam())).toEqual([]);
    expect(problems(changed(counterExam(), (e) => (e['tasks'] = [{ item: 'test.counter.lesson-01', weight: 1 }, { item: 'test.counter.gone-01', weight: 1 }, { item: 'test.counter.reach-01', weight: 2 }, { item: 'test.counter.reach-01', weight: 2 }])))).toEqual([
      'tasks[0]: test.counter.lesson-01 is a lesson; an exam task is a lab, a drill or an incident',
      'tasks[1]: no item test.counter.gone-01',
      'tasks[3]: test.counter.reach-01 is a task twice',
    ]);
  });

  test('carries no figure, hint or skill of its own', () => {
    for (const field of ['figure', 'hints', 'skills', 'debrief']) expect(problems(changed(counterExam(), (e) => (e[field] = [])))).not.toEqual([]);
  });
});

test('a lab is still a lab: the lab-like layout did not loosen', () => {
  expect(problems(counterItem())).toEqual([]);
  expect(problems(changed(counterItem(), (i) => (i['steps'] = [{ text: 'x' }]))).length).toBeGreaterThan(0);
  expect(problems(changed(counterItem(), (i) => (i['kind'] = 'quiz'))).length).toBeGreaterThan(0);
  const lesson: LessonItem = counterLesson();
  expect(lesson.kind).toBe('lesson');
});
