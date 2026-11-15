// The host plugin: the `host` slice and the file providers machines need from the start.

import { put, type Plugin, type SliceSpec } from '@simlab/kernel';
import type { HostSlice } from './machine.ts';
import { PROGRAM } from './proc/program.ts';
import { attachProcesses, RUN, runHandler, ttyInput } from './proc/runtime.ts';
import { openTerminal } from './proc/terminal.ts';
import { PROGRAMS } from './programs/index.ts';
import { FILE_PROVIDER, type FileProviderSpec } from './vfs/provider.ts';

export const HOST_SLICE_VERSION = 1;

const hostSliceSpec: SliceSpec<HostSlice> = {
  name: 'host',
  version: HOST_SLICE_VERSION,
  init: () => ({ machines: {}, streams: {}, ttys: {} }),
  adopt(slice) {
    const refreeze = <V>(table: Record<string, V>): void => {
      for (const k of Object.keys(table)) put(table, k, table[k] as V);
    };
    for (const id of Object.keys(slice.machines)) {
      const m = slice.machines[id];
      if (!m) continue;
      refreeze(m.vfs.inodes);
      refreeze(m.procs);
      refreeze(m.files);
    }
    refreeze(slice.streams);
    refreeze(slice.ttys);
  },
  attach: attachProcesses,
};

/**
 * /dev/null, character device 1,3. Reads return end of file; writes succeed and are discarded.
 * docs: null(4); reference: `stat -c %t,%T /dev/null` prints `1,3` on the workstation, captured 2026-11-15
 */
const nullDevice: FileProviderSpec = {
  name: 'host.null',
  read: () => '',
  write: () => {},
};

export const hostPlugin: Plugin = {
  name: 'host',
  slice: hostSliceSpec as SliceSpec<unknown>,
  handlers: [{ type: RUN, handle: runHandler }],
  inputs: [
    {
      kind: 'tty.open',
      handle(ctx, input) {
        const { tty, machine, user, cols, rows } = input as unknown as { tty: string; machine: string; user: string; cols: number; rows: number };
        openTerminal(ctx, { id: tty, machine, user, cols, rows });
      },
    },
    {
      kind: 'tty.bytes',
      handle(ctx, input) {
        const { tty, data } = input as unknown as { tty: string; data: string };
        ttyInput(ctx, tty, data);
      },
    },
  ],
  contributions: { [FILE_PROVIDER]: [nullDevice], [PROGRAM]: PROGRAMS },
};
