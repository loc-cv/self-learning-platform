// A simulated Linux host (docs/ARCHITECTURE.md §3.1). Later phases add processes, units, packages,
// network interfaces and listeners. Users, groups and the system-wide environment are not fields
// here: like on Linux they are the contents of /etc/passwd, /etc/group and /etc/environment
// (docs/decisions.md D-019).

import { put, type Ctx, type Millis } from '@simlab/kernel';
import type { DirInode, Vfs } from './vfs/types.ts';

export interface Machine {
  id: string;
  /** The kernel's hostname (`uname -n`), not /etc/hostname, which is only read at boot. */
  hostname: string;
  kind: 'node' | 'workstation' | 'container';
  vfs: Vfs;
  boot: { bootedAt: Millis; state: 'running' | 'off' };
}

export interface HostSlice {
  machines: Record<string, Machine>;
}

export function hostSlice(ctx: Ctx): HostSlice {
  return ctx.slice<HostSlice>('host');
}

export function getMachine(ctx: Ctx, id: string): Machine {
  const m = hostSlice(ctx).machines[id];
  if (!m) throw new Error(`no machine ${id}`);
  return m;
}

/** Inode numbers come from a world counter per machine; the root is 2, as on ext4. */
export function nextInode(ctx: Ctx, machineId: string): string {
  return String(ctx.nextId(`host.ino:${machineId}`) + 1);
}

/** Creates a machine with an empty root directory (mode 0755, owned by root). */
export function createMachine(
  ctx: Ctx,
  spec: { id: string; hostname: string; kind: Machine['kind'] },
): Machine {
  const slice = hostSlice(ctx);
  if (slice.machines[spec.id]) throw new Error(`machine ${spec.id} already exists`);
  const rootId = nextInode(ctx, spec.id);
  const vfs: Vfs = { root: rootId, inodes: {} };
  const root: DirInode = {
    id: rootId,
    type: 'dir',
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: ctx.now,
    ctime: ctx.now,
    nlink: 2,
    entries: {},
    parent: rootId,
  };
  put(vfs.inodes, rootId, root);
  const machine: Machine = {
    id: spec.id,
    hostname: spec.hostname,
    kind: spec.kind,
    vfs,
    boot: { bootedAt: ctx.now, state: 'running' },
  };
  slice.machines[spec.id] = machine;
  return machine;
}
