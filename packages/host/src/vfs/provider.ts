// Generated files (docs/ARCHITECTURE.md §3.2): content computed from the world when read, and,
// where the real file is writable, applied to the world when written. Registered under the
// registry kind `fileProvider`.

import type { Contribution, Ctx, Json } from '@simlab/kernel';
import type { Machine } from '../machine.ts';

export interface FileProviderSpec extends Contribution {
  /** A pure function of the world. */
  read(ctx: Ctx, machine: Machine, args: Json): string;
  /** Absent when the simulator does not model writing this file; a write is then a `[sim]` gap. May throw `FsError`. */
  write?(ctx: Ctx, machine: Machine, args: Json, data: string, append: boolean): void;
}

export const FILE_PROVIDER = 'fileProvider';
