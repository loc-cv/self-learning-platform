// ls behavior that golden transcripts cannot hold because it differs between machines.
//   reference: coreutils 9.4 on the workstation, captured 2026-11-16:
//   - `ls -i f g` (hard links) → `132119 f  132119 g`; `ls -im f g` → `132119 f, 132119 g`;
//     `ls -is f` → `132119 0 f`; `ls -li f` → `<ino> -rw-r--r-- 1 USER USER 0 <date> f`;
//     `ls -1id / . f` right-aligns the numbers to the widest.
//   - `ls -l /dev/null` → `crw-rw-rw- 1 root root 1, 3 <date> /dev/null`.

import { describe, expect, test } from 'vitest';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { captureOutput, openSession } from '../../transcript/session.ts';

function session(user = 'student') {
  const capture = captureOutput();
  const w = defaultTranscriptWorld(capture.ports);
  return openSession(w.kernel, capture, { machine: w.machine, user });
}

describe('ls -i', () => {
  test('hard links share an inode number; other files have their own', () => {
    const s = session();
    s.run('touch f && ln f g && touch h');
    const out = s.run('ls -i f g h').output;
    const m = /^(\d+) f {2}(\d+) g {2}(\d+) h\n$/.exec(out);
    expect(m, out).not.toBeNull();
    const [, f, g, h] = m as RegExpExecArray;
    expect(g).toBe(f);
    expect(h).not.toBe(f);
    expect(s.run('ls -im f g').output).toBe(`${f} f, ${f} g\n`);
    expect(s.run('ls -is f').output).toBe(`${f} 0 f\n`);
    expect(s.run('ls -li f').output).toMatch(new RegExp(`^${f} -rw-r--r-- 2 student student 0 \\w{3} [ \\d]\\d \\d\\d:\\d\\d f\\n$`));
  });

  test('numbers are right-aligned to the widest in the listing', () => {
    const s = session();
    const lines = s.run('ls -1id / .').output.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    const width = Math.max(...lines.map((l) => (/^ *\d+/.exec(l) as RegExpExecArray)[0].length));
    for (const l of lines) expect((/^ *\d+/.exec(l) as RegExpExecArray)[0]).toHaveLength(width);
    // The root directory of an ext4 file system is inode 2.
    expect(lines.find((l) => l.endsWith(' /'))).toMatch(/^ *2 \/$/);
  });

  test('an entry that cannot be stat-ed shows ? for its number', () => {
    const s = session();
    s.run('mkdir d && touch d/x && chmod 644 d');
    const r = s.run('ls -li d');
    expect(r.output).toBe("ls: cannot access 'd/x': Permission denied\ntotal 0\n? -????????? ? ? ? ?            ? x\n");
    expect(r.status).toBe(1);
  });
});

describe('ls -l devices', () => {
  test('a character device shows major, minor instead of a size', () => {
    const s = session();
    expect(s.run('ls -l /dev/null').output).toMatch(/^crw-rw-rw- 1 root root 1, 3 \w{3} [ \d]\d \d\d:\d\d \/dev\/null\n$/);
  });
});

describe('ls as root', () => {
  // source-derived: ls lists other users' files with their names, and root reads any directory.
  test("root lists a directory nobody may read, with the owners' names", () => {
    const s = session('root');
    s.run('mkdir /srv/locked && touch /srv/locked/a && chown 1000:1000 /srv/locked/a && chmod 000 /srv/locked');
    expect(s.run('ls /srv/locked').output).toBe('a\n');
    expect(s.run('ls -ln /srv/locked').output).toMatch(/^total 0\n-rw-r--r-- 1 1000 1000 0 /);
    expect(s.run('ls -l /srv/locked').output).toMatch(/^total 0\n-rw-r--r-- 1 student student 0 /);
  });
});
