// grep reading a stream in virtual time. Commands that do not return to the prompt cannot be golden
// transcripts; the behavior here is that of grep 3.11 and glibc's stdio:
//   docs: grep(1) --line-buffered ("Use line buffering on output. This can cause a performance
//         penalty."); setvbuf(3) (a stream that refers to a terminal is line buffered, other
//         streams are fully buffered); grep(1) -q ("Exit immediately with zero status if any
//         match is found").
//   reference: grep 3.11 behind `tail -f`, run on the workstation 2026-11-16: through `| cat`
//              nothing appears after a matching line until 4096 bytes are buffered, then exactly
//              4096 bytes are written; with --line-buffered each line passes at once; with -q the
//              pipeline ends right after the first match (coreutils 9.4 tail exits when the reader
//              of its output is gone; the simulated tail only notices at its next write).

import { describe, expect, test } from 'vitest';
import { captureOutput, openSession, type Session } from '../../transcript/session.ts';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { credFor } from '../../users.ts';
import { createFs, type Fs } from '../../vfs/fs.ts';

function start(): { s: Session; append: (text: string) => void; settle: (ms: number) => string } {
  const cap = captureOutput();
  const w = defaultTranscriptWorld(cap.ports);
  const s = openSession(w.kernel, cap, { machine: w.machine, user: w.user });
  const append = (text: string): void =>
    w.kernel.act('test', (ctx) => {
      const fs: Fs = createFs(ctx, w.machine, { cred: credFor(ctx, w.machine, 'student'), cwd: '/home/student', umask: 0o002 });
      fs.writeFile('log', text, { append: true });
    });
  const settle = (ms: number): string => {
    w.kernel.settle({ timeout: ms });
    return s.take();
  };
  return { s, append, settle };
}

describe('grep on a stream', () => {
  test('prints each matching line to the terminal as it arrives', () => {
    const { s, append, settle } = start();
    s.run("printf 'boot ok\\n' > log");
    const r = s.run('tail -f log | grep -n error', { timeout: 1000 });
    expect(r.finished).toBe(false);
    expect(r.output).toBe('');
    append('disk error 1\nall fine\n');
    expect(settle(10)).toBe('2:disk error 1\n');
    append('error 2\n');
    expect(settle(10)).toBe('4:error 2\n');
  });

  test('buffers output to a pipe unless --line-buffered', () => {
    const { s, append, settle } = start();
    s.run("printf 'start\\n' > log");
    s.run('tail -f log | grep error | cat', { timeout: 1000 });
    append('error 1\n');
    expect(settle(1000)).toBe('');
    // A full buffer is written out in blocks of 4096 bytes.
    append(`error ${'x'.repeat(4100)}\n`);
    expect(settle(10)).toBe(`error 1\nerror ${'x'.repeat(4100)}\n`.slice(0, 4096));
  });

  test('--line-buffered writes each line through a pipe', () => {
    const { s, append, settle } = start();
    s.run("printf 'start\\n' > log");
    s.run('tail -f log | grep --line-buffered error | cat', { timeout: 1000 });
    append('error 1\n');
    expect(settle(10)).toBe('error 1\n');
  });

  test('-q exits at the first match', () => {
    const { s, append, settle } = start();
    s.run("printf 'start\\n' > log");
    const r = s.run('tail -f log | grep -q error; echo status $?', { timeout: 1000 });
    expect(r.finished).toBe(false);
    append('error\n');
    // Real tail ends here already; the simulated one ends at its next write.
    const now = settle(10);
    append('more\n');
    expect(now + settle(10)).toBe('status 0\n');
  });
});
