// A plausible base file system for an Ubuntu 24.04.5 LTS server: what the essential packages
// base-files, base-passwd and bash lay down, plus one login user (docs/decisions.md D-020).
// Packages beyond those (systemd, rsyslog, openssh, sudo, …) and their users, units and files come
// with the phases that model them. Directory modes and owners are the ones those packages set:
//   reference: base-files 13ubuntu10.5 postinst (install_directory, install_local_dir,
//              migrate_directory, ensure_file_owner_mode) and the modes of its shipped directories
//              on the workstation (`stat -c '%a %U:%G'`), captured 2026-11-15. /var/log is 0755
//              root:root because only rsyslog's postinst makes it root:syslog 0775.
//   reference: /etc/login.defs HOME_MODE 0750 (Ubuntu 24.04 `login` package), captured 2026-11-15
// The workstation is Pop!_OS; nothing here comes from its own files (docs/FIDELITY.md §2.1).

import type { Ctx } from '@simlab/kernel';
import { getMachine } from '../machine.ts';
import { formatGroup, formatPasswd, parseGroup, parsePasswd } from '../users.ts';
import { createFs, type Fs } from '../vfs/fs.ts';
import { ROOT_CRED } from '../vfs/types.ts';
import { ALTERNATIVES, BINARIES } from './binaries.ts';
import * as files from './files.ts';

export interface UbuntuBaseOptions {
  /** The normal login user. Gets uid and gid 1000 (UID_MIN, GID_MIN in login.defs) and membership in `sudo`. */
  user: { name: string; uid?: number };
}

const GID = { mail: 8, staff: 50, utmp: 43, sudo: 27 } as const;

/** Directories in creation order: path, mode, group. All owned by root. */
const DIRS: [string, number, number?][] = [
  ['/boot', 0o755],
  ['/dev', 0o755],
  ['/etc', 0o755],
  ['/etc/alternatives', 0o755],
  ['/etc/default', 0o755],
  ['/etc/opt', 0o755],
  ['/etc/profile.d', 0o755],
  ['/etc/skel', 0o755],
  ['/home', 0o755],
  ['/media', 0o755],
  ['/mnt', 0o755],
  ['/opt', 0o755],
  ['/proc', 0o555],
  ['/root', 0o700],
  ['/run', 0o755],
  ['/run/lock', 0o1777],
  ['/srv', 0o755],
  ['/sys', 0o555],
  ['/tmp', 0o1777],
  ['/usr', 0o755],
  ['/usr/bin', 0o755],
  ['/usr/games', 0o755],
  ['/usr/include', 0o755],
  ['/usr/lib', 0o755],
  ['/usr/lib64', 0o755],
  ['/usr/sbin', 0o755],
  ['/usr/share', 0o755],
  ['/usr/share/dict', 0o755],
  ['/usr/share/info', 0o755],
  ['/usr/share/man', 0o755],
  ['/usr/share/misc', 0o755],
  ['/usr/src', 0o755],
  ['/usr/local', 0o755],
  ['/usr/local/bin', 0o755],
  ['/usr/local/etc', 0o755],
  ['/usr/local/games', 0o755],
  ['/usr/local/include', 0o755],
  ['/usr/local/lib', 0o755],
  ['/usr/local/sbin', 0o755],
  ['/usr/local/share', 0o755],
  ['/usr/local/share/man', 0o755],
  ['/usr/local/src', 0o755],
  ['/var', 0o755],
  ['/var/backups', 0o755],
  ['/var/cache', 0o755],
  ['/var/lib', 0o755],
  ['/var/lib/dpkg', 0o755],
  ['/var/lib/misc', 0o755],
  ['/var/local', 0o2775, GID.staff],
  ['/var/log', 0o755],
  ['/var/mail', 0o2775, GID.mail],
  ['/var/opt', 0o755],
  ['/var/spool', 0o755],
  ['/var/tmp', 0o1777],
];

/** Symlinks: path → target. usrmerge links at the root, base-files' migrations under /var. */
const LINKS: [string, string][] = [
  ['/bin', 'usr/bin'],
  ['/lib', 'usr/lib'],
  ['/lib64', 'usr/lib64'],
  ['/sbin', 'usr/sbin'],
  ['/usr/local/man', 'share/man'],
  ['/var/run', '/run'],
  ['/var/lock', '/run/lock'],
  ['/var/spool/mail', '../mail'],
  ['/etc/os-release', '../usr/lib/os-release'],
];

/** Builds the base system into a machine whose file system holds only `/`. */
export function buildUbuntuBase(ctx: Ctx, machineId: string, options: UbuntuBaseOptions): void {
  const machine = getMachine(ctx, machineId);
  const fs = createFs(ctx, machineId, { cred: ROOT_CRED, umask: 0 });

  // As base-files' install_directory: mkdir, chown, chmod. mkdir alone would drop the
  // set-group-ID bit (mkdir(2) applies mode & 01777).
  for (const [path, mode, gid] of DIRS) {
    fs.mkdir(path, mode);
    if (gid !== undefined) fs.chown(path, -1, gid);
    fs.chmod(path, mode);
  }
  for (const [path, target] of LINKS) fs.symlink(target, path);

  const file = (path: string, data: string, mode = 0o644, uid = 0, gid = 0) => {
    fs.writeFile(path, data, { mode, exclusive: true });
    if (uid !== 0 || gid !== 0) fs.chown(path, uid, gid);
  };

  file('/usr/lib/os-release', files.OS_RELEASE);
  file('/etc/lsb-release', files.LSB_RELEASE);
  file('/etc/issue', files.ISSUE);
  file('/etc/issue.net', files.ISSUE_NET);
  file('/etc/debian_version', files.DEBIAN_VERSION);
  file('/etc/host.conf', files.HOST_CONF);
  file('/etc/profile', files.ETC_PROFILE);
  file('/etc/environment', files.ETC_ENVIRONMENT);
  file('/etc/hostname', `${machine.hostname}\n`);
  file('/etc/skel/.bashrc', files.SKEL_BASHRC);
  file('/etc/skel/.profile', files.SKEL_PROFILE);
  file('/etc/skel/.bash_logout', files.SKEL_BASH_LOGOUT);
  file('/root/.bashrc', files.ROOT_BASHRC);
  file('/root/.profile', files.ROOT_PROFILE);
  // base-files postinst ensure_file_owner_mode: empty until something logs a session.
  file('/var/log/wtmp', '', 0o664, 0, GID.utmp);
  file('/var/log/btmp', '', 0o660, 0, GID.utmp);
  file('/var/log/lastlog', '', 0o664, 0, GID.utmp);

  fs.createGenerated('/dev/null', 'host.null', { mode: 0o666, device: { major: 1, minor: 3 } });

  // The locale of every simulated host (docs/decisions.md D-022), as update-locale writes it.
  file('/etc/default/locale', 'LANG=C.UTF-8\n');

  // Executables: stubs naming registered programs, scripts, symlinks and alternatives.
  for (const [path, entry] of BINARIES) {
    if (typeof entry === 'string') fs.symlink(entry, path);
    else if (Array.isArray(entry)) fs.installProgram(path, entry[2], { size: entry[0], mode: entry[1] });
    else file(path, entry.script, entry.mode);
  }
  for (const [name, target] of ALTERNATIVES) fs.symlink(target, `/etc/alternatives/${name}`);

  // Accounts. base-passwd's update-passwd installs the master files; shadow's pwconv replaces each
  // password field with `x`. The workstation's /etc/passwd matches passwd.master this way
  // line for line for the 18 base entries (checked 2026-11-15).
  const passwd = parsePasswd(files.PASSWD_MASTER).map((e) => ({ ...e, password: 'x' }));
  const groups = parseGroup(files.GROUP_MASTER).map((g) => ({ ...g, password: 'x' }));
  addUser(fs, passwd, groups, options.user);
  file('/etc/passwd', formatPasswd(passwd));
  file('/etc/group', formatGroup(groups));
}

function addUser(
  fs: Fs,
  passwd: ReturnType<typeof parsePasswd>,
  groups: ReturnType<typeof parseGroup>,
  user: UbuntuBaseOptions['user'],
): void {
  const id = user.uid ?? 1000;
  const home = `/home/${user.name}`;
  // adduser: a personal group with the same id (USERGROUPS_ENAB yes), shell /bin/bash, the full
  // name defaulting to the login name, and a home created from /etc/skel with HOME_MODE.
  passwd.push({ name: user.name, password: 'x', uid: id, gid: id, gecos: user.name, home, shell: '/bin/bash' });
  groups.push({ name: user.name, password: 'x', gid: id, members: [] });
  const sudo = groups.find((g) => g.gid === GID.sudo);
  if (sudo) sudo.members.push(user.name);
  fs.mkdir(home, 0o750);
  fs.chown(home, id, id);
  for (const dot of ['.bash_logout', '.bashrc', '.profile']) {
    const path = `${home}/${dot}`;
    fs.writeFile(path, fs.readFile(`/etc/skel/${dot}`), { mode: 0o644, exclusive: true });
    fs.chown(path, id, id);
  }
}
