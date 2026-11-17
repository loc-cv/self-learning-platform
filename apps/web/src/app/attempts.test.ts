import { expect, test } from 'vitest';
import type { StoredAttempt } from '../protocol.ts';
import { createAttemptKeeper, foldAttempt, longerAttempt, type AttemptRecord } from './attempts.ts';

const attempt = (): StoredAttempt => ({
  v: 1,
  item: 'lab',
  seed: 1,
  startTime: 0,
  previous: [],
  current: { v: 1, header: { topology: 't', seed: 1, startTime: 0, engine: 'e' }, inputs: [], end: 10, checkpoints: [] },
});

test('deltas extend the held attempt; a write at hide time has the latest input', () => {
  const saved: StoredAttempt[] = [];
  let asked = 0;
  const k = createAttemptKeeper((a) => (saved.push(structuredClone(a)), true), { askForFull: () => asked++, onSaved: () => undefined, delay: 60_000 });
  k.full(attempt());
  k.delta({ type: 'attempt.delta', from: 0, inputs: [{ kind: 'tty.bytes', tty: 'tty1', data: 'l', t: 11 }], checkpoints: [], end: 11 });
  k.delta({ type: 'attempt.delta', from: 1, inputs: [{ kind: 'tty.bytes', tty: 'tty1', data: 's', t: 12 }], checkpoints: [{ t: 12, inputs: 2, hash: 'h' }], end: 12 });
  expect(k.persist()).toBe(true);
  expect(saved[0]?.current.inputs.map((i) => i['data'])).toEqual(['l', 's']);
  expect(saved[0]?.current.end).toBe(12);
  expect(saved[0]?.current.checkpoints).toHaveLength(1);
  // A delta that does not follow on asks for the whole attempt and changes nothing.
  k.delta({ type: 'attempt.delta', from: 5, inputs: [], checkpoints: [], end: 20 });
  expect(asked).toBe(1);
  k.persist();
  expect(saved[1]?.current.end).toBe(12);
});

test('the server gets the whole attempt once, then only what it gained; folding the records gives the attempt back', async () => {
  const sent: AttemptRecord[] = [];
  const saved: StoredAttempt[] = [];
  const k = createAttemptKeeper((a) => (saved.push(structuredClone(a)), true), {
    askForFull: () => undefined,
    onSaved: () => undefined,
    delay: 60_000,
    sendDelay: 60_000,
    send: async (id, records) => {
      expect(id).toBe('a1');
      sent.push(...structuredClone(records));
      return true;
    },
  });
  k.begin('a1');
  k.full(attempt());
  k.delta({ type: 'attempt.delta', from: 0, inputs: [{ kind: 'tty.bytes', tty: 'tty1', data: 'l', t: 11 }], checkpoints: [], end: 11 });
  // After a lab action the worker sends everything again: one more input and a checkpoint.
  const after = attempt();
  after.current.inputs.push({ kind: 'tty.bytes', tty: 'tty1', data: 'l', t: 11 }, { kind: 'learn.action', action: 'check', t: 12 });
  after.current.checkpoints.push({ t: 12, inputs: 2, hash: 'h' });
  after.current.end = 12;
  k.full(after);
  k.persist();
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.map((r) => r.k)).toEqual(['full', 'delta', 'delta']);
  expect(saved[0]?.id).toBe('a1');
  const folded = foldAttempt(sent);
  expect(folded?.current.inputs.map((i) => i.kind)).toEqual(['tty.bytes', 'learn.action']);
  expect(folded?.current.checkpoints).toHaveLength(1);
  // A record that arrives twice (a beacon and a retry) is applied once.
  expect(foldAttempt([...sent, sent[2]])?.current.inputs).toHaveLength(2);
  // A reset starts a new current log: the whole attempt goes again.
  const reset = attempt();
  reset.previous = [after.current];
  k.full(reset);
  k.persist();
  await new Promise((r) => setTimeout(r, 0));
  expect(sent[sent.length - 1]?.k).toBe('full');
  expect(foldAttempt(sent)?.previous).toHaveLength(1);
});

test('of two copies of an attempt the longer one wins', () => {
  const short = attempt();
  const long = attempt();
  long.current.inputs.push({ kind: 'tty.bytes', tty: 'tty1', data: 'l', t: 11 });
  expect(longerAttempt(short, long)).toBe(long);
  expect(longerAttempt(long, short)).toBe(long);
  expect(longerAttempt(undefined, short)).toBe(short);
});
