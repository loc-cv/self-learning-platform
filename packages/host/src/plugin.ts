// The host plugin: the `host` slice and the file providers machines need from the start.

import { CHECK, put, STEP, TOPOLOGY, type Contribution, type Plugin, type SliceSpec } from '@simlab/kernel';
import type { HostSlice } from './machine.ts';
import { PROGRAM } from './proc/program.ts';
import { attachProcesses, RUN, runHandler } from './proc/runtime.ts';
import { ttyClose, ttyInput, ttyResize } from './tty/discipline.ts';
import { openTerminal } from './proc/terminal.ts';
import { editorClose, editorSave } from './proc/editor.ts';
import { PROGRAMS } from './programs/index.ts';
import { GENERIC_MODELS } from './models/programs.ts';
import { IMAGE_MODELS } from './models/images/index.ts';
import { BEHAVIOR_MODEL } from './models/types.ts';
import { bashCompleter } from './shell/complete.ts';
import { COMPLETION } from './tty/complete.ts';
import { ubuntu1Topology } from './topology.ts';
import { FILE_PROVIDER, type FileProviderSpec } from './vfs/provider.ts';
import { HOST_CHECKS } from './scenario/checks.ts';
import { HOST_STEPS } from './scenario/steps.ts';

/** 2: terminals gained modes and the line editor; editor sessions (phase 03). */
export const HOST_SLICE_VERSION = 2;

const hostSliceSpec: SliceSpec<HostSlice> = {
  name: 'host',
  version: HOST_SLICE_VERSION,
  init: () => ({ machines: {}, streams: {}, ttys: {}, editors: {} }),
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
    refreeze(slice.editors);
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
    {
      kind: 'tty.resize',
      handle(ctx, input) {
        const { tty, cols, rows } = input as unknown as { tty: string; cols: number; rows: number };
        ttyResize(ctx, tty, cols, rows);
      },
    },
    {
      kind: 'editor.save',
      handle(ctx, input) {
        const { session, content } = input as unknown as { session: string; content: string };
        editorSave(ctx, session, content);
      },
    },
    {
      kind: 'editor.close',
      handle(ctx, input) {
        editorClose(ctx, (input as unknown as { session: string }).session);
      },
    },
    {
      kind: 'tty.close',
      handle(ctx, input) {
        ttyClose(ctx, (input as unknown as { tty: string }).tty);
      },
    },
  ],
  contributions: { [FILE_PROVIDER]: [nullDevice], [PROGRAM]: PROGRAMS, [BEHAVIOR_MODEL]: [...GENERIC_MODELS, ...IMAGE_MODELS], [COMPLETION]: [bashCompleter], [TOPOLOGY]: [ubuntu1Topology], [STEP]: [...HOST_STEPS] as unknown as Contribution[], [CHECK]: [...HOST_CHECKS] as unknown as Contribution[] },
};
