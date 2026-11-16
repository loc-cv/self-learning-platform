// What a container's PATH lookup and entrypoint can find in an image: the entries of the PATH
// directories and the entrypoint scripts, from the union of the image's layers. Pure; files.test.ts.

import { byCodeUnit } from './catalog.ts';
import { children, normalizePath, resolvePath, type Fs } from './tar.ts';

/**
 * The PATH directories of the official images' Env (e.g. nginx, httpd, redis, busybox, alpine:
 * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin).
 */
export const PATH_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

/** Files whose text later code reads (container log lines come from them). */
export function isScript(path: string): boolean {
  return (
    path === '/docker-entrypoint.sh' ||
    path.startsWith('/docker-entrypoint.d/') ||
    path === '/usr/local/bin/httpd-foreground' ||
    path === '/usr/local/bin/docker-entrypoint.sh'
  );
}

export interface FileRecord {
  path: string;
  type: 'file' | 'symlink' | 'hardlink';
  /** Permission bits, octal. */
  mode: string;
  /** Symlink text as stored, or a hardlink's target path. */
  target?: string;
  /** The absolute path the link finally names (symlinks followed). */
  resolved?: string;
  /** A regular file with an execute bit, or a link to one. */
  executable: boolean;
}

export interface DirRecord {
  path: string;
  /** dir, a symlink (with its text and resolved path), or missing. */
  type: 'dir' | 'symlink' | 'missing';
  target?: string;
  resolved?: string;
}

export interface ImageFiles {
  dirs: DirRecord[];
  files: FileRecord[];
  /** Scripts by path (see isScript), as text. */
  scripts: Record<string, string>;
}

function modeString(m: number): string {
  return m.toString(8).padStart(4, '0');
}

/** The regular file a path ends at, following symlinks and hardlinks. */
function finalFile(fs: Fs, path: string): { path: string; mode: number } | undefined {
  let p: string | undefined = path;
  for (let i = 0; i < 40 && p !== undefined; i++) {
    const r = resolvePath(fs, p);
    if (r === undefined) return undefined;
    const n = fs.get(r);
    if (n === undefined) return undefined;
    if (n.type === 'file') return { path: r, mode: n.mode };
    if (n.type === 'hardlink' && n.linkname !== undefined) p = n.linkname;
    else return undefined;
  }
  return undefined;
}

function record(fs: Fs, path: string): FileRecord | undefined {
  const n = fs.get(path);
  if (n === undefined || n.type === 'dir' || n.type === 'other') return undefined;
  const target = finalFile(fs, path);
  const executable = target !== undefined && (target.mode & 0o111) !== 0;
  if (n.type === 'file') return { path, type: 'file', mode: modeString(n.mode), executable };
  const resolved = n.type === 'symlink' ? resolvePath(fs, path) : n.linkname !== undefined ? resolvePath(fs, n.linkname) : undefined;
  return {
    path,
    type: n.type,
    mode: modeString(n.mode),
    ...(n.linkname !== undefined ? { target: n.linkname } : {}),
    ...(resolved !== undefined ? { resolved } : {}),
    executable,
  };
}

/** The directories of a PATH=… entry in an image config's Env, normalized, in order. */
export function envPathDirs(env: readonly string[]): string[] {
  const path = env.find((e) => e.startsWith('PATH='));
  if (path === undefined) return [];
  return path.slice(5).split(':').filter((d) => d.startsWith('/')).map(normalizePath);
}

/** How to list an image: what to read beyond the standard PATH directories. */
export interface ListOptions {
  /** Directories of the image config's own PATH (containerd uses it for the process), deduplicated with PATH_DIRS. */
  envPath?: readonly string[];
  /** Also every executable regular file anywhere (distroless and scratch images have few). */
  allExecutables?: boolean;
}

/** The directories listed: PATH_DIRS, then the image's own PATH entries not already among them. */
export function listedDirs(opts: ListOptions): string[] {
  const out = [...PATH_DIRS];
  for (const d of opts.envPath ?? []) if (!out.includes(d)) out.push(d);
  return out;
}

export function imageFiles(fs: Fs, opts: ListOptions = {}): ImageFiles {
  const dirs: DirRecord[] = [];
  const paths = new Set<string>();
  for (const d of listedDirs(opts)) {
    const own = fs.get(d);
    const parentResolved = resolvePath(fs, d, false);
    if (own?.type === 'symlink' && own.linkname !== undefined) {
      const resolved = resolvePath(fs, d);
      dirs.push({ path: d, type: 'symlink', target: own.linkname, ...(resolved !== undefined ? { resolved } : {}) });
    } else if (parentResolved !== undefined && parentResolved !== d && fs.get(parentResolved)?.type === 'dir') {
      // a parent is a symlink (e.g. /usr/local → somewhere): record where the directory really is
      dirs.push({ path: d, type: 'symlink', resolved: parentResolved });
    } else {
      dirs.push({ path: d, type: own?.type === 'dir' ? 'dir' : 'missing' });
    }
    const real = resolvePath(fs, d);
    if (real !== undefined && fs.get(real)?.type === 'dir') for (const c of children(fs, real)) paths.add(c);
  }
  for (const c of children(fs, '/')) {
    const r = record(fs, c);
    if (r !== undefined && (r.executable || c.startsWith('/docker-entrypoint'))) paths.add(c);
  }
  for (const c of children(fs, '/docker-entrypoint.d')) paths.add(c);
  if (opts.allExecutables === true) for (const [p, n] of fs) if (n.type === 'file' && (n.mode & 0o111) !== 0) paths.add(p);
  const files: FileRecord[] = [];
  for (const p of [...paths].sort(byCodeUnit)) {
    const r = record(fs, p);
    if (r !== undefined) files.push(r);
  }
  const scripts: Record<string, string> = {};
  for (const [p, n] of [...fs.entries()].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    if (n.type === 'file' && n.content !== undefined && isScript(p)) scripts[p] = new TextDecoder().decode(n.content);
  }
  return { dirs, files, scripts };
}

/** The engine's summary: executable paths, and every link (PATH directories included) → its resolved path. */
export function executablesAndLinks(f: ImageFiles): { executables: string[]; links: Record<string, string> } {
  const executables = f.files.filter((r) => r.executable).map((r) => r.path).sort(byCodeUnit);
  const links: [string, string][] = [];
  for (const d of f.dirs) if (d.type === 'symlink' && d.resolved !== undefined) links.push([d.path, d.resolved]);
  for (const r of f.files) if (r.resolved !== undefined) links.push([r.path, r.resolved]);
  links.sort((a, b) => byCodeUnit(a[0], b[0]));
  return { executables, links: Object.fromEntries(links) };
}
