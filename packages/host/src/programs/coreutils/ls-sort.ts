// ls sort orders: name (strcoll, which is code point order in C.UTF-8), time, size, extension,
// width and version (gnulib filevercmp), each reversed by -r, with --group-directories-first.
//   upstream: coreutils src/ls.c cmp_name, cmp_mtime, cmp_size, cmp_extension, cmp_width,
//             cmp_version, DIRFIRST_CHECK; gnulib lib/filevercmp.c
//   reference: coreutils 9.4 ls -t, -S, -X, -v, --sort=width, -r, --group-directories-first,
//              captured 2026-11-16 (packages/host/transcripts/coreutils/ls-sort.t)

import { compareC } from '../../shell/glob.ts';

export type SortKey = 'name' | 'none' | 'time' | 'size' | 'extension' | 'version' | 'width';

export interface SortEntry {
  name: string;
  time: number;
  size: number;
  width: number;
  /** A directory, or a symbolic link to one (is_linked_directory). */
  linkedDir: boolean;
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const TILDE = 126;
const DOT = 46;

/** Length of `s` without its file suffix: the longest match of (\.[A-Za-z~][A-Za-z0-9~]*)*$. */
function prefixLength(s: number[]): number {
  const n = s.length;
  let prefix = 0;
  for (let i = 0; ; ) {
    if (i === n) return prefix;
    i++;
    prefix = i;
    while (i + 1 < n && s[i] === DOT && (isAlpha(s[i + 1] as number) || s[i + 1] === TILDE)) {
      for (i += 2; i < n && (isAlpha(s[i] as number) || isDigit(s[i] as number) || s[i] === TILDE); i++) continue;
    }
  }
}

function order(s: number[], pos: number, len: number): number {
  if (pos === len) return -1;
  const c = s[pos] as number;
  if (isDigit(c)) return 0;
  if (isAlpha(c)) return c;
  if (c === TILDE) return -2;
  return c + 256;
}

function verrevcmp(a: number[], alen: number, b: number[], blen: number): number {
  let i = 0;
  let j = 0;
  while (i < alen || j < blen) {
    let firstDiff = 0;
    while ((i < alen && !isDigit(a[i] as number)) || (j < blen && !isDigit(b[j] as number))) {
      const ac = order(a, i, alen);
      const bc = order(b, j, blen);
      if (ac !== bc) return ac - bc;
      i++;
      j++;
    }
    while (i < alen && a[i] === 48) i++;
    while (j < blen && b[j] === 48) j++;
    while (i < alen && j < blen && isDigit(a[i] as number) && isDigit(b[j] as number)) {
      if (!firstDiff) firstDiff = (a[i] as number) - (b[j] as number);
      i++;
      j++;
    }
    if (i < alen && isDigit(a[i] as number)) return 1;
    if (j < blen && isDigit(b[j] as number)) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

/** filevercmp: natural order of version numbers within names. */
export function filevercmp(x: string, y: string): number {
  if (x === '') return y === '' ? 0 : -1;
  if (y === '') return 1;
  if (x[0] === '.') {
    if (y[0] !== '.') return -1;
    if (x === '.') return y === '.' ? 0 : -1;
    if (y === '.') return 1;
    if (x === '..') return y === '..' ? 0 : -1;
    if (y === '..') return 1;
  } else if (y[0] === '.') return 1;
  const a = utf8Bytes(x);
  const b = utf8Bytes(y);
  const ap = prefixLength(a);
  const bp = prefixLength(b);
  const onePass = ap === a.length && bp === b.length;
  const r = verrevcmp(a, ap, b, bp);
  return r || onePass ? r : verrevcmp(a, a.length, b, b.length);
}

const extension = (name: string): string => {
  const k = name.lastIndexOf('.');
  return k < 0 ? '' : name.slice(k);
};

function keyCompare(key: SortKey, a: SortEntry, b: SortEntry): number {
  switch (key) {
    case 'time':
      return b.time - a.time || compareC(a.name, b.name);
    case 'size':
      return (b.size > a.size ? 1 : b.size < a.size ? -1 : 0) || compareC(a.name, b.name);
    case 'extension':
      return compareC(extension(a.name), extension(b.name)) || compareC(a.name, b.name);
    case 'version': {
      const d = filevercmp(a.name, b.name);
      return d || compareC(a.name, b.name);
    }
    case 'width':
      return a.width - b.width || compareC(a.name, b.name);
    default:
      return compareC(a.name, b.name);
  }
}

/** sort_files: a new array in ls order; `none` keeps the given (directory) order. */
export function sortEntries<T extends SortEntry>(entries: readonly T[], key: SortKey, reverse: boolean, dirsFirst: boolean): T[] {
  if (key === 'none') return [...entries];
  return [...entries].sort((a, b) => {
    if (dirsFirst) {
      const d = Number(b.linkedDir) - Number(a.linkedDir);
      if (d !== 0) return d;
    }
    return reverse ? keyCompare(key, b, a) : keyCompare(key, a, b);
  });
}
