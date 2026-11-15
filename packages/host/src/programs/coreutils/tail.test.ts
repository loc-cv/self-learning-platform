// tail -f and -F in virtual time. A command that never returns to the prompt cannot be a golden
// transcript; the expected output and messages here are those of coreutils 9.4 tail, captured
// 2026-11-16 by running the real tail in the background while appending to, truncating,
// removing, recreating and replacing the file:
//   `tail -f f g`: "==> f <==" headers on every switch between files, appended text as it
//   arrives (a line written in two pieces needs no new header), "tail: f: file truncated";
//   `tail -F f`: "tail: 'f' has become inaccessible: No such file or directory",
//   "tail: 'f' has appeared;  following new file", "tail: 'f' has been replaced;  following new
//   file", each followed by the whole new file; `tail --follow=name f` on removal:
//   "tail: f: No such file or directory" and "tail: no files remaining".

import { describe, expect, test } from 'vitest';
import { captureOutput, openSession, type Session } from '../../transcript/session.ts';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { credFor } from '../../users.ts';
import { createFs, type Fs } from '../../vfs/fs.ts';

function start(): { s: Session; fs: (fn: (fs: Fs) => void) => void; settle: (ms: number) => string } {
  const cap = captureOutput();
  const w = defaultTranscriptWorld(cap.ports);
  const s = openSession(w.kernel, cap, { machine: w.machine, user: w.user });
  const fs = (fn: (fs: Fs) => void): void =>
    w.kernel.act('test', (ctx) => fn(createFs(ctx, w.machine, { cred: credFor(ctx, w.machine, 'student'), cwd: '/home/student', umask: 0o002 })));
  const settle = (ms: number): string => {
    w.kernel.settle({ timeout: ms });
    return s.take();
  };
  return { s, fs, settle };
}

describe('tail -f', () => {
  test('prints the last lines, then what is appended, until interrupted', () => {
    const { s, fs, settle } = start();
    s.run("printf '1\\n2\\n3\\n' > f");
    const r = s.run('tail -n 2 -f f', { timeout: 5000 });
    expect(r.finished).toBe(false);
    expect(r.output).toBe('2\n3\n');
    fs((f) => f.writeFile('f', '4\n', { append: true }));
    expect(settle(10)).toBe('4\n');
    fs((f) => f.writeFile('f', 'part', { append: true }));
    expect(settle(10)).toBe('part');
    fs((f) => f.writeFile('f', 'ial\n', { append: true }));
    expect(settle(10)).toBe('ial\n');
    // Nothing happens while nothing is written.
    expect(settle(60_000)).toBe('');
    s.type('\x03');
    settle(10);
    expect(s.run('echo $?').output).toBe('130\n');
  });

  test('reports truncation and starts over', () => {
    const { s, fs, settle } = start();
    s.run("printf 'old line\\n' > f");
    s.run('tail -f f', { timeout: 1000 });
    fs((f) => f.writeFile('f', 'new\n'));
    expect(settle(10)).toBe('tail: f: file truncated\nnew\n');
  });

  test('`: > f` alone is noticed as a truncation', () => {
    const { s, fs, settle } = start();
    s.run("printf 'old line\\n' > 'a b'");
    s.run("tail -f 'a b'", { timeout: 1000 });
    fs((f) => f.open('a b', { write: true, truncate: true }));
    expect(settle(10)).toBe("tail: 'a b': file truncated\n");
    fs((f) => f.writeFile('a b', 'x\n', { append: true }));
    expect(settle(10)).toBe('x\n');
  });

  test('with several files, a header whenever output switches files', () => {
    const { s, fs, settle } = start();
    s.run("printf '1\\n2\\n' > f; printf 'x\\n' > g");
    const r = s.run('tail -f f g', { timeout: 1000 });
    expect(r.output).toBe('==> f <==\n1\n2\n\n==> g <==\nx\n');
    fs((f) => f.writeFile('f', '3\n', { append: true }));
    expect(settle(1500)).toBe('\n==> f <==\n3\n');
    fs((f) => f.writeFile('g', 'y', { append: true }));
    expect(settle(1500)).toBe('\n==> g <==\ny');
    fs((f) => f.writeFile('g', 'z\n', { append: true }));
    expect(settle(1500)).toBe('z\n');
  });

  test('by descriptor, a removed file is followed no more by name', () => {
    const { s, fs, settle } = start();
    s.run("printf '1\\n' > f");
    s.run('tail -f f', { timeout: 1000 });
    fs((f) => f.unlink('f'));
    fs((f) => f.writeFile('f', 'again\n'));
    expect(settle(5000)).toBe('');
  });

  test('a file that cannot be opened leaves nothing to follow', () => {
    const { s } = start();
    const r = s.run('tail -f nope');
    expect(r.output).toBe("tail: cannot open 'nope' for reading: No such file or directory\ntail: no files remaining\n");
    expect(r.status).toBe(1);
  });
});

describe('streaming filters after tail -f', () => {
  test('cut, tr, uniq and tee pass each line on as it arrives; head -n 2 ends the pipeline', () => {
    const { s, fs, settle } = start();
    s.run("printf 'a:1\\n' > log");
    const r = s.run('tail -f log | cut -d: -f1 | tr a-z A-Z | uniq -c | tee copy', { timeout: 1000 });
    // uniq holds a group until a different line shows that it is complete.
    expect(r.output).toBe('');
    fs((f) => f.writeFile('log', 'b:2\n', { append: true }));
    expect(settle(10)).toBe('      1 A\n');
    fs((f) => f.writeFile('log', 'b:3\nc:4\n', { append: true }));
    expect(settle(10)).toBe('      2 B\n');
    s.type('\x03');
    settle(10);
    const h = s.run('tail -f log | head -n 2', { timeout: 1000 });
    expect(h.output).toBe('a:1\nb:2\n');
    // head exited after two lines; the pipeline ends when tail dies of SIGPIPE at its next write.
    expect(h.finished).toBe(false);
    fs((f) => f.writeFile('log', 'd:5\n', { append: true }));
    settle(10);
    const after = s.run('echo $?', { timeout: 1000 });
    expect(after.finished).toBe(true);
    expect(after.output).toBe('0\n');
  });
});

describe('tail -F', () => {
  test('follows the name through removal, re-creation and replacement', () => {
    const { s, fs, settle } = start();
    s.run("printf '1\\n' > f");
    expect(s.run('tail -F f', { timeout: 1000 }).output).toBe('1\n');
    fs((f) => f.writeFile('f', '2\n', { append: true }));
    expect(settle(10)).toBe('2\n');
    fs((f) => f.unlink('f'));
    expect(settle(1500)).toBe("tail: 'f' has become inaccessible: No such file or directory\n");
    fs((f) => f.writeFile('f', 'back\n'));
    expect(settle(1500)).toBe("tail: 'f' has appeared;  following new file\nback\n");
    fs((f) => {
      f.writeFile('f.new', 'r\n');
      f.rename('f.new', 'f');
    });
    expect(settle(1500)).toBe("tail: 'f' has been replaced;  following new file\nr\n");
    fs((f) => f.writeFile('f', 'x\n', { append: true }));
    expect(settle(10)).toBe('x\n');
  });

  test('waits for a file that does not exist yet', () => {
    const { s, fs, settle } = start();
    const r = s.run('tail -F later', { timeout: 1000 });
    expect(r.output).toBe("tail: cannot open 'later' for reading: No such file or directory\n");
    fs((f) => f.writeFile('later', 'hi\n'));
    expect(settle(1500)).toBe("tail: 'later' has appeared;  following new file\nhi\n");
  });

  test('--follow=name without retry gives up on a removed file', () => {
    const { s, fs, settle } = start();
    s.run("printf '1\\n' > f");
    s.run('tail --follow=name f', { timeout: 1000 });
    fs((f) => f.unlink('f'));
    expect(settle(1500)).toBe('tail: f: No such file or directory\ntail: no files remaining\n');
  });
});
