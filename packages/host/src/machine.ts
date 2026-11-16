// A simulated Linux host (docs/ARCHITECTURE.md §3.1). Later phases add processes, units, packages,
// network interfaces and listeners. Users, groups and the system-wide environment are not fields
// here: like on Linux they are the contents of /etc/passwd, /etc/group and /etc/environment
// (docs/decisions.md D-019).

import { put, type Ctx, type Millis, type Table } from '@simlab/kernel';
import type { EditorSession } from './proc/editor.ts';
import type { OpenFile, Proc, Stream, Tty } from './proc/types.ts';
import type { DirInode, Vfs } from './vfs/types.ts';

export interface Machine {
  id: string;
  /** The kernel's hostname (`uname -n`), not /etc/hostname, which is only read at boot. */
  hostname: string;
  kind: 'node' | 'workstation' | 'container';
  vfs: Vfs;
  /** Processes by pid (proc/types.ts). */
  procs: Table<Proc>;
  /** Open file descriptions by id: what a file descriptor of kind `file` points at. */
  files: Table<OpenFile>;
  boot: { bootedAt: Millis; state: 'running' | 'off' };
  /**
   * IPv4 addresses of the machine's interface, besides loopback. A stand-in until phase 17
   * models interfaces and listeners: clients use it to tell which machine an address reaches.
   */
  addresses?: string[];
}

export interface HostSlice {
  machines: Record<string, Machine>;
  /** Pipes and other byte channels, by id. */
  streams: Table<Stream>;
  /** Terminals, by id. */
  ttys: Table<Tty>;
  /** Open editor sessions (proc/editor.ts), by id. */
  editors: Table<EditorSession>;
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
  spec: { id: string; hostname: string; kind: Machine['kind']; addresses?: string[] },
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
    procs: {},
    files: {},
    boot: { bootedAt: ctx.now, state: 'running' },
    ...(spec.addresses ? { addresses: [...spec.addresses] } : {}),
  };
  slice.machines[spec.id] = machine;
  return machine;
}
