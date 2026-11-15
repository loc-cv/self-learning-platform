// sleep blocks in virtual time and ends on SIGINT like any blocked process.
//   docs: sleep(1) of coreutils 9.4; bash(1) "EXIT STATUS" (128+n for a fatal signal n)

import { SECOND } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { captureOutput, openSession } from '../../transcript/session.ts';

function session() {
  const capture = captureOutput();
  const w = defaultTranscriptWorld(capture.ports);
  return openSession(w.kernel, capture, { machine: w.machine, user: w.user });
}

describe('sleep', () => {
  test('sleep 5 advances the virtual clock by five seconds', () => {
    const s = session();
    const before = s.kernel.now;
    const r = s.run('sleep 5');
    expect(r).toMatchObject({ finished: true, status: 0, output: '' });
    // The command line itself takes no virtual time; only the pause does.
    expect(s.kernel.now - before).toBe(5 * SECOND);
  });

  test('suffixes and several operands add up', () => {
    const s = session();
    const before = s.kernel.now;
    s.run('sleep 1m 0.5s 1.5');
    expect(s.kernel.now - before).toBe(62 * SECOND);
  });

  test('Ctrl-C interrupts it: status 130 and the clock stops where it was', () => {
    const s = session();
    const before = s.kernel.now;
    s.type('sleep 100\n');
    s.kernel.advance(3 * SECOND);
    s.type('\x03');
    const r = s.run('echo $?');
    expect(r.output.endsWith('130\n')).toBe(true);
    expect(s.kernel.now - before).toBe(3 * SECOND);
  });

  test('sleep infinity waits until interrupted', () => {
    const s = session();
    s.type('sleep infinity\n');
    s.kernel.advance(1000 * 24 * 3600 * SECOND);
    s.type('\x03');
    expect(s.run('echo $?').output.endsWith('130\n')).toBe(true);
  });
});
