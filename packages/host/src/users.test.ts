import { expect, test } from 'vitest';
import { asUser, bootHost } from './testing.ts';
import { credFor, formatGroup, formatPasswd, groupByGid, parseGroup, parsePasswd, userByUid } from './users.ts';

test('parsing skips malformed lines, as NSS does', () => {
  const text = 'root:x:0:0:root:/root:/bin/bash\nbroken\nbad:x:a:0:::\n\nu:x:5:6::/h:/bin/sh\n';
  expect(parsePasswd(text).map((e) => e.name)).toEqual(['root', 'u']);
  expect(parseGroup('adm:x:4:syslog,student\nnope\nusers:x:100:\n')).toEqual([
    { name: 'adm', password: 'x', gid: 4, members: ['syslog', 'student'] },
    { name: 'users', password: 'x', gid: 100, members: [] },
  ]);
});

test('format is the inverse of parse for well-formed files', () => {
  const passwd = 'root:x:0:0:root:/root:/bin/bash\nstudent:x:1000:1000:student:/home/student:/bin/bash\n';
  const group = 'root:x:0:\nsudo:x:27:student,other\n';
  expect(formatPasswd(parsePasswd(passwd))).toBe(passwd);
  expect(formatGroup(parseGroup(group))).toBe(group);
});

test('lookups follow edits to the files', () => {
  const k = bootHost();
  k.act('t', (ctx) => {
    expect(userByUid(ctx, 'node01', 1000)?.name).toBe('student');
    expect(groupByGid(ctx, 'node01', 43)?.name).toBe('utmp');
  });
  asUser(k, 'root', (fs) => fs.writeFile('/etc/group', `${fs.readFile('/etc/group')}docker:x:999:student\n`));
  k.act('t', (ctx) => {
    expect(credFor(ctx, 'node01', 'student').groups).toEqual([1000, 27, 999]);
    expect(() => credFor(ctx, 'node01', 'ghost')).toThrow('no user ghost in /etc/passwd');
  });
  asUser(k, 'root', (fs) => fs.unlink('/etc/passwd'));
  k.act('t', (ctx) => expect(userByUid(ctx, 'node01', 0)).toBeUndefined());
});
