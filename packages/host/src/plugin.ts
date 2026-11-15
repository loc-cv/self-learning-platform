// The host plugin: the `host` slice and the file providers machines need from the start.

import { put, type Plugin, type SliceSpec } from '@simlab/kernel';
import type { HostSlice } from './machine.ts';
import { FILE_PROVIDER, type FileProviderSpec } from './vfs/provider.ts';

export const HOST_SLICE_VERSION = 1;

const hostSliceSpec: SliceSpec<HostSlice> = {
  name: 'host',
  version: HOST_SLICE_VERSION,
  init: () => ({ machines: {} }),
  adopt(slice) {
    for (const id of Object.keys(slice.machines)) {
      const inodes = slice.machines[id]?.vfs.inodes ?? {};
      for (const ino of Object.keys(inodes)) put(inodes, ino, inodes[ino]);
    }
  },
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
  contributions: { [FILE_PROVIDER]: [nullDevice] },
};
