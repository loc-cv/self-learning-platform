// Putting a file into a machine before a session starts, as if the user had written it there:
// how transcripts (`# file:`) and `npm run sim -- --file` give a session its manifests and
// scripts. The file is created by the user's credentials and umask 022 in their home directory
// (or the relative path below it), so it looks as the user's editor would have left it.
// Test and tool support: no program uses it.

import type { Ctx } from '@simlab/kernel';
import { credFor, userByName } from '../users.ts';
import { createFs } from '../vfs/fs.ts';
import { FsError } from '../vfs/errno.ts';

/** Writes `content` at `path` (relative to the user's home), creating missing directories. */
export function placeFile(ctx: Ctx, machine: string, user: string, path: string, content: string): void {
  const entry = userByName(ctx, machine, user);
  if (!entry) throw new Error(`machine ${machine}: no user ${user}`);
  const fs = createFs(ctx, machine, { cred: credFor(ctx, machine, user), umask: 0o022, cwd: entry.home });
  const parts = path.split('/').filter((s) => s !== '');
  let dir = path.startsWith('/') ? '' : entry.home;
  for (const part of parts.slice(0, -1)) {
    dir = `${dir}/${part}`;
    try {
      fs.mkdir(dir);
    } catch (e) {
      if (!(e instanceof FsError) || e.code !== 'EEXIST') throw e;
    }
  }
  fs.writeFile(path.startsWith('/') ? path : `${entry.home}/${path}`, content);
}
