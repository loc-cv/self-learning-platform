// The layouts of lessons, cards and exams (docs/LEARNING_MODEL.md §2). They reuse the parts of
// the lab-like item by reference: `#/$defs/world`, `figure`, `check`, `steps`, `when` and the
// header fields. schema.ts puts them into item.schema.json next to `scenarioItem`.

import type { Json } from '@simlab/kernel';

type Schema = { [key: string]: Json };

const TEXT: Schema = { type: 'string', minLength: 1 };
const WHEN: Schema = { $ref: '#/$defs/when' };
const CHOICES: Schema = { type: 'array', minItems: 2, items: TEXT };
const INDEX: Schema = { type: 'integer', minimum: 0 };
const CHECKS: Schema = { type: 'array', minItems: 1, items: { $ref: '#/$defs/check' } };
const header = (name: string): Schema => ({ $ref: `#/$defs/header/properties/${name}` });
const HEADER: Schema = { id: header('id'), title: header('title'), skills: header('skills'), curriculum: header('curriculum'), difficulty: header('difficulty'), targetMinutes: header('targetMinutes') };
const HEADER_REQUIRED = ['id', 'kind', 'title', 'skills', 'curriculum', 'difficulty', 'targetMinutes'];

const block = (key: string, value: Schema): Schema => ({ type: 'object', properties: { [key]: value, when: WHEN }, required: [key], additionalProperties: false });

export const KIND_DEFS: Schema = {
  prediction: {
    description: 'A prediction prompt: answered before the learner sees what happens. With `choices`, `answer` is the index of the correct one.',
    type: 'object',
    properties: { prompt: TEXT, choices: CHOICES, answer: INDEX, explain: TEXT },
    required: ['prompt', 'explain'],
    additionalProperties: false,
  },
  lessonTask: {
    description: "A guided task in the lesson's live world: its checks fail before `solution` runs and pass after.",
    type: 'object',
    properties: { text: TEXT, hints: { type: 'array', minItems: 1, items: TEXT }, checks: CHECKS, solution: { $ref: '#/$defs/steps' } },
    required: ['text', 'checks', 'solution'],
    additionalProperties: false,
  },
  lessonStep: {
    oneOf: [block('text', TEXT), block('figure', { $ref: '#/$defs/figure' }), block('predict', { $ref: '#/$defs/prediction' }), block('task', { $ref: '#/$defs/lessonTask' })],
  },
  lessonItem: {
    type: 'object',
    properties: { ...HEADER, kind: { const: 'lesson' }, world: { $ref: '#/$defs/world' }, steps: { type: 'array', minItems: 1, items: { $ref: '#/$defs/lessonStep' } } },
    required: [...HEADER_REQUIRED, 'world', 'steps'],
    additionalProperties: false,
  },
  cardItem: {
    type: 'object',
    properties: {
      ...HEADER,
      kind: { const: 'card' },
      world: { $ref: '#/$defs/world' },
      prompt: TEXT,
      figure: { $ref: '#/$defs/figure' },
      answer: TEXT,
      choices: CHOICES,
      correct: INDEX,
      checks: CHECKS,
      solution: { $ref: '#/$defs/steps' },
    },
    required: [...HEADER_REQUIRED, 'prompt', 'answer'],
    additionalProperties: false,
  },
  examItem: {
    description: 'An exam is a definition only: tasks are lab-like items by id, shown without figures, hints or debrief (the mode is phase 31).',
    type: 'object',
    properties: {
      id: header('id'),
      kind: { const: 'exam' },
      title: header('title'),
      minutes: { type: 'number', exclusiveMinimum: 0 },
      passPercent: { type: 'number', minimum: 0, maximum: 100 },
      tasks: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: { item: header('id'), weight: { type: 'number', exclusiveMinimum: 0 } }, required: ['item', 'weight'], additionalProperties: false },
      },
    },
    required: ['id', 'kind', 'title', 'minutes', 'passPercent', 'tasks'],
    additionalProperties: false,
  },
};
