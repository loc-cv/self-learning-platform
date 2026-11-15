// Reference counting for what descriptors point at: streams (pipes) and open file descriptions.
// A stream with no writers reads as end of file; one with no readers raises SIGPIPE in a writer
// (pipe(7)). An open file description lives while a descriptor refers to it; when the last one
// closes, an inode that was unlinked meanwhile is deleted (unlink(2)).

import { put, remove, type Ctx } from '@simlab/kernel';
import { getMachine, hostSlice, type Machine } from '../machine.ts';
import type { Fd, OpenFile, Stream } from './types.ts';

/** pipe(7): "the pipe capacity is 16 pages (i.e., 65,536 bytes in a system with a page size of 4096 bytes)". */
export const PIPE_CAPACITY = 65_536;

export const streamTopic = (id: string): string => `host.stream:${id}`;
export const ttyTopic = (id: string): string => `host.tty:${id}`;

export function createStream(ctx: Ctx, machine: string): Stream {
  const id = String(ctx.nextId('host.stream'));
  const s: Stream = { id, machine, data: '', capacity: PIPE_CAPACITY, readers: 0, writers: 0 };
  return put(hostSlice(ctx).streams, id, s);
}

/** A stream holding `data` with no writer: a reader gets the data, then end of file (here-documents). */
export function createFilledStream(ctx: Ctx, machine: string, data: string): Stream {
  const s = createStream(ctx, machine);
  return storeStream(ctx, { ...s, data, capacity: Math.max(PIPE_CAPACITY, data.length) });
}

export function getStream(ctx: Ctx, id: string): Stream {
  const s = hostSlice(ctx).streams[id];
  if (!s) throw new Error(`no stream ${id}`);
  return s;
}

export function storeStream(ctx: Ctx, s: Stream): Stream {
  return put(hostSlice(ctx).streams, s.id, s);
}

export function createOpenFile(ctx: Ctx, machine: Machine, spec: Omit<OpenFile, 'id' | 'refs'>): OpenFile {
  const id = String(ctx.nextId(`host.ofd:${machine.id}`));
  return put(machine.files, id, { ...spec, id, refs: 0 });
}

/** One more descriptor refers to what `fd` refers to (dup, inheritance at spawn). */
export function retain(ctx: Ctx, machineId: string, fd: Fd): void {
  switch (fd.kind) {
    case 'stream': {
      const s = getStream(ctx, fd.stream);
      storeStream(ctx, fd.end === 'read' ? { ...s, readers: s.readers + 1 } : { ...s, writers: s.writers + 1 });
      return;
    }
    case 'file': {
      const m = getMachine(ctx, machineId);
      const f = m.files[fd.file];
      if (!f) throw new Error(`no open file ${fd.file} on ${machineId}`);
      put(m.files, f.id, { ...f, refs: f.refs + 1 });
      return;
    }
    case 'tty':
      return;
  }
}

/** A descriptor that referred to `fd` is closed. */
export function release(ctx: Ctx, machineId: string, fd: Fd): void {
  switch (fd.kind) {
    case 'stream': {
      const s = getStream(ctx, fd.stream);
      const next = fd.end === 'read' ? { ...s, readers: s.readers - 1 } : { ...s, writers: s.writers - 1 };
      if (next.readers <= 0 && next.writers <= 0) remove(hostSlice(ctx).streams, s.id);
      else storeStream(ctx, next);
      // Readers waiting for data see end of file; writers waiting for room see SIGPIPE.
      ctx.publish(streamTopic(s.id));
      return;
    }
    case 'file': {
      const m = getMachine(ctx, machineId);
      const f = m.files[fd.file];
      if (!f) throw new Error(`no open file ${fd.file} on ${machineId}`);
      if (f.refs > 1) {
        put(m.files, f.id, { ...f, refs: f.refs - 1 });
        return;
      }
      remove(m.files, f.id);
      const ino = m.vfs.inodes[f.inode];
      if (ino && ino.nlink === 0 && !Object.keys(m.files).some((k) => m.files[k]?.inode === f.inode)) {
        remove(m.vfs.inodes, f.inode);
      }
      return;
    }
    case 'tty':
      return;
  }
}
