// id and whoami for the simulated login, whose groups differ from the workstation user's (so the
// default line cannot be a golden transcript). The format is the one coreutils 9.4 printed on the
// workstation, captured 2026-11-16:
//   `uid=1000(USER) gid=1000(USER) groups=1000(USER),4(adm),27(sudo),44(video),107(lpadmin),992(render)`
//   `id -G` → `1000 4 27 44 107 992`, `id -Gn` → `USER adm sudo video lpadmin render`,
//   `id -Gz` → each ID followed by NUL, no newline;
//   `id USER` lists getgrouplist(3) order: the primary group, then /etc/group order.

import { describe, expect, test } from 'vitest';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { captureOutput, openSession } from '../../transcript/session.ts';

function session(user = 'student') {
  const capture = captureOutput();
  const w = defaultTranscriptWorld(capture.ports);
  return openSession(w.kernel, capture, { machine: w.machine, user });
}

describe('id', () => {
  test('the default line of the student login: uid, gid and its groups', () => {
    const s = session();
    expect(s.run('id').output).toBe('uid=1000(student) gid=1000(student) groups=1000(student),27(sudo)\n');
    expect(s.run('id -G').output).toBe('1000 27\n');
    expect(s.run('id -Gn').output).toBe('student sudo\n');
    expect(s.run('id -Gz | cat -v').output).toBe('1000^@27^@');
    expect(s.run('id student').output).toBe('uid=1000(student) gid=1000(student) groups=1000(student),27(sudo)\n');
  });

  test("a named user's groups come from /etc/group as it is now, in its order", () => {
    const s = session('root');
    expect(s.run('id').output).toBe('uid=0(root) gid=0(root) groups=0(root)\n');
    s.run("echo 'ops:x:5000:alice,student' >> /etc/group");
    expect(s.run('id student').output).toBe('uid=1000(student) gid=1000(student) groups=1000(student),27(sudo),5000(ops)\n');
    expect(s.run('id -Gn student').output).toBe('student sudo ops\n');
  });

  test('a group without a name is shown as a number in the default line', () => {
    const s = session('root');
    s.run("echo 'alice:x:1001:4242::/home/alice:/bin/bash' >> /etc/passwd; echo 'ops:x:5000:alice' >> /etc/group");
    expect(s.run('id alice').output).toBe('uid=1001(alice) gid=4242 groups=4242,5000(ops)\n');
    expect(s.run('id -G alice').output).toBe('4242 5000\n');
  });
});

describe('whoami', () => {
  test('prints the name of the effective user', () => {
    expect(session().run('whoami').output).toBe('student\n');
    expect(session('root').run('whoami').output).toBe('root\n');
  });
});
