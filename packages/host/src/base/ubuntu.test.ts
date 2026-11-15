import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { asUser, bootHost } from '../testing.ts';
import { credFor, userByName } from '../users.ts';
import type { Fs } from '../vfs/fs.ts';
import * as files from './files.ts';

/** `ls -lR`-like lines: type+mode uid:gid path [-> target], for every entry under `dir`. */
function tree(fs: Fs, dir = '/'): string[] {
  const out: string[] = [];
  for (const name of fs.readdir(dir)) {
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    const st = fs.lstat(path);
    const t = { dir: 'd', file: '-', symlink: 'l', char: 'c' }[st.type];
    out.push(`${t}${st.mode.toString(8).padStart(4, '0')} ${st.uid}:${st.gid} ${path}${st.type === 'symlink' ? ` -> ${fs.readlink(path)}` : ''}`);
    if (st.type === 'dir') out.push(...tree(fs, path));
  }
  return out;
}

describe('Ubuntu 24.04 base', () => {
  const k = bootHost();
  const listing = asUser(k, 'root', (fs) => tree(fs));

  test('top level matches an Ubuntu server, without Pop!_OS or installer leftovers', () => {
    expect(listing.filter((l) => l.split(' ')[2]?.split('/').length === 2)).toEqual([
      'l0777 0:0 /bin -> usr/bin',
      'd0755 0:0 /boot',
      'd0755 0:0 /dev',
      'd0755 0:0 /etc',
      'd0755 0:0 /home',
      'l0777 0:0 /lib -> usr/lib',
      'l0777 0:0 /lib64 -> usr/lib64',
      'd0755 0:0 /media',
      'd0755 0:0 /mnt',
      'd0755 0:0 /opt',
      'd0555 0:0 /proc',
      'd0700 0:0 /root',
      'd0755 0:0 /run',
      'l0777 0:0 /sbin -> usr/sbin',
      'd0755 0:0 /srv',
      'd0555 0:0 /sys',
      'd1777 0:0 /tmp',
      'd0755 0:0 /usr',
      'd0755 0:0 /var',
    ]);
  });

  test('modes and owners set by base-files and adduser', () => {
    for (const line of [
      'd2775 0:50 /var/local',
      'd2775 0:8 /var/mail',
      'd1777 0:0 /var/tmp',
      'd0755 0:0 /var/log',
      'd1777 0:0 /run/lock',
      'l0777 0:0 /var/run -> /run',
      'l0777 0:0 /var/lock -> /run/lock',
      'l0777 0:0 /var/spool/mail -> ../mail',
      'l0777 0:0 /usr/local/man -> share/man',
      'l0777 0:0 /etc/os-release -> ../usr/lib/os-release',
      '-0664 0:43 /var/log/wtmp',
      '-0660 0:43 /var/log/btmp',
      '-0664 0:43 /var/log/lastlog',
      'c0666 0:0 /dev/null',
      '-0644 0:0 /etc/passwd',
      '-0644 0:0 /root/.bashrc',
      'd0750 1000:1000 /home/student',
      '-0644 1000:1000 /home/student/.bashrc',
      '-0644 1000:1000 /home/student/.profile',
      '-0644 1000:1000 /home/student/.bash_logout',
    ]) {
      expect(listing).toContain(line);
    }
  });

  test('file contents are the packages\' files', () => {
    asUser(k, 'root', (fs) => {
      const pairs: [string, string][] = [
        ['/etc/os-release', files.OS_RELEASE],
        ['/etc/lsb-release', files.LSB_RELEASE],
        ['/etc/issue', files.ISSUE],
        ['/etc/issue.net', files.ISSUE_NET],
        ['/etc/debian_version', files.DEBIAN_VERSION],
        ['/etc/host.conf', files.HOST_CONF],
        ['/etc/profile', files.ETC_PROFILE],
        ['/etc/environment', files.ETC_ENVIRONMENT],
        ['/etc/skel/.bashrc', files.SKEL_BASHRC],
        ['/home/student/.bashrc', files.SKEL_BASHRC],
        ['/home/student/.profile', files.SKEL_PROFILE],
        ['/root/.bashrc', files.ROOT_BASHRC],
        ['/root/.profile', files.ROOT_PROFILE],
        ['/etc/hostname', 'node01\n'],
      ];
      for (const [path, want] of pairs) expect(fs.readFile(path), path).toBe(want);
      expect(fs.readFile('/etc/os-release')).toContain('PRETTY_NAME="Ubuntu 24.04.5 LTS"');
      expect(fs.stat('/etc/skel/.bashrc').size).toBe(3771);
    });
  });

  test('the embedded files are byte-identical to the workstation\'s package files', () => {
    // Only meaningful on a machine with the same package versions (docs/FIDELITY.md §2.1); skipped elsewhere.
    const read = (p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    };
    const skel = read('/etc/skel/.bashrc');
    if (skel === undefined || !read('/var/lib/dpkg/status')?.includes('Version: 5.2.21-2ubuntu4')) return;
    expect(files.SKEL_BASHRC).toBe(skel);
    expect(files.PASSWD_MASTER).toBe(read('/usr/share/base-passwd/passwd.master'));
  });

  test('accounts: base-passwd entries with shadowed passwords, plus the login user in sudo', () => {
    asUser(k, 'root', (fs) => {
      const passwd = fs.readFile('/etc/passwd').split('\n');
      expect(passwd[0]).toBe('root:x:0:0:root:/root:/bin/bash');
      expect(passwd).toContain('nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin');
      expect(passwd).toContain('student:x:1000:1000:student:/home/student:/bin/bash');
      expect(passwd.length).toBe(18 + 1 + 1); // base entries, the user, the final newline
      const group = fs.readFile('/etc/group').split('\n');
      expect(group).toContain('sudo:x:27:student');
      expect(group).toContain('student:x:1000:');
      expect(group[0]).toBe('root:x:0:');
    });
    k.act('t', (ctx) => {
      expect(userByName(ctx, 'node01', 'student')?.home).toBe('/home/student');
      expect(credFor(ctx, 'node01', 'student')).toEqual({ uid: 1000, gid: 1000, groups: [1000, 27] });
      expect(credFor(ctx, 'node01', 'root')).toEqual({ uid: 0, gid: 0, groups: [0] });
    });
  });

  test('every machine gets its own hostname and identical layout', () => {
    const two = bootHost([], ['controlplane', 'node01']);
    const a = asUser(two, 'root', (fs) => tree(fs), { machine: 'controlplane' });
    const b = asUser(two, 'root', (fs) => tree(fs), { machine: 'node01' });
    expect(a).toEqual(b);
    expect(asUser(two, 'root', (fs) => fs.readFile('/etc/hostname'), { machine: 'controlplane' })).toBe('controlplane\n');
  });
});
