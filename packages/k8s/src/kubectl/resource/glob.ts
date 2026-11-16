// Go's path/filepath on Linux: Clean, Join, Split, Match and Glob, as kubectl's resource builder
// uses them to expand an `-f` pattern that names no file (expandIfFilePattern) and to name the files
// it finds in a directory. Strings are handled character by character where Go walks bytes and
// decodes runes; the two agree for every pattern and name made of whole characters.
//   upstream: .upstream/go src/path/filepath/match.go Match, scanChunk, matchChunk, getEsc, Glob,
//             globWithLimit, cleanGlobPath, glob, hasMeta (go1.23.11); path.go Clean, Join, Split

import { FsError, type Fs } from '@simlab/host';

/** filepath.ErrBadPattern */
export const BAD_PATTERN = 'syntax error in pattern';

class BadPattern extends Error {}

/** filepath.Clean */
export function cleanPath(p: string): string {
  if (p === '') return '.';
  const rooted = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (rooted) return `/${joined}`;
  return joined === '' ? '.' : joined;
}

/** filepath.Join of two elements */
export function joinPath(dir: string, name: string): string {
  if (dir === '') return name === '' ? '' : cleanPath(name);
  return cleanPath(`${dir}/${name}`);
}

/** filepath.Split: everything up to and including the last separator, and the rest. */
function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return [p.slice(0, i + 1), p.slice(i + 1)];
}

/** filepath.Ext */
export function extOf(p: string): string {
  for (let i = p.length - 1; i >= 0 && p[i] !== '/'; i--) if (p[i] === '.') return p.slice(i);
  return '';
}

export function hasMeta(p: string): boolean {
  return /[*?[\\]/.test(p);
}

function scanChunk(pattern: string[]): { star: boolean; chunk: string[]; rest: string[] } {
  let star = false;
  let p = pattern;
  while (p.length > 0 && p[0] === '*') {
    p = p.slice(1);
    star = true;
  }
  let inrange = false;
  let i = 0;
  for (; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      if (i + 1 < p.length) i++;
    } else if (c === '[') inrange = true;
    else if (c === ']') inrange = false;
    else if (c === '*' && !inrange) break;
  }
  return { star, chunk: p.slice(0, i), rest: p.slice(i) };
}

function getEsc(chunk: string[]): { r: string; rest: string[] } {
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') throw new BadPattern();
  let c = chunk;
  if (c[0] === '\\') {
    c = c.slice(1);
    if (c.length === 0) throw new BadPattern();
  }
  const r = c[0] as string;
  const rest = c.slice(1);
  if (rest.length === 0) throw new BadPattern();
  return { r, rest };
}

/** matchChunk: the rest of `s` after the chunk, or undefined when it does not match. */
function matchChunk(chunkIn: string[], sIn: string[]): string[] | undefined {
  let chunk = chunkIn;
  let s = sIn;
  let failed = false;
  while (chunk.length > 0) {
    if (!failed && s.length === 0) failed = true;
    const c = chunk[0] as string;
    if (c === '[') {
      let r = '';
      if (!failed) {
        r = s[0] as string;
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
      let negated = false;
      if (chunk.length > 0 && chunk[0] === '^') {
        negated = true;
        chunk = chunk.slice(1);
      }
      let match = false;
      let nrange = 0;
      for (;;) {
        if (chunk.length > 0 && chunk[0] === ']' && nrange > 0) {
          chunk = chunk.slice(1);
          break;
        }
        const lo = getEsc(chunk);
        chunk = lo.rest;
        let hi = lo.r;
        if (chunk[0] === '-') {
          const h = getEsc(chunk.slice(1));
          hi = h.r;
          chunk = h.rest;
        }
        const cp = (x: string) => x.codePointAt(0) as number;
        if (!failed && cp(lo.r) <= cp(r) && cp(r) <= cp(hi)) match = true;
        nrange++;
      }
      if (match === negated) failed = true;
      continue;
    }
    if (c === '?') {
      if (!failed) {
        if (s[0] === '/') failed = true;
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
      continue;
    }
    if (c === '\\') {
      chunk = chunk.slice(1);
      if (chunk.length === 0) throw new BadPattern();
    }
    if (!failed) {
      if (chunk[0] !== s[0]) failed = true;
      s = s.slice(1);
    }
    chunk = chunk.slice(1);
  }
  return failed ? undefined : s;
}

/** filepath.Match: whether `name` matches, or BAD_PATTERN. */
export function matchPath(patternText: string, nameText: string): boolean | { error: string } {
  let pattern = Array.from(patternText);
  let name = Array.from(nameText);
  try {
    outer: while (pattern.length > 0) {
      const { star, chunk, rest } = scanChunk(pattern);
      pattern = rest;
      if (star && chunk.length === 0) return !name.includes('/');
      const t = matchChunk(chunk, name);
      if (t !== undefined && (t.length === 0 || pattern.length > 0)) {
        name = t;
        continue;
      }
      if (star) {
        for (let i = 0; i < name.length && name[i] !== '/'; i++) {
          const t2 = matchChunk(chunk, name.slice(i + 1));
          if (t2 !== undefined) {
            if (pattern.length === 0 && t2.length > 0) continue;
            name = t2;
            continue outer;
          }
        }
      }
      return false;
    }
    return name.length === 0;
  } catch (e) {
    if (e instanceof BadPattern) return { error: BAD_PATTERN };
    throw e;
  }
}

function lexists(fs: Fs, p: string): boolean {
  try {
    fs.lstat(p);
    return true;
  } catch (e) {
    if (e instanceof FsError) return false;
    throw e;
  }
}

/** glob: the names in `dir` that match, appended; I/O errors are ignored, as Go does. */
function globDir(fs: Fs, dir: string, pattern: string, matches: string[]): string[] | { error: string } {
  let names: string[];
  try {
    if (fs.stat(dir).type !== 'dir') return matches;
    names = fs.readdir(dir);
  } catch (e) {
    if (e instanceof FsError) return matches;
    throw e;
  }
  const out = [...matches];
  for (const n of [...names].sort()) {
    const m = matchPath(pattern, n);
    if (typeof m === 'object') return m;
    if (m) out.push(joinPath(dir, n));
  }
  return out;
}

/** filepath.Glob: the matching paths in order, or BAD_PATTERN. */
export function globPaths(fs: Fs, pattern: string, depth = 0): string[] | { error: string } {
  if (depth === 10000) return { error: BAD_PATTERN };
  const check = matchPath(pattern, '');
  if (typeof check === 'object') return check;
  if (!hasMeta(pattern)) return lexists(fs, pattern) ? [pattern] : [];
  const [d, file] = splitPath(pattern);
  const dir = d === '' ? '.' : d === '/' ? d : d.slice(0, -1);
  if (!hasMeta(dir)) return globDir(fs, dir, file, []);
  if (dir === pattern) return { error: BAD_PATTERN };
  const dirs = globPaths(fs, dir, depth + 1);
  if (!Array.isArray(dirs)) return dirs;
  let matches: string[] = [];
  for (const m of dirs) {
    const r = globDir(fs, m, file, matches);
    if (!Array.isArray(r)) return r;
    matches = r;
  }
  return matches;
}
