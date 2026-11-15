// VFS behavior beyond what an unprivileged capture can show (linux-reference.test.ts covers that):
// root, a second user, sticky directories, umask and set-group-ID, timestamps, link counts, change
// notification, generated files and executable stubs. Sources are cited per test.

import { describe, expect, test } from 'vitest';
import { formatRfc3339, type Plugin } from '@simlab/kernel';
import { asUser, bootHost } from '../testing.ts';
import { formatPasswd, parsePasswd, passwdEntries } from '../users.ts';
import { FsError, isFsError, UnsupportedError, strerror } from './errno.ts';
import type { FileProviderSpec } from './provider.ts';
import type { Fs } from './fs.ts';

const code = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (isFsError(e)) return e.code;
    if (e instanceof UnsupportedError) return 'unsupported';
    throw e;
  }
};

/** Adds user `other` (uid 1001, group 1001) by editing /etc/passwd and /etc/group as root. */
function addOther(fs: Fs): void {
  const passwd = parsePasswd(fs.readFile('/etc/passwd'));
  passwd.push({ name: 'other', password: 'x', uid: 1001, gid: 1001, gecos: 'other', home: '/home/other', shell: '/bin/bash' });
  fs.writeFile('/etc/passwd', formatPasswd(passwd));
  fs.writeFile('/etc/group', `${fs.readFile('/etc/group')}other:x:1001:\n`);
}

describe('errors', () => {
  test('carry the errno name, number and glibc message', () => {
    const k = bootHost();
    const e = asUser(k, 'student', (fs) => {
      try {
        fs.stat('/nope');
      } catch (err) {
        return err;
      }
      return undefined;
    });
    expect(e).toBeInstanceOf(FsError);
    expect(e).toMatchObject({ code: 'ENOENT', errno: 2, syscall: 'stat', path: '/nope' });
    expect(strerror('ENOENT')).toBe('No such file or directory');
    expect(strerror('ELOOP')).toBe('Too many levels of symbolic links');
  });
});

describe('permissions', () => {
  test('root reads and writes anything but executes only what has an execute bit', () => {
    const k = bootHost();
    asUser(k, 'root', (fs) => {
      fs.writeFile('/root/secret', 's', { mode: 0o000 });
      expect(fs.readFile('/root/secret')).toBe('s');
      fs.writeFile('/root/secret', 't');
      expect(code(() => fs.checkExec('/root/secret'))).toBe('EACCES');
      fs.chmod('/root/secret', 0o001);
      expect(code(() => fs.checkExec('/root/secret'))).toBe('ok');
      fs.mkdir('/root/locked', 0o000);
      expect(fs.readdir('/root/locked')).toEqual([]);
    });
    expect(asUser(k, 'student', (fs) => code(() => fs.stat('/root/secret')))).toBe('EACCES');
    expect(asUser(k, 'student', (fs) => code(() => fs.readdir('/root')))).toBe('EACCES');
  });

  test('only one permission class applies: an owner without a bit is denied even if others have it', () => {
    // path_resolution(7) "Permissions": the owner's bits are used if the uid matches, and only those.
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      fs.writeFile('/tmp/f', 'x', { mode: 0o044 });
      expect(code(() => fs.readFile('/tmp/f'))).toBe('EACCES');
    });
  });

  test('group membership comes from /etc/group', () => {
    const k = bootHost();
    asUser(k, 'root', (fs) => {
      fs.writeFile('/srv/sudoers-only', 'x', { mode: 0o640 });
      fs.chown('/srv/sudoers-only', 0, 27);
    });
    expect(asUser(k, 'student', (fs) => fs.readFile('/srv/sudoers-only'))).toBe('x');
    asUser(k, 'root', (fs) => fs.writeFile('/etc/group', fs.readFile('/etc/group').replace('sudo:x:27:student', 'sudo:x:27:')));
    expect(asUser(k, 'student', (fs) => code(() => fs.readFile('/srv/sudoers-only')))).toBe('EACCES');
  });

  test('a sticky directory protects entries from other users', () => {
    // unlink(2), rename(2) EPERM: sticky directory, caller owns neither the entry nor the directory.
    const k = bootHost();
    asUser(k, 'root', addOther);
    asUser(
      k,
      'student',
      (fs) => {
        fs.writeFile('/tmp/mine', 'x', { mode: 0o666 });
        fs.mkdir('/tmp/mydir', 0o777);
      },
      { umask: 0 },
    );
    asUser(k, 'other', (fs) => {
      expect(code(() => fs.unlink('/tmp/mine'))).toBe('EPERM');
      expect(code(() => fs.rename('/tmp/mine', '/tmp/stolen'))).toBe('EPERM');
      expect(code(() => fs.rmdir('/tmp/mydir'))).toBe('EPERM');
      fs.writeFile('/tmp/theirs', 'y');
      fs.unlink('/tmp/theirs');
    });
    asUser(k, 'root', (fs) => fs.unlink('/tmp/mine'));
  });

  test('protected_regular: opening someone else\'s file in /tmp for writing fails, even for root', () => {
    // fs.protected_regular = 2 on Ubuntu; may_create_in_sticky has no capability exemption.
    const k = bootHost();
    asUser(k, 'root', addOther);
    asUser(k, 'student', (fs) => fs.writeFile('/tmp/mine', 'x', { mode: 0o666 }), { umask: 0 });
    expect(asUser(k, 'other', (fs) => code(() => fs.writeFile('/tmp/mine', 'y')))).toBe('EACCES');
    expect(asUser(k, 'root', (fs) => code(() => fs.writeFile('/tmp/mine', 'y')))).toBe('EACCES');
    expect(asUser(k, 'student', (fs) => code(() => fs.writeFile('/tmp/mine', 'y')))).toBe('ok');
    // Outside a sticky directory the mode decides alone.
    asUser(k, 'student', (fs) => fs.writeFile('/home/student/open', 'x', { mode: 0o666 }), { umask: 0 });
    asUser(k, 'student', (fs) => fs.chmod('/home/student', 0o755));
    expect(asUser(k, 'other', (fs) => code(() => fs.writeFile('/home/student/open', 'y')))).toBe('ok');
  });

  test('protected_symlinks: links in /tmp are followed only by their owner or the directory owner\'s', () => {
    const k = bootHost();
    asUser(k, 'root', addOther);
    asUser(k, 'student', (fs) => {
      fs.writeFile('/home/student/target', 'secret', { mode: 0o644 });
      fs.chmod('/home/student', 0o755);
      fs.symlink('/home/student/target', '/tmp/link');
      expect(fs.readFile('/tmp/link')).toBe('secret');
    });
    expect(asUser(k, 'other', (fs) => code(() => fs.readFile('/tmp/link')))).toBe('EACCES');
    expect(asUser(k, 'root', (fs) => code(() => fs.readFile('/tmp/link')))).toBe('EACCES');
    expect(asUser(k, 'other', (fs) => fs.readlink('/tmp/link'))).toBe('/home/student/target');
    asUser(k, 'root', (fs) => fs.symlink('/home/student/target', '/tmp/rootlink'));
    expect(asUser(k, 'other', (fs) => fs.readFile('/tmp/rootlink'))).toBe('secret');
  });

  test('chmod and chown rules for unprivileged users', () => {
    const k = bootHost();
    asUser(k, 'root', addOther);
    asUser(k, 'student', (fs) => {
      fs.writeFile('/tmp/f', 'x');
      // chmod(2): S_ISGID is dropped silently when the caller is not in the file's group.
      fs.chmod('/tmp/f', 0o2755);
      expect(fs.stat('/tmp/f').mode).toBe(0o2755);
      fs.chown('/tmp/f', -1, 27);
      expect(fs.stat('/tmp/f').gid).toBe(27);
    });
    asUser(k, 'other', (fs) => {
      expect(code(() => fs.chmod('/tmp/f', 0o777))).toBe('EPERM');
      expect(code(() => fs.chown('/tmp/f', -1, 1001))).toBe('EPERM');
      fs.writeFile('/tmp/g', 'x');
      fs.chmod('/tmp/g', 0o2755);
      expect(fs.stat('/tmp/g').mode).toBe(0o2755);
    });
    asUser(k, 'root', (fs) => fs.chown('/tmp/g', -1, 27));
    asUser(k, 'other', (fs) => {
      fs.chmod('/tmp/g', 0o2755);
      expect(fs.stat('/tmp/g').mode).toBe(0o755);
    });
  });

  test('protected hard links: no linking to a file you cannot read and write', () => {
    // proc_sys_fs(5) protected_hardlinks; Ubuntu sets fs.protected_hardlinks = 1.
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      expect(code(() => fs.link('/etc/passwd', '/tmp/pw'))).toBe('EPERM');
      fs.writeFile('/tmp/own', 'x');
      fs.link('/tmp/own', '/tmp/own2');
    });
    asUser(k, 'root', (fs) => fs.link('/etc/passwd', '/tmp/pw'));
  });

  test('utimes: any time for the owner, only "now" for a writer, nothing for others', () => {
    // utimensat(2): EPERM for an explicit time unless owner; EACCES for UTIME_NOW without write access.
    const k = bootHost();
    asUser(k, 'root', addOther);
    asUser(
      k,
      'student',
      (fs) => {
        fs.writeFile('/tmp/shared', 'x', { mode: 0o666 });
        fs.writeFile('/tmp/private', 'x', { mode: 0o644 });
        fs.utimes('/tmp/private', 0);
        expect(fs.stat('/tmp/private').mtime).toBe(0);
      },
      { umask: 0 },
    );
    asUser(k, 'other', (fs) => {
      fs.utimes('/tmp/shared');
      expect(code(() => fs.utimes('/tmp/shared', 5))).toBe('EPERM');
      expect(code(() => fs.utimes('/tmp/private'))).toBe('EACCES');
    });
  });
});

describe('creation', () => {
  test('modes follow the umask; new entries take the set-group-ID directory\'s group', () => {
    const k = bootHost();
    asUser(
      k,
      'student',
      (fs) => {
        fs.writeFile('/tmp/a', '');
        fs.mkdir('/tmp/d');
        expect(fs.stat('/tmp/a').mode).toBe(0o644);
        expect(fs.stat('/tmp/d').mode).toBe(0o755);
        expect(fs.stat('/tmp/a').gid).toBe(1000);
      },
      { umask: 0o022 },
    );
    // /var/mail is 2775 root:mail on Ubuntu (base-files postinst).
    asUser(k, 'root', (fs) => {
      fs.writeFile('/var/mail/student', '');
      fs.mkdir('/var/mail/sub');
      expect(fs.stat('/var/mail/student').gid).toBe(8);
      expect(fs.stat('/var/mail/sub').gid).toBe(8);
      expect(fs.stat('/var/mail/sub').mode & 0o2000).toBe(0o2000);
      expect(fs.stat('/var/mail/student').mode & 0o2000).toBe(0);
    });
  });

  test('a regular user may not create device nodes', () => {
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      expect(code(() => fs.createGenerated('/tmp/null', 'host.null', { mode: 0o666, device: { major: 1, minor: 3 } }))).toBe('EPERM');
    });
  });
});

describe('timestamps and link counts', () => {
  test('writes, metadata changes and entry changes move mtime and ctime from the virtual clock', () => {
    const k = bootHost();
    const t0 = k.now;
    asUser(k, 'student', (fs) => fs.writeFile('/tmp/f', 'a'));
    k.advance(60_000);
    asUser(k, 'student', (fs) => {
      expect(fs.stat('/tmp/f').mtime).toBe(t0);
      fs.writeFile('/tmp/f', 'b', { append: true });
      expect(fs.readFile('/tmp/f')).toBe('ab');
      expect(fs.stat('/tmp/f')).toMatchObject({ mtime: t0 + 60_000, ctime: t0 + 60_000, size: 2 });
    });
    k.advance(1000);
    asUser(k, 'student', (fs) => {
      fs.chmod('/tmp/f', 0o600);
      expect(fs.stat('/tmp/f')).toMatchObject({ mtime: t0 + 60_000, ctime: t0 + 61_000 });
      fs.rename('/tmp/f', '/tmp/g');
      expect(fs.stat('/tmp').mtime).toBe(t0 + 61_000);
    });
    expect(formatRfc3339(t0)).toBe('2026-11-13T09:00:00Z');
  });

  test('directory link counts follow subdirectories through mkdir, rename and rmdir', () => {
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      const home = '/home/student';
      const base = fs.stat(home).nlink;
      fs.mkdir(`${home}/a`);
      fs.mkdir(`${home}/b`);
      fs.mkdir(`${home}/a/x`);
      expect(fs.stat(home).nlink).toBe(base + 2);
      expect(fs.stat(`${home}/a`).nlink).toBe(3);
      fs.rename(`${home}/a/x`, `${home}/b/x`);
      expect([fs.stat(`${home}/a`).nlink, fs.stat(`${home}/b`).nlink]).toEqual([2, 3]);
      expect(fs.realpath(`${home}/b/x/..`)).toBe(`${home}/b`);
      fs.mkdir(`${home}/empty`);
      fs.rename(`${home}/b`, `${home}/empty`); // replaces an empty directory
      expect(fs.stat(home).nlink).toBe(base + 2);
      fs.rmdir(`${home}/empty/x`);
      fs.rmdir(`${home}/empty`);
      fs.rmdir(`${home}/a`);
      expect(fs.stat(home).nlink).toBe(base);
    });
  });

  test('a file lives until its last link is removed', () => {
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      fs.writeFile('/tmp/f', 'data');
      fs.link('/tmp/f', '/tmp/g');
      const ino = fs.stat('/tmp/f').ino;
      fs.unlink('/tmp/f');
      expect(fs.stat('/tmp/g')).toMatchObject({ ino, nlink: 1 });
      expect(fs.readFile('/tmp/g')).toBe('data');
      fs.unlink('/tmp/g');
      expect(fs.machine.vfs.inodes[ino]).toBeUndefined();
    });
  });
});

describe('paths', () => {
  test('relative paths resolve from the working directory; .. stops at the root', () => {
    const k = bootHost();
    asUser(
      k,
      'student',
      (fs) => {
        expect(fs.realpath('.')).toBe('/home/student');
        expect(fs.realpath('../../../../..')).toBe('/');
        // `..` is physical: /bin is a link to usr/bin, so /bin/.. is /usr.
        expect(fs.realpath('/bin/..')).toBe('/usr');
        expect(code(() => fs.realpath('/bin/../etc'))).toBe('ENOENT');
        expect(fs.realpath('/bin')).toBe('/usr/bin');
        expect(fs.realpath('/var/run/lock')).toBe('/run/lock');
        expect(fs.realpath('.bashrc')).toBe('/home/student/.bashrc');
        expect(fs.realpath('/etc/os-release')).toBe('/usr/lib/os-release');
      },
      { cwd: '/home/student' },
    );
  });

  test('a symlink whose target ends in a slash must name a directory', () => {
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      fs.writeFile('/tmp/f', '');
      fs.symlink('/tmp/f/', '/tmp/l');
      fs.symlink('/tmp/', '/tmp/t');
      expect(code(() => fs.stat('/tmp/l'))).toBe('ENOTDIR');
      expect(fs.stat('/tmp/t').type).toBe('dir');
      fs.symlink('', '/tmp/empty');
      expect(code(() => fs.stat('/tmp/empty'))).toBe('ENOENT');
    });
  });

  test('searching a directory needs execute permission on every component, including through symlinks', () => {
    const k = bootHost();
    asUser(k, 'root', (fs) => {
      fs.mkdir('/srv/closed', 0o700);
      fs.writeFile('/srv/closed/f', '');
      fs.symlink('/srv/closed/f', '/tmp/via');
    });
    expect(asUser(k, 'student', (fs) => code(() => fs.stat('/tmp/via')))).toBe('EACCES');
    expect(asUser(k, 'student', (fs) => code(() => fs.lstat('/tmp/via')))).toBe('ok');
  });
});

describe('generated files and executable stubs', () => {
  const clockFile: FileProviderSpec = {
    name: 'test.clock',
    read: (ctx, machine) => `${machine.hostname} ${ctx.now}\n`,
  };
  const plugin: Plugin = { name: 'test', contributions: { fileProvider: [clockFile] } };

  test('/dev/null reads empty and swallows writes', () => {
    const k = bootHost();
    asUser(k, 'student', (fs) => {
      expect(fs.stat('/dev/null')).toMatchObject({ type: 'char', mode: 0o666, rdev: { major: 1, minor: 3 }, size: 0 });
      fs.writeFile('/dev/null', 'gone');
      fs.writeFile('/dev/null', 'gone', { append: true });
      expect(fs.readFile('/dev/null')).toBe('');
    });
  });

  test('content is computed from the world on each read; unsupported writes are gaps, not errors', () => {
    const k = bootHost([plugin]);
    asUser(k, 'root', (fs) => fs.createGenerated('/run/clock', 'test.clock', { mode: 0o644 }));
    const first = asUser(k, 'student', (fs) => fs.readFile('/run/clock'));
    k.advance(5);
    const second = asUser(k, 'student', (fs) => fs.readFile('/run/clock'));
    expect([first, second]).toEqual([`node01 ${k.now - 5}\n`, `node01 ${k.now}\n`]);
    expect(asUser(k, 'student', (fs) => code(() => fs.writeFile('/run/clock', 'x')))).toBe('EACCES');
    expect(asUser(k, 'root', (fs) => code(() => fs.writeFile('/run/clock', 'x')))).toBe('unsupported');
  });

  test('a program stub resolves for exec, has a size, and is not readable as text', () => {
    const k = bootHost();
    asUser(k, 'root', (fs) => fs.installProgram('/usr/bin/ls', 'ls', { size: 138208 }));
    asUser(k, 'student', (fs) => {
      expect(fs.stat('/bin/ls')).toMatchObject({ type: 'file', kind: 'program', size: 138208, mode: 0o755, uid: 0 });
      expect(fs.checkExec('/bin/ls')).toMatchObject({ type: 'program', program: 'ls' });
      expect(code(() => fs.readFile('/bin/ls'))).toBe('unsupported');
      expect(code(() => fs.writeFile('/bin/ls', 'x'))).toBe('EACCES');
    });
    asUser(k, 'root', (fs) => {
      expect(code(() => fs.writeFile('/usr/bin/ls', 'x', { append: true }))).toBe('unsupported');
      fs.writeFile('/usr/bin/ls', '#!/bin/sh\n');
      expect(fs.stat('/usr/bin/ls')).toMatchObject({ kind: 'file', size: 10, mode: 0o755 });
    });
  });
});

describe('change notification and worlds', () => {
  test('changing an entry publishes the directory\'s topic', () => {
    const woken: string[] = [];
    const watcher: Plugin = { name: 'watch', handlers: [{ type: 'watch.wake', handle: (_ctx, p) => void woken.push(String(p)) }] };
    const k = bootHost([watcher]);
    const etc = asUser(k, 'root', (fs) => fs.stat('/etc').ino);
    k.act('t', (ctx) => ctx.subscribe(`host.vfs:node01:${etc}`, 'watch.wake', 'etc'));
    asUser(k, 'root', (fs) => fs.writeFile('/tmp/x', ''));
    k.advance(0);
    expect(woken).toEqual([]);
    asUser(k, 'root', (fs) => fs.writeFile('/etc/hostname', 'renamed\n'));
    k.advance(0);
    expect(woken).toEqual(['etc']);
  });

  test('users are whatever /etc/passwd says, and a fork edits its own copy', () => {
    const k = bootHost();
    const f = k.fork();
    asUser(f, 'root', addOther);
    expect(k.act('t', (ctx) => passwdEntries(ctx, 'node01').map((e) => e.name))).not.toContain('other');
    expect(f.act('t', (ctx) => passwdEntries(ctx, 'node01').map((e) => e.name))).toContain('other');
    expect(f.hash()).not.toBe(k.hash());
  });
});
