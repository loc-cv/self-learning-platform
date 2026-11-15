import { expect, test } from 'vitest';
import { createRegistry, type Contribution, type Plugin } from './registry.ts';

const noop = () => {};

test('plugins come after what they require, otherwise in the given order', () => {
  const r = createRegistry([
    { name: 'k8s', requires: ['host'] },
    { name: 'learn' },
    { name: 'host' },
  ]);
  expect(r.plugins.map((p) => p.name)).toEqual(['kernel', 'host', 'k8s', 'learn']);
});

test('missing requirements, cycles and duplicates are refused', () => {
  expect(() => createRegistry([{ name: 'a', requires: ['b'] }])).toThrow('plugin a requires b, which is not registered');
  expect(() =>
    createRegistry([
      { name: 'a', requires: ['b'] },
      { name: 'b', requires: ['a'] },
    ]),
  ).toThrow('cycle: a → b → a');
  expect(() => createRegistry([{ name: 'a' }, { name: 'a' }])).toThrow('registered twice');
  expect(() =>
    createRegistry([
      { name: 'a', handlers: [{ type: 'x', handle: noop }] },
      { name: 'b', handlers: [{ type: 'x', handle: noop }] },
    ]),
  ).toThrow('event type x already has a handler');
  expect(() =>
    createRegistry([
      { name: 'a', contributions: { check: [{ name: 'c' }] } },
      { name: 'b', contributions: { check: [{ name: 'c' }] } },
    ]),
  ).toThrow('check c is already registered');
  const badSlice: Plugin = { name: 'a', slice: { name: 'b', version: 1, init: () => ({}), adopt: noop } };
  expect(() => createRegistry([badSlice])).toThrow('slice must be named after it');
});

test('contributions are found by kind and name and listed by name', () => {
  interface Prog extends Contribution {
    size: number;
  }
  const r = createRegistry([
    { name: 'host', contributions: { program: [{ name: 'ls', size: 1 }, { name: 'cat', size: 2 }] } },
    { name: 'k8s', contributions: { program: [{ name: 'kubectl', size: 3 }] } },
  ]);
  expect(r.get<Prog>('program', 'cat')?.size).toBe(2);
  expect(r.get('program', 'vim')).toBeUndefined();
  expect(r.get('check', 'x')).toBeUndefined();
  expect(r.list<Prog>('program').map((p) => p.name)).toEqual(['cat', 'kubectl', 'ls']);
  expect(r.list('check')).toEqual([]);
});

test('an unknown event type or input kind is an engine bug', () => {
  const r = createRegistry([]);
  expect(() => r.handler('nope')).toThrow('no handler registered for event type nope');
  expect(() => r.input('nope')).toThrow('no handler registered for input kind nope');
  expect(r.input('learn.action').kind).toBe('learn.action');
});

test('the registry is immutable', () => {
  const r = createRegistry([]);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.plugins)).toBe(true);
});
