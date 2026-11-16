import { expect, test } from 'vitest';
import type { StoredAttempt } from '../protocol.ts';
import { createAttemptKeeper } from './attempts.ts';

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
