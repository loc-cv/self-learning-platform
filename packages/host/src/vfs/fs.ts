// File system calls over one machine's VFS, as a process with given credentials makes them
// (docs/ARCHITECTURE.md §3.2). Path resolution, permission checks, the order of checks and the
// error numbers follow Linux:
//   docs: path_resolution(7), and the ERRORS sections of open(2), stat(2), mkdir(2), rmdir(2),
//         unlink(2), rename(2), link(2), symlink(2), readlink(2), chmod(2), chown(2),
//         utimensat(2), access(2), execve(2) (man-pages 6.7 on the workstation, docs/FIDELITY.md §2.1)
//   reference: fixtures/reference/linux/vfs-syscalls.txt (Linux 7.2.15, captured 2026-11-15),
//              which the tests in fs.test.ts replay case by case.
// Messages are not produced here: programs print `strerror(code)` in their own format.

import { put, remove, type Ctx, type Json, type Millis } from '@simlab/kernel';
import { getMachine, nextInode, type Machine } from '../machine.ts';
import { utf8Length } from '../utf8.ts';
import { FsError, UnsupportedError, type Errno } from './errno.ts';
import { FILE_PROVIDER, type FileProviderSpec } from './provider.ts';
import type { Cred, DirInode, Inode, ProgramInode, Stat } from './types.ts';

/** linux/limits.h: PATH_MAX counts the terminating NUL, so a path of 4096 bytes is too long. */
export const PATH_MAX = 4096;
/** linux/limits.h NAME_MAX. */
export const NAME_MAX = 255;
/** path_resolution(7): "the maximum number of symbolic links that will be followed ... is 40". */
export const MAXSYMLINKS = 40;

/**
 * The link protections Ubuntu turns on: procps' /usr/lib/sysctl.d/99-protect-links.conf sets
 * fs.protected_hardlinks = 1, fs.protected_symlinks = 1 and fs.protected_regular = 2.
 *   reference: the workstation's procps file and `sysctl fs.protected_*`, captured 2026-11-15
 *   docs: proc_sys_fs(5); upstream Linux v6.8 fs/namei.c may_follow_link, may_linkat,
 *         safe_hardlink_source, may_create_in_sticky (none exempts root, except CAP_FOWNER for links)
 * Constants until the sysctl table exists (STATUS.md, temporary shortcuts).
 */
export const PROTECTED = { hardlinks: 1, symlinks: 1, regular: 2 } as const;

const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_ISVTX = 0o1000;
const R = 4;
const W = 2;
const X = 1;

export const ACCESS = { F_OK: 0, X_OK: X, W_OK: W, R_OK: R } as const;

export interface FsOptions {
  cred: Cred;
  /** Working directory as an absolute path; `/` when absent. */
  cwd?: string;
  /** File mode creation mask of the calling process. */
  umask: number;
}

export interface WriteOptions {
  /** O_APPEND instead of O_TRUNC. */
  append?: boolean;
  /** O_EXCL: fail with EEXIST if anything exists at the path, without following a final symlink. */
  exclusive?: boolean;
  /** Mode for a new file, before the umask. Default 0666. */
  mode?: number;
}

export interface Fs {
  readonly machine: Machine;
  stat(path: string): Stat;
  lstat(path: string): Stat;
  readFile(path: string): string;
  /** open(O_WRONLY|O_CREAT|O_TRUNC or O_APPEND [|O_EXCL]) and one write. */
  writeFile(path: string, data: string, opts?: WriteOptions): void;
  mkdir(path: string, mode?: number): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(from: string, to: string): void;
  link(existing: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  /** Names in the directory, sorted in code-unit order, without `.` and `..`. */
  readdir(path: string): string[];
  chmod(path: string, mode: number): void;
  /** -1 leaves the owner or group unchanged. Follows a final symlink. */
  chown(path: string, uid: number, gid: number): void;
  /** Sets the modification time; `undefined` means now (utimensat with UTIME_NOW). */
  utimes(path: string, mtime?: Millis): void;
  /** Throws EACCES (or a resolution error) when the calling credentials lack `mode`. */
  access(path: string, mode: number): void;
  /** The canonical absolute path, with every symlink resolved. */
  realpath(path: string): string;
  /** The checks execve(2) makes before it looks at the content. Returns the inode to run. */
  checkExec(path: string): Inode;
  /** Creates an executable stub naming a registered program. */
  installProgram(path: string, program: string, opts: { size: number; mode?: number }): void;
  /** mknod for a generated file or character device backed by a registered file provider. */
  createGenerated(
    path: string,
    provider: string,
    opts: { args?: Json; mode: number; device?: { major: number; minor: number } },
  ): void;
}

interface Found {
  /** Directory holding the final entry; undefined when the path ends at the root. */
  dir: string | undefined;
  /** Final component: a name, `.`, `..`, or '' for the root. */
  name: string;
  /** The entry's inode; undefined when it does not exist (only if missing was allowed). */
  ino: string | undefined;
  /** The path ended in a slash. */
  trailing: boolean;
}

/** `always`: follow a final symlink (stat, open). `trailing`: only if the path ends in `/` (lstat). `never`: unlink, rmdir, rename, mkdir. */
type Follow = 'always' | 'trailing' | 'never';

export function createFs(ctx: Ctx, machineId: string, options: FsOptions): Fs {
  const machine = getMachine(ctx, machineId);
  const vfs = machine.vfs;
  const { cred, umask } = options;
  const isRoot = cred.uid === 0;

  const inode = (id: string): Inode => {
    const i = vfs.inodes[id];
    if (!i) throw new Error(`machine ${machineId}: dangling inode ${id}`);
    return i;
  };
  const dirInode = (id: string): DirInode => inode(id) as DirInode;
  const store = <T extends Inode>(i: T): T => put(vfs.inodes, i.id, i) as T;
  const changed = (dir: string): void => ctx.publish(`host.vfs:${machineId}:${dir}`);

  const inGroup = (gid: number): boolean => cred.gid === gid || cred.groups.includes(gid);

  /** Permission check of path_resolution(7) "Permissions": one class only, owner then group then other. */
  const may = (i: Inode, want: number): boolean => {
    if (isRoot) {
      // CAP_DAC_OVERRIDE: everything, except execute on a non-directory with no execute bit at all.
      return !(want & X) || i.type === 'dir' || (i.mode & 0o111) !== 0;
    }
    const bits = cred.uid === i.uid ? (i.mode >> 6) & 7 : inGroup(i.gid) ? (i.mode >> 3) & 7 : i.mode & 7;
    return (bits & want) === want;
  };

  /** Sticky directories: only the owner of the entry or of the directory, or root, may remove it. */
  const stickyDenies = (dir: DirInode, victim: Inode): boolean =>
    (dir.mode & S_ISVTX) !== 0 && !isRoot && cred.uid !== victim.uid && cred.uid !== dir.uid;

  const fail = (code: Errno, syscall: string, path: string): never => {
    throw new FsError(code, syscall, path);
  };

  const cwdIno = (): string => {
    const cwd = options.cwd ?? '/';
    if (!cwd.startsWith('/')) throw new Error(`cwd must be absolute, got ${cwd}`);
    // A process holds its working directory as an inode: no permission checks on the way there.
    const found = walk(cwd, 'always', false, 'chdir', true);
    return found.ino as string;
  };

  const split = (p: string): string[] => p.split('/').filter((c) => c !== '');

  function walk(path: string, follow: Follow, allowMissing: boolean, syscall: string, privileged = false): Found {
    if (path === '') fail('ENOENT', syscall, path);
    if (utf8Length(path) >= PATH_MAX) fail('ENAMETOOLONG', syscall, path);
    let trailing = path.endsWith('/') && split(path).length > 0;
    let cur = path.startsWith('/') ? vfs.root : cwdIno();
    let parent: string | undefined = cur === vfs.root ? undefined : dirInode(cur).parent;
    let name = path.startsWith('/') ? '' : '.';
    let queue = split(path);
    let links = 0;

    while (queue.length > 0) {
      const comp = queue.shift() as string;
      const last = queue.length === 0;
      const d = inode(cur);
      if (d.type !== 'dir') fail('ENOTDIR', syscall, path);
      const dir = d as DirInode;
      if (!privileged && !may(dir, X)) fail('EACCES', syscall, path);
      if (utf8Length(comp) > NAME_MAX) fail('ENAMETOOLONG', syscall, path);
      if (comp === '.') {
        name = '.';
        continue;
      }
      if (comp === '..') {
        cur = dir.parent;
        parent = cur === vfs.root ? undefined : dirInode(cur).parent;
        name = '..';
        continue;
      }
      const child = dir.entries[comp];
      if (child === undefined) {
        if (last && allowMissing) return { dir: cur, name: comp, ino: undefined, trailing };
        fail('ENOENT', syscall, path);
      }
      const ci = inode(child as string);
      const followHere = !last || follow === 'always' || (follow === 'trailing' && trailing);
      if (ci.type === 'symlink' && followHere) {
        if (++links > MAXSYMLINKS) fail('ELOOP', syscall, path);
        // protected_symlinks: in a sticky world-writable directory, follow only links owned by the
        // follower or by the directory's owner.
        if (
          PROTECTED.symlinks &&
          !privileged &&
          cred.uid !== ci.uid &&
          (dir.mode & (S_ISVTX | 0o002)) === (S_ISVTX | 0o002) &&
          dir.uid !== ci.uid
        ) {
          fail('EACCES', syscall, path);
        }
        if (ci.target === '') fail('ENOENT', syscall, path);
        if (last && ci.target.endsWith('/')) trailing = true;
        if (ci.target.startsWith('/')) {
          cur = vfs.root;
          parent = undefined;
          name = '';
        }
        queue = [...split(ci.target), ...queue];
        continue;
      }
      parent = cur;
      cur = child as string;
      name = comp;
    }
    if (trailing && inode(cur).type !== 'dir') fail('ENOTDIR', syscall, path);
    return { dir: parent, name, ino: cur, trailing };
  }

  const statOf = (i: Inode): Stat => {
    const base = { ino: i.id, kind: i.type, mode: i.mode, uid: i.uid, gid: i.gid, nlink: i.nlink, mtime: i.mtime, ctime: i.ctime };
    switch (i.type) {
      case 'dir':
        return { ...base, type: 'dir', size: 4096 };
      case 'file':
        return { ...base, type: 'file', size: utf8Length(i.data) };
      case 'symlink':
        return { ...base, type: 'symlink', size: utf8Length(i.target) };
      case 'program':
        return { ...base, type: 'file', size: i.size };
      case 'generated':
        return i.device ? { ...base, type: 'char', size: 0, rdev: { ...i.device } } : { ...base, type: 'file', size: 0 };
    }
  };

  const provider = (name: string): FileProviderSpec => {
    const p = ctx.registry.get<FileProviderSpec>(FILE_PROVIDER, name);
    if (!p) throw new Error(`no file provider ${name}`);
    return p;
  };

  /** Records a new entry `name` → `id` in `dirId`, as created now. */
  const addEntry = (dirId: string, name: string, id: string, isDir: boolean): void => {
    const d = dirInode(dirId);
    store({
      ...d,
      entries: { ...d.entries, [name]: id },
      nlink: d.nlink + (isDir ? 1 : 0),
      mtime: ctx.now,
      ctime: ctx.now,
    });
    changed(dirId);
  };

  const removeEntry = (dirId: string, name: string, isDir: boolean): void => {
    const d = dirInode(dirId);
    const entries = { ...d.entries };
    delete entries[name];
    store({ ...d, entries, nlink: d.nlink - (isDir ? 1 : 0), mtime: ctx.now, ctime: ctx.now });
    changed(dirId);
  };

  /** Drops one link to an inode, deleting it when none is left. */
  const dropLink = (id: string): void => {
    const i = inode(id);
    if (i.type === 'dir' || i.nlink <= 1) remove(vfs.inodes, id);
    else store({ ...i, nlink: i.nlink - 1, ctime: ctx.now });
  };

  /** Owner and group of a new inode in `dir`: the directory's group if it is set-group-ID (mkdir(2), open(2)). */
  const newOwner = (dir: DirInode): { uid: number; gid: number } => ({
    uid: cred.uid,
    gid: dir.mode & S_ISGID ? dir.gid : cred.gid,
  });

  /** The parent-side checks of creating an entry: it must not exist, and the directory must be writable. */
  const creating = (syscall: string, path: string): { dir: DirInode; name: string; found: Found } => {
    const found = walk(path, 'never', true, syscall);
    if (found.ino !== undefined) fail('EEXIST', syscall, path);
    const dir = dirInode(found.dir as string);
    if (!may(dir, W | X)) fail('EACCES', syscall, path);
    return { dir, name: found.name, found };
  };

  const isAncestor = (ancestor: string, of: string): boolean => {
    for (let cur = of; ; ) {
      if (cur === ancestor) return true;
      const p = dirInode(cur).parent;
      if (p === cur) return false;
      cur = p;
    }
  };

  const fs: Fs = {
    machine,

    stat(path) {
      return statOf(inode(walk(path, 'always', false, 'stat').ino as string));
    },

    lstat(path) {
      return statOf(inode(walk(path, 'trailing', false, 'lstat').ino as string));
    },

    readFile(path) {
      const i = inode(walk(path, 'always', false, 'open').ino as string);
      if (!may(i, R)) fail('EACCES', 'open', path);
      switch (i.type) {
        case 'dir':
          return fail('EISDIR', 'read', path);
        case 'file':
          return i.data;
        case 'program':
          throw new UnsupportedError(`binary content of ${path} (executable stub for ${i.program})`);
        case 'generated':
          return provider(i.provider).read(ctx, machine, i.args);
        case 'symlink':
          throw new Error('unreachable: final symlinks are followed');
      }
    },

    writeFile(path, data, opts = {}) {
      const found = walk(path, opts.exclusive ? 'never' : 'always', true, 'open');
      if (found.ino !== undefined) {
        if (opts.exclusive) fail('EEXIST', 'open', path);
        const i = inode(found.ino);
        if (i.type === 'dir') fail('EISDIR', 'open', path);
        // protected_regular (O_CREAT on an existing regular file in a sticky directory that is
        // world-writable, or group-writable at level 2): only the file's owner or the directory's.
        const d = found.dir === undefined ? undefined : dirInode(found.dir);
        if (
          d &&
          PROTECTED.regular &&
          (i.type === 'file' || i.type === 'program') &&
          d.mode & S_ISVTX &&
          i.uid !== d.uid &&
          i.uid !== cred.uid &&
          (d.mode & 0o002 || (PROTECTED.regular >= 2 && d.mode & 0o020))
        ) {
          fail('EACCES', 'open', path);
        }
        if (!may(i, W)) fail('EACCES', 'open', path);
        switch (i.type) {
          case 'file':
            store({ ...i, data: opts.append ? i.data + data : data, mtime: ctx.now, ctime: ctx.now });
            break;
          case 'program': {
            if (opts.append) throw new UnsupportedError(`appending to the binary content of ${path}`);
            // Truncating an executable leaves an ordinary file holding the new text.
            const { id, mode, uid, gid, nlink } = i;
            store({ id, mode, uid, gid, nlink, type: 'file', data, mtime: ctx.now, ctime: ctx.now });
            break;
          }
          case 'generated': {
            const p = provider(i.provider);
            if (!p.write) throw new UnsupportedError(`writing to ${path}`);
            p.write(ctx, machine, i.args, data, opts.append ?? false);
            break;
          }
        }
        if (found.dir !== undefined) changed(found.dir);
        return;
      }
      if (found.trailing) fail('EISDIR', 'open', path);
      const dir = dirInode(found.dir as string);
      if (!may(dir, W | X)) fail('EACCES', 'open', path);
      const id = nextInode(ctx, machineId);
      store({
        id,
        type: 'file',
        data,
        mode: (opts.mode ?? 0o666) & ~umask & 0o7777,
        ...newOwner(dir),
        mtime: ctx.now,
        ctime: ctx.now,
        nlink: 1,
      });
      addEntry(dir.id, found.name, id, false);
    },

    mkdir(path, mode = 0o777) {
      const { dir, name } = creating('mkdir', path);
      const id = nextInode(ctx, machineId);
      store({
        id,
        type: 'dir',
        entries: {},
        parent: dir.id,
        // mkdir(2): mode & ~umask & 01777; a set-group-ID parent passes the bit on.
        mode: (mode & ~umask & 0o1777) | (dir.mode & S_ISGID),
        ...newOwner(dir),
        mtime: ctx.now,
        ctime: ctx.now,
        nlink: 2,
      });
      addEntry(dir.id, name, id, true);
    },

    rmdir(path) {
      const found = walk(path, 'never', false, 'rmdir');
      if (found.name === '.') fail('EINVAL', 'rmdir', path);
      if (found.name === '..') fail('ENOTEMPTY', 'rmdir', path);
      if (found.dir === undefined) fail('EBUSY', 'rmdir', path);
      const dir = dirInode(found.dir as string);
      const victim = inode(found.ino as string);
      if (!may(dir, W | X)) fail('EACCES', 'rmdir', path);
      if (stickyDenies(dir, victim)) fail('EPERM', 'rmdir', path);
      if (victim.type !== 'dir') fail('ENOTDIR', 'rmdir', path);
      if (Object.keys((victim as DirInode).entries).length > 0) fail('ENOTEMPTY', 'rmdir', path);
      removeEntry(dir.id, found.name, true);
      dropLink(victim.id);
    },

    unlink(path) {
      const found = walk(path, 'never', false, 'unlink');
      if (found.name === '.' || found.name === '..' || found.dir === undefined) fail('EISDIR', 'unlink', path);
      const dir = dirInode(found.dir as string);
      const victim = inode(found.ino as string);
      if (!may(dir, W | X)) fail('EACCES', 'unlink', path);
      if (stickyDenies(dir, victim)) fail('EPERM', 'unlink', path);
      if (victim.type === 'dir') fail('EISDIR', 'unlink', path);
      removeEntry(dir.id, found.name, false);
      dropLink(victim.id);
    },

    rename(from, to) {
      const a = walk(from, 'never', false, 'rename');
      const b = walk(to, 'never', true, 'rename');
      const special = (f: Found) => f.name === '.' || f.name === '..' || f.dir === undefined;
      if (special(a) || special(b)) fail('EBUSY', 'rename', from);
      const src = inode(a.ino as string);
      if (src.type !== 'dir' && (a.trailing || b.trailing)) fail('ENOTDIR', 'rename', from);
      const aDir = dirInode(a.dir as string);
      const bDir = dirInode(b.dir as string);
      if (src.type === 'dir' && isAncestor(src.id, bDir.id)) fail('EINVAL', 'rename', from);
      if (b.ino !== undefined && isAncestor(b.ino, aDir.id)) fail('ENOTEMPTY', 'rename', from);
      if (b.ino === src.id) return;
      if (!may(aDir, W | X) || !may(bDir, W | X)) fail('EACCES', 'rename', from);
      if (stickyDenies(aDir, src)) fail('EPERM', 'rename', from);
      const dst = b.ino === undefined ? undefined : inode(b.ino);
      if (dst && stickyDenies(bDir, dst)) fail('EPERM', 'rename', from);
      // Moving a directory to another parent rewrites its `..`, which needs write access to it.
      if (src.type === 'dir' && aDir.id !== bDir.id && !may(src, W)) fail('EACCES', 'rename', from);
      if (dst) {
        if (dst.type === 'dir' && src.type !== 'dir') fail('EISDIR', 'rename', from);
        if (src.type === 'dir' && dst.type !== 'dir') fail('ENOTDIR', 'rename', from);
        if (dst.type === 'dir' && Object.keys(dst.entries).length > 0) fail('ENOTEMPTY', 'rename', from);
        removeEntry(bDir.id, b.name, dst.type === 'dir');
        dropLink(dst.id);
      }
      removeEntry(aDir.id, a.name, src.type === 'dir');
      addEntry(bDir.id, b.name, src.id, src.type === 'dir');
      const moved = inode(src.id);
      store(moved.type === 'dir' ? { ...moved, parent: bDir.id, ctime: ctx.now } : { ...moved, ctime: ctx.now });
    },

    link(existing, newPath) {
      const a = walk(existing, 'never', false, 'link');
      const src = inode(a.ino as string);
      const b = walk(newPath, 'never', true, 'link');
      if (b.ino !== undefined) fail('EEXIST', 'link', newPath);
      // protected_hardlinks (may_linkat, before vfs_link's own checks): the owner, CAP_FOWNER, or
      // a "safe" source: a regular file, not set-user-ID or executable set-group-ID, that the
      // caller may read and write.
      if (PROTECTED.hardlinks && !isRoot && cred.uid !== src.uid) {
        const regular = src.type === 'file' || src.type === 'program';
        const setid = (src.mode & S_ISUID) !== 0 || (src.mode & (S_ISGID | 0o010)) === (S_ISGID | 0o010);
        if (!regular || setid || !may(src, R | W)) fail('EPERM', 'link', existing);
      }
      const dir = dirInode(b.dir as string);
      if (!may(dir, W | X)) fail('EACCES', 'link', newPath);
      if (src.type === 'dir') fail('EPERM', 'link', existing);
      store({ ...src, nlink: src.nlink + 1, ctime: ctx.now });
      addEntry(dir.id, b.name, src.id, false);
    },

    symlink(target, path) {
      const { dir, name } = creating('symlink', path);
      const id = nextInode(ctx, machineId);
      store({ id, type: 'symlink', target, mode: 0o777, ...newOwner(dir), mtime: ctx.now, ctime: ctx.now, nlink: 1 });
      addEntry(dir.id, name, id, false);
    },

    readlink(path) {
      const i = inode(walk(path, 'never', false, 'readlink').ino as string);
      if (i.type !== 'symlink') fail('EINVAL', 'readlink', path);
      return (i as { target: string }).target;
    },

    readdir(path) {
      const i = inode(walk(path, 'always', false, 'open').ino as string);
      if (i.type !== 'dir') fail('ENOTDIR', 'open', path);
      if (!may(i, R)) fail('EACCES', 'open', path);
      return Object.keys((i as DirInode).entries).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    },

    chmod(path, mode) {
      const found = walk(path, 'always', false, 'chmod');
      const i = inode(found.ino as string);
      if (!isRoot && cred.uid !== i.uid) fail('EPERM', 'chmod', path);
      let m = mode & 0o7777;
      // chmod(2): an unprivileged caller who is not in the file's group loses S_ISGID silently.
      if (!isRoot && i.type !== 'dir' && !inGroup(i.gid)) m &= ~S_ISGID;
      store({ ...i, mode: m, ctime: ctx.now });
      if (found.dir !== undefined) changed(found.dir);
    },

    chown(path, uid, gid) {
      const found = walk(path, 'always', false, 'chown');
      const i = inode(found.ino as string);
      if (!isRoot) {
        if (uid !== -1 && uid !== i.uid) fail('EPERM', 'chown', path);
        if (cred.uid !== i.uid) fail('EPERM', 'chown', path);
        if (gid !== -1 && gid !== i.gid && !inGroup(gid)) fail('EPERM', 'chown', path);
      }
      if (uid === -1 && gid === -1) return;
      let mode = i.mode;
      // chown(2): changing owner or group of a non-directory clears S_ISUID, and S_ISGID when the
      // group-execute bit is set; since Linux 2.2.13 this applies to root too. Verified in
      // fixtures/reference/linux/vfs-syscalls.txt ("chown own file clears suid/sgid").
      if (i.type !== 'dir') {
        mode &= ~S_ISUID;
        if (mode & 0o010) mode &= ~S_ISGID;
      }
      store({ ...i, uid: uid === -1 ? i.uid : uid, gid: gid === -1 ? i.gid : gid, mode, ctime: ctx.now });
      if (found.dir !== undefined) changed(found.dir);
    },

    utimes(path, mtime) {
      const found = walk(path, 'always', false, 'utimensat');
      const i = inode(found.ino as string);
      const owner = isRoot || cred.uid === i.uid;
      if (mtime === undefined) {
        if (!owner && !may(i, W)) fail('EACCES', 'utimensat', path);
      } else if (!owner) {
        fail('EPERM', 'utimensat', path);
      }
      store({ ...i, mtime: mtime ?? ctx.now, ctime: ctx.now });
      if (found.dir !== undefined) changed(found.dir);
    },

    access(path, mode) {
      const i = inode(walk(path, 'always', false, 'access').ino as string);
      if (mode !== 0 && !may(i, mode & 7)) fail('EACCES', 'access', path);
    },

    realpath(path) {
      const found = walk(path, 'always', false, 'realpath');
      const i = inode(found.ino as string);
      if (i.type === 'dir') return pathOf(i.id);
      // A non-directory is always reached through a real name in a directory.
      const dir = pathOf(found.dir as string);
      return `${dir === '/' ? '' : dir}/${found.name}`;
    },

    checkExec(path) {
      const i = inode(walk(path, 'always', false, 'execve').ino as string);
      if (i.type === 'dir' || !may(i, X)) fail('EACCES', 'execve', path);
      return i;
    },

    installProgram(path, program, opts) {
      const { dir, name } = creating('open', path);
      const id = nextInode(ctx, machineId);
      const stub: ProgramInode = {
        id,
        type: 'program',
        program,
        size: opts.size,
        mode: (opts.mode ?? 0o755) & ~umask & 0o7777,
        ...newOwner(dir),
        mtime: ctx.now,
        ctime: ctx.now,
        nlink: 1,
      };
      store(stub);
      addEntry(dir.id, name, id, false);
    },

    createGenerated(path, providerName, opts) {
      provider(providerName);
      const { dir, name } = creating('mknod', path);
      // mknod(2): creating a device node needs CAP_MKNOD.
      if (opts.device && !isRoot) fail('EPERM', 'mknod', path);
      const id = nextInode(ctx, machineId);
      store({
        id,
        type: 'generated',
        provider: providerName,
        args: opts.args ?? null,
        ...(opts.device ? { device: { ...opts.device } } : {}),
        mode: opts.mode & ~umask & 0o7777,
        ...newOwner(dir),
        mtime: ctx.now,
        ctime: ctx.now,
        nlink: 1,
      });
      addEntry(dir.id, name, id, false);
    },
  };

  /** Absolute path of a directory inode, without permission checks. */
  function pathOf(dirId: string): string {
    const parts: string[] = [];
    for (let id = dirId; id !== vfs.root; ) {
      const p = dirInode(dirInode(id).parent);
      const name = Object.keys(p.entries).find((n) => p.entries[n] === id) as string;
      parts.unshift(name);
      id = p.id;
    }
    return `/${parts.join('/')}`;
  }

  return fs;
}
