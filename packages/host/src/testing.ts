// Test support: a kernel with the host plugin and one Ubuntu machine. Not exported from the package.

import { bootKernel, createRegistry, DEFAULT_START_TIME, type Ctx, type Kernel, type Plugin } from '@simlab/kernel';
import { buildUbuntuBase } from './base/ubuntu.ts';
import { createMachine } from './machine.ts';
import { hostPlugin } from './plugin.ts';
import { credFor } from './users.ts';
import { createFs, type Fs } from './vfs/fs.ts';
import { ROOT_CRED } from './vfs/types.ts';

export function bootHost(plugins: Plugin[] = [], machines = ['node01']): Kernel {
  const k = bootKernel(createRegistry([hostPlugin, ...plugins]), { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('setup', (ctx) => {
    for (const id of machines) {
      createMachine(ctx, { id, hostname: id, kind: 'node' });
      buildUbuntuBase(ctx, id, { user: { name: 'student' } });
    }
  });
  return k;
}

/** Runs `fn` with a file system as `user` ('root' or a name in /etc/passwd). */
export function asUser<T>(k: Kernel, user: string, fn: (fs: Fs, ctx: Ctx) => T, opts: { cwd?: string; umask?: number; machine?: string } = {}): T {
  return k.act('test', (ctx) => {
    const machine = opts.machine ?? 'node01';
    const cred = user === 'root' ? ROOT_CRED : credFor(ctx, machine, user);
    const fs = createFs(ctx, machine, { cred, umask: opts.umask ?? 0o002, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    return fn(fs, ctx);
  });
}
