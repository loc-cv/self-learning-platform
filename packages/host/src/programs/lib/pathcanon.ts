// Canonical paths where the last components may not exist, and relative paths between canonical
// ones, as `ln -r` computes them.
//   upstream: gnulib lib/canonicalize.c canonicalize_filename_mode (CAN_MISSING);
//             coreutils 9.4 src/relpath.c relpath

import type { Fs } from '../../vfs/fs.ts';
import { attempt } from './fsutil.ts';

const MAX_LINKS = 40;

/** canonicalize_filename_mode(path, CAN_MISSING): symbolic links resolved where they exist. */
export function canonicalizeMissing(fs: Fs, cwd: string, path: string): string {
  const parts: string[] = [];
  let queue = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/').filter((c) => c !== '');
  let links = 0;
  while (queue.length > 0) {
    const c = queue.shift() as string;
    if (c === '.') continue;
    if (c === '..') {
      parts.pop();
      continue;
    }
    const candidate = `/${[...parts, c].join('/')}`;
    const st = attempt(() => fs.lstat(candidate));
    if (st.ok && st.value.type === 'symlink' && links++ < MAX_LINKS) {
      const target = fs.readlink(candidate);
      if (target.startsWith('/')) parts.length = 0;
      queue = [...target.split('/').filter((x) => x !== ''), ...queue];
      continue;
    }
    parts.push(c);
  }
  return `/${parts.join('/')}`;
}

/** relpath: `fname` relative to the directory `reldir`, both canonical. */
export function relativePath(fname: string, reldir: string): string {
  const f = fname.split('/').filter((c) => c !== '');
  const d = reldir.split('/').filter((c) => c !== '');
  let common = 0;
  while (common < f.length && common < d.length && f[common] === d[common]) common++;
  const up = d.slice(common).map(() => '..');
  const rest = f.slice(common);
  if (up.length > 0) return [...up, ...rest].join('/');
  return rest.length > 0 ? rest.join('/') : '.';
}
