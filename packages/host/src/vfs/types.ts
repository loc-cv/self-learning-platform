// VFS data shapes (docs/ARCHITECTURE.md §3.2). Inodes are frozen values in a table; changing one
// stores a new value under the same id, so a fork that still holds the old inode keeps the old
// content without copying it.

import type { Json, Millis, Table } from '@simlab/kernel';

export interface InodeMeta {
  /** Inode number, as a decimal string. */
  id: string;
  /** Permission bits including set-user-ID, set-group-ID and sticky (07777), as chmod sees them. */
  mode: number;
  uid: number;
  gid: number;
  mtime: Millis;
  ctime: Millis;
  nlink: number;
}

export type DirInode = InodeMeta & {
  type: 'dir';
  /** Name → inode id. `.` and `..` are implicit. */
  entries: Record<string, string>;
  /** Inode id of the directory that holds this one; the root's parent is itself. */
  parent: string;
};
export type FileInode = InodeMeta & { type: 'file'; data: string };
export type SymlinkInode = InodeMeta & { type: 'symlink'; target: string };
/** An executable stub: running it runs the registered program of that name. */
export type ProgramInode = InodeMeta & { type: 'program'; program: string; size: number };
/**
 * Content computed on read (and accepted on write) by a registered `fileProvider`. With `device`
 * set it is a character device such as `/dev/null`.
 */
export type GeneratedInode = InodeMeta & {
  type: 'generated';
  provider: string;
  args: Json;
  device?: { major: number; minor: number };
};

export type Inode = DirInode | FileInode | SymlinkInode | ProgramInode | GeneratedInode;

export interface Vfs {
  /** Inode id of `/`. */
  root: string;
  inodes: Table<Inode>;
}

/** What `stat(2)` reports, plus the simulator's inode kind. */
export interface Stat {
  ino: string;
  /** The file type as Linux reports it. */
  type: 'file' | 'dir' | 'symlink' | 'char';
  /** The simulator's inode type: `program` and `generated` report as `file` or `char`. */
  kind: Inode['type'];
  mode: number;
  uid: number;
  gid: number;
  size: number;
  nlink: number;
  mtime: Millis;
  ctime: Millis;
  rdev?: { major: number; minor: number };
}

/** Who is asking: the effective user, group and supplementary groups of a process. */
export interface Cred {
  uid: number;
  gid: number;
  groups: readonly number[];
}

export const ROOT_CRED: Cred = Object.freeze({ uid: 0, gid: 0, groups: Object.freeze([0]) });
