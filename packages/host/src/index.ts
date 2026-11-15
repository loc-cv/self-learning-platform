// Simulated Linux machines: VFS, shell, TTY, coreutils, systemd, processes.
// Specified in docs/ARCHITECTURE.md §3. Phase 01 built machines and the VFS, phase 02 the shell and
// coreutils, phase 03 the terminal, completion and the editor protocol.

export const packageName = '@simlab/host';

export { buildUbuntuBase, type UbuntuBaseOptions } from './base/ubuntu.ts';
export { createMachine, getMachine, hostSlice, type HostSlice, type Machine } from './machine.ts';
export { hostPlugin, HOST_SLICE_VERSION } from './plugin.ts';
export * from './users.ts';
export { utf8Length } from './utf8.ts';
export * from './vfs/errno.ts';
export { ACCESS, createFs, MAXSYMLINKS, NAME_MAX, PATH_MAX, type Fs, type FsOptions, type WriteOptions } from './vfs/fs.ts';
export { FILE_PROVIDER, type FileProviderSpec } from './vfs/provider.ts';
export * from './vfs/types.ts';
export * from './transcript/format.ts';
export * from './transcript/runner.ts';
export * from './transcript/session.ts';
export { openTerminal, type Terminal, type TerminalOptions } from './proc/terminal.ts';
export * from './proc/program.ts';
export * from './proc/types.ts';
export { simNotice, SIM_STATUS } from './proc/notice.ts';
export { createScreen, type Screen } from './tty/screen.ts';
export { COMPLETION, type CompleterSpec, type CompletionRequest, type CompletionResult } from './tty/complete.ts';
export type { EditorRequest, EditorResult } from './proc/editor.ts';
export { ubuntu1Topology } from './topology.ts';
