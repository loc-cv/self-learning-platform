// Small file system helpers the file programs (mkdir, touch, rm, chmod, ln, cp, mv, chown) share.

import type { ProcApi } from '../../proc/program.ts';
import { createFs, type Fs } from '../../vfs/fs.ts';
import { isFsError, type Errno } from '../../vfs/errno.ts';
import type { Stat } from '../../vfs/types.ts';
import { quoteaf } from './quote.ts';

/** The process's file system with a different umask, as after umask(2) in the program. */
export function fsWithUmask(p: ProcApi, umask: number): Fs {
  return createFs(p.ctx, p.machine, { cred: p.cred, cwd: p.cwd, umask });
}

/** The process's umask. */
export const umaskOf = (p: ProcApi): number => p.proc.umask;

export type Try<T> = { ok: true; value: T } | { ok: false; code: Errno };

/** Runs a file system call, turning an `FsError` into its code. */
export function attempt<T>(f: () => T): Try<T> {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (isFsError(e)) return { ok: false, code: e.code };
    throw e;
  }
}

export function statOrNull(fs: Fs, path: string, follow = true): Stat | null {
  const r = attempt(() => (follow ? fs.stat(path) : fs.lstat(path)));
  return r.ok ? r.value : null;
}

/** dirname(3) of a path as coreutils' dir_name computes it (`a/b/` → `a`, `a` → `.`). */
export function dirName(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  const slash = path.lastIndexOf('/', end - 1);
  if (slash < 0) return '.';
  let d = slash;
  while (d > 0 && path[d - 1] === '/') d--;
  return d === 0 ? '/' : path.slice(0, d);
}

/** last_component / base_name: the final component without trailing slashes (`a/b/` → `b`). */
export function baseName(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  const s = path.slice(0, end);
  if (s === '/') return '/';
  return s.slice(s.lastIndexOf('/') + 1);
}

/** file_name_concat(dir, base): one slash between them, none added after a trailing slash. upstream: gnulib lib/filenamecat-lgpl.c */
export function joinPath(dir: string, base: string): string {
  if (dir.endsWith('/')) return dir + base.replace(/^\/+/, '');
  return `${dir}/${base.replace(/^\/+/, '')}`;
}

/** True when the two stats name the same file (SAME_INODE). */
export const sameInode = (a: Stat, b: Stat): boolean => a.ino === b.ino;

/**
 * file_type(3) of gnulib as rm, cp and mv name files in prompts and messages.
 * upstream: gnulib lib/file-type.c
 */
export function fileTypeName(st: Stat): string {
  switch (st.type) {
    case 'file':
      return st.size === 0 ? 'regular empty file' : 'regular file';
    case 'dir':
      return 'directory';
    case 'symlink':
      return 'symbolic link';
    case 'char':
      return 'character special file';
  }
}

/** Inode id of `/`, for --preserve-root (get_root_dev_ino). */
export function rootIno(fs: Fs): string {
  return fs.stat('/').ino;
}

/**
 * ROOT_DEV_INO_WARN: the two lines chmod, chown and rm print before refusing to work
 * recursively on `/`. upstream: coreutils 9.4 src/root-dev-ino.h
 */
export function rootWarning(name: string): string[] {
  return [
    name === '/'
      ? `it is dangerous to operate recursively on ${quoteaf(name)}`
      : `it is dangerous to operate recursively on ${quoteaf(name)} (same as ${quoteaf('/')})`,
    'use --no-preserve-root to override this failsafe',
  ];
}

/** fts_open trims two or more trailing slashes of a command-line argument to one. upstream: gnulib lib/fts.c fts_open */
export function ftsTrim(path: string): string {
  let len = path.length;
  if (len > 2 && path[len - 1] === '/') while (len > 1 && path[len - 2] === '/') len--;
  return path.slice(0, len);
}
