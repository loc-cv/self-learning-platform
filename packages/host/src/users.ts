// Users and groups are the contents of /etc/passwd and /etc/group, as with glibc's NSS `files`
// backend (docs/decisions.md D-019). Editing either file changes who exists; nothing else holds
// the truth. Parsed forms are cached by the identity of the frozen inode they came from, a derived
// cache outside world state (docs/ARCHITECTURE.md §2.12).
// docs: passwd(5), group(5) (man-pages on the workstation)

import type { Ctx } from '@simlab/kernel';
import { isFsError } from './vfs/errno.ts';
import { createFs } from './vfs/fs.ts';
import { ROOT_CRED, type Cred, type Inode } from './vfs/types.ts';

export interface PasswdEntry {
  name: string;
  password: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  password: string;
  gid: number;
  members: string[];
}

/** Lines that do not have the right number of fields or numeric ids are skipped, as NSS does. */
export function parsePasswd(text: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length !== 7) continue;
    const [name, password, uid, gid, gecos, home, shell] = f as [string, string, string, string, string, string, string];
    if (name === '' || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) continue;
    out.push({ name, password, uid: Number(uid), gid: Number(gid), gecos, home, shell });
  }
  return out;
}

export function parseGroup(text: string): GroupEntry[] {
  const out: GroupEntry[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length !== 4) continue;
    const [name, password, gid, members] = f as [string, string, string, string];
    if (name === '' || !/^\d+$/.test(gid)) continue;
    out.push({ name, password, gid: Number(gid), members: members === '' ? [] : members.split(',') });
  }
  return out;
}

export function formatPasswd(entries: readonly PasswdEntry[]): string {
  return entries.map((e) => `${e.name}:${e.password}:${e.uid}:${e.gid}:${e.gecos}:${e.home}:${e.shell}\n`).join('');
}

export function formatGroup(entries: readonly GroupEntry[]): string {
  return entries.map((e) => `${e.name}:${e.password}:${e.gid}:${e.members.join(',')}\n`).join('');
}

const passwdCache = new WeakMap<Inode, PasswdEntry[]>();
const groupCache = new WeakMap<Inode, GroupEntry[]>();

/**
 * The parsed file, or [] if it is missing or not a regular file. Resolved as root: both files are
 * world-readable on a real system, and a broken mode is a scenario for a later phase.
 */
function readTable<T>(ctx: Ctx, machineId: string, path: string, parse: (t: string) => T[], cache: WeakMap<Inode, T[]>): T[] {
  let file: Inode | undefined;
  try {
    const fs = createFs(ctx, machineId, { cred: ROOT_CRED, umask: 0 });
    file = fs.machine.vfs.inodes[fs.stat(path).ino];
  } catch (e) {
    if (isFsError(e)) return [];
    throw e;
  }
  if (file?.type !== 'file') return [];
  const hit = cache.get(file);
  if (hit) return hit;
  const parsed = parse(file.data);
  cache.set(file, parsed);
  return parsed;
}

export function passwdEntries(ctx: Ctx, machineId: string): PasswdEntry[] {
  return readTable(ctx, machineId, '/etc/passwd', parsePasswd, passwdCache);
}

export function groupEntries(ctx: Ctx, machineId: string): GroupEntry[] {
  return readTable(ctx, machineId, '/etc/group', parseGroup, groupCache);
}

export function userByName(ctx: Ctx, machineId: string, name: string): PasswdEntry | undefined {
  return passwdEntries(ctx, machineId).find((e) => e.name === name);
}

export function userByUid(ctx: Ctx, machineId: string, uid: number): PasswdEntry | undefined {
  return passwdEntries(ctx, machineId).find((e) => e.uid === uid);
}

export function groupByGid(ctx: Ctx, machineId: string, gid: number): GroupEntry | undefined {
  return groupEntries(ctx, machineId).find((e) => e.gid === gid);
}

/**
 * Credentials of a login as `name`: the primary group from /etc/passwd plus every group that lists
 * the user as a member, in /etc/group order (initgroups(3)).
 */
export function credFor(ctx: Ctx, machineId: string, name: string): Cred {
  const user = userByName(ctx, machineId, name);
  if (!user) throw new Error(`machine ${machineId}: no user ${name} in /etc/passwd`);
  const groups = [user.gid];
  for (const g of groupEntries(ctx, machineId)) {
    if (g.members.includes(name) && !groups.includes(g.gid)) groups.push(g.gid);
  }
  return { uid: user.uid, gid: user.gid, groups };
}
