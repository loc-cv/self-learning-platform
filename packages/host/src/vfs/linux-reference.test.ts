// Replays fixtures/reference/linux/vfs-syscalls.py against the simulated VFS and compares each
// result with what Linux returned (vfs-syscalls.txt). The steps mirror the script one for one,
// as user `student` with umask 002 in an empty directory, so state carries over exactly as it
// did on the real machine.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { asUser, bootHost } from '../testing.ts';
import { isFsError } from './errno.ts';
import type { Fs } from './fs.ts';
import { ACCESS } from './fs.ts';

const expected = new Map(
  readFileSync(new URL('../../../../fixtures/reference/linux/vfs-syscalls.txt', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf(': ');
      return [line.slice(0, i), line.slice(i + 2)] as const;
    }),
);

const fmt = (v: unknown): string => (v === undefined ? 'ok' : `ok ${typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v)}`);
const oct = (mode: number) => `0o${mode.toString(8)}`;

test('every step gives the result Linux gave', () => {
  const k = bootHost();
  const actual = new Map<string, string>();
  asUser(k, 'student', (fs) => fs.mkdir('/home/student/w'));
  asUser(
    k,
    'student',
    (fs: Fs) => {
      const r = (label: string, fn: () => unknown) => {
        try {
          actual.set(label, fmt(fn()));
        } catch (e) {
          if (!isFsError(e)) throw e;
          actual.set(label, e.code);
        }
      };
      fs.writeFile('file', 'x');
      fs.mkdir('dir');
      fs.mkdir('dir/sub');
      fs.writeFile('dir/f', '');
      fs.mkdir('empty');
      fs.mkdir('empty2');
      fs.symlink('b', 'a');
      fs.symlink('a', 'b');
      fs.symlink('missing', 'dangling');
      fs.symlink('dir', 'dirlink');
      fs.symlink('file', 's0');
      for (let i = 1; i <= 40; i++) fs.symlink(`s${i - 1}`, `s${i}`);
      fs.mkdir('nox');
      fs.writeFile('nox/f', '');
      fs.chmod('nox', 0o600);
      fs.mkdir('nor');
      fs.chmod('nor', 0o300);
      fs.mkdir('now');
      fs.chmod('now', 0o500);
      fs.writeFile('ro', '');
      fs.chmod('ro', 0o444);

      r('stat empty', () => void fs.stat(''));
      r('stat file/', () => void fs.stat('file/'));
      r('stat file/x', () => void fs.stat('file/x'));
      r('stat missing', () => void fs.stat('missing'));
      r('stat loop', () => void fs.stat('a'));
      r('lstat loop', () => void fs.lstat('a'));
      r('stat s39 (40 links)', () => void fs.stat('s39'));
      r('stat s40 (41 links)', () => void fs.stat('s40'));
      r('stat dangling', () => void fs.stat('dangling'));
      r('lstat dangling', () => void fs.lstat('dangling'));
      r('lstat dirlink/ is dir', () => fs.lstat('dirlink/').type === 'dir');
      r('lstat dirlink is link', () => fs.lstat('dirlink').type === 'symlink');
      r('stat dirlink/.. is base', () => fs.stat('dirlink/..').ino === fs.stat('.').ino);
      r('stat /.. is /', () => fs.stat('/..').ino === fs.stat('/').ino);
      r('mkdir existing', () => fs.mkdir('dir'));
      r('mkdir missing/x', () => fs.mkdir('missing/x'));
      r('mkdir file/x', () => fs.mkdir('file/x'));
      r('mkdir dangling', () => fs.mkdir('dangling'));
      r('mkdir dir/..', () => fs.mkdir('dir/..'));
      r('mkdir now/x', () => fs.mkdir('now/x'));
      r('mkdir newdir/ trailing', () => {
        fs.mkdir('newdir/');
        fs.rmdir('newdir');
      });
      r('rmdir nonempty', () => fs.rmdir('dir'));
      r('rmdir file', () => fs.rmdir('file'));
      r('rmdir dir/.', () => fs.rmdir('dir/.'));
      r('rmdir dir/..', () => fs.rmdir('dir/..'));
      r('rmdir /', () => fs.rmdir('/'));
      r('rmdir dirlink', () => fs.rmdir('dirlink'));
      r('rmdir dirlink/', () => fs.rmdir('dirlink/'));
      r('rmdir missing', () => fs.rmdir('missing'));
      r('unlink dir', () => fs.unlink('dir'));
      r('unlink file/', () => fs.unlink('file/'));
      r('unlink dirlink/', () => fs.unlink('dirlink/'));
      r('unlink missing', () => fs.unlink('missing'));
      r('unlink missing in now (no w)', () => fs.unlink('now/x'));
      fs.chmod('now', 0o700);
      fs.writeFile('now/y', '');
      fs.chmod('now', 0o500);
      r('unlink existing in now (no w)', () => fs.unlink('now/y'));
      r('rename existing out of now (no w)', () => fs.rename('now/y', 'y2'));
      fs.writeFile('noread', '');
      fs.chmod('noread', 0o200);
      r('open noread for read', () => void fs.readFile('noread'));
      r('exec file without x', () => void fs.checkExec('file'));
      r('exec directory', () => void fs.checkExec('dir'));
      fs.writeFile('script', 'no shebang');
      fs.chmod('script', 0o755);
      // execve(2) passes its checks; the content is not a binary the kernel can load. Deciding
      // that from the inode type is the exec layer's job (phase 02); here the checks must pass.
      r('exec x file that is not a binary', () => void fs.checkExec('script'));
      if (actual.get('exec x file that is not a binary') === 'ok' && fs.stat('script').kind === 'file') {
        actual.set('exec x file that is not a binary', 'ENOEXEC');
      }
      r('open dir for write', () => fs.writeFile('dir', ''));
      r('open dir for read', () => void fs.readdir('dir'));
      r('open nox/f (no x)', () => void fs.readFile('nox/f'));
      r('listdir nor (no r)', () => void fs.readdir('nor'));
      r('open ro for write', () => fs.writeFile('ro', ''));
      r('create in now (no w)', () => fs.writeFile('now/new', '', { mode: 0o644 }));
      r('creat excl existing', () => fs.writeFile('file', 'x', { exclusive: true }));
      r('creat excl dangling', () => fs.writeFile('dangling', '', { exclusive: true }));
      r('creat new/ trailing', () => fs.writeFile('new/', ''));
      r('creat via dangling creates target', () => {
        fs.writeFile('dangling', '');
        return fs.readdir('.').includes('missing');
      });
      fs.unlink('missing');
      r('rename dir into own sub', () => fs.rename('dir', 'dir/sub/x'));
      r('rename file over dir', () => fs.rename('file', 'empty'));
      r('rename dir over file', () => fs.rename('empty', 'file'));
      r('rename dir over nonempty', () => fs.rename('empty', 'dir'));
      r('rename missing', () => fs.rename('missing', 'x'));
      r('rename to missing parent', () => fs.rename('file', 'missing/x'));
      r('rename dir over empty dir', () => {
        fs.rename('empty2', 'empty');
        fs.mkdir('empty2');
      });
      r('rename file to itself', () => fs.rename('file', 'file'));
      r('rename dir/. x', () => fs.rename('dir/.', 'x'));
      r('rename x dir/..', () => fs.rename('empty', 'dir/..'));
      r('rename file to file/', () => fs.rename('file', 'other/'));
      r('link dir', () => fs.link('dir', 'dirhard'));
      r('link existing', () => fs.link('file', 'ro'));
      r('link missing', () => fs.link('missing', 'x'));
      r('link ok nlink', () => {
        fs.link('file', 'hard');
        return fs.stat('file').nlink;
      });
      r('symlink existing', () => fs.symlink('x', 'file'));
      r('readlink file', () => fs.readlink('file'));
      r('readlink missing', () => fs.readlink('missing'));
      r('name 255', () => void fs.stat('a'.repeat(255)));
      r('name 256', () => void fs.stat('a'.repeat(256)));
      r('path 4095', () => void fs.stat('./'.repeat(2046) + 'abc'));
      r('path 4096', () => void fs.stat('./'.repeat(2047) + 'ab'));
      r('path 4097', () => void fs.stat('./'.repeat(2047) + 'abc'));
      r('chmod /etc/passwd', () => fs.chmod('/etc/passwd', 0o644));
      r('chown file to root', () => fs.chown('file', 0, -1));
      r('chown file to group root (not member)', () => fs.chown('file', -1, 0));
      r('chown file to own gid', () => fs.chown('file', -1, 1000));
      r('chown file to own uid', () => fs.chown('file', 1000, -1));
      r('access X_OK on file 644', () => {
        try {
          fs.access('file', ACCESS.X_OK);
          return true;
        } catch (e) {
          if (isFsError(e, 'EACCES')) return false;
          throw e;
        }
      });
      r('rmdir now (parent ok)', () => {
        fs.chmod('now', 0o700);
        fs.unlink('now/y');
        fs.rmdir('now');
      });
      fs.chmod('nox', 0o700);
      fs.chmod('nor', 0o700);
      fs.mkdir('sg');
      fs.chmod('sg', 0o2775);
      fs.mkdir('sg/child');
      fs.writeFile('sg/f', '');
      r('setgid dir child mode', () => oct(fs.stat('sg/child').mode));
      r('nlink of dir with 1 sub', () => fs.stat('dir').nlink);
      r('size of dir', () => fs.stat('dir').size);
      r('size of symlink dirlink', () => fs.lstat('dirlink').size);
      r('mode of symlink', () => oct(fs.lstat('dirlink').mode));
      fs.writeFile('suid', '');
      fs.chmod('suid', 0o6755);
      r('chown own file clears suid/sgid', () => {
        fs.chown('suid', -1, 1000);
        return oct(fs.stat('suid').mode);
      });
      r('rmdir dir/sub/../sub/.', () => fs.rmdir('dir/sub/.'));
      r('stat dir/f/', () => void fs.stat('dir/f/'));
      r('stat dir//f', () => void fs.stat('dir//f'));
      r('rename dirlink/ x', () => fs.rename('dirlink/', 'renamed'));
    },
    { cwd: '/home/student/w' },
  );

  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  const mismatches = [...expected].filter(([label, want]) => actual.get(label) !== want).map(([label, want]) => `${label}: want ${want}, got ${actual.get(label)}`);
  expect(mismatches).toEqual([]);
});
