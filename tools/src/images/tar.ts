// A streaming reader for the tar archives inside image layers, and the union of layers into one
// filesystem as containerd's overlayfs snapshotter presents it. Pure; tar.test.ts.
//
// Formats handled (POSIX.1-2001 / pax, GNU tar(5)): ustar name+prefix, GNU long names ('L', 'K'),
// pax extended headers ('x' path/linkpath/size; 'g' is read and ignored), base-256 sizes.
// Layer semantics (OCI image-spec layer.md "Whiteouts"): `.wh.<name>` deletes <name> and what is
// under it in lower layers; `.wh..wh..opq` hides every lower entry of its directory. Both apply
// only to lower layers, so a layer's deletions are applied before its own entries.

export type EntryType = 'file' | 'hardlink' | 'symlink' | 'dir' | 'other';

export interface TarEntry {
  /** Absolute and normalized: `./usr/bin/` becomes `/usr/bin`, the root is `/`. */
  path: string;
  type: EntryType;
  mode: number;
  size: number;
  /** Symlink text as stored, or the hardlink's target as an absolute path. */
  linkname?: string;
  content?: Uint8Array;
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const c of p.split('/')) {
    if (c === '' || c === '.') continue;
    if (c === '..') parts.pop();
    else parts.push(c);
  }
  return `/${parts.join('/')}`;
}

const decoder = new TextDecoder();

function cstr(b: Uint8Array, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const nul = s.indexOf(0);
  return decoder.decode(nul === -1 ? s : s.subarray(0, nul));
}

function octal(b: Uint8Array, off: number, len: number): number {
  const first = b[off] ?? 0;
  if (first & 0x80) {
    // base-256 (GNU): big-endian, top bit of the first byte is the marker
    let n = first & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + (b[off + i] ?? 0);
    return n;
  }
  const s = cstr(b, off, len).trim();
  return s === '' ? 0 : parseInt(s, 8);
}

function parsePax(data: Uint8Array): Record<string, string> {
  // records are "<length> <key>=<value>\n", the length counting the whole record in bytes
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(decoder.decode(data.subarray(i, sp)), 10);
    if (!(len > 0)) break;
    const kv = decoder.decode(data.subarray(sp + 1, i + len - 1));
    const eq = kv.indexOf('=');
    if (eq !== -1) out[kv.slice(0, eq)] = kv.slice(eq + 1);
    i += len;
  }
  return out;
}

function typeOf(flag: string): EntryType {
  switch (flag) {
    case '0':
    case '\0':
    case '':
    case '7':
      return 'file';
    case '1':
      return 'hardlink';
    case '2':
      return 'symlink';
    case '5':
      return 'dir';
    default:
      return 'other';
  }
}

export interface TarParser {
  push(chunk: Uint8Array): void;
  end(): void;
}

/**
 * Feeds entries to `onEntry` as bytes arrive. File contents are kept only for regular files whose
 * path `wantContent` accepts; everything else is skipped without buffering.
 */
export function createTarParser(onEntry: (e: TarEntry) => void, wantContent: (path: string) => boolean): TarParser {
  let buf: Uint8Array = new Uint8Array(0);
  // the entry whose data is being read: `remaining` counts data plus padding
  let current: { header: TarEntry | { meta: 'L' | 'K' | 'x' | 'g' }; size: number; remaining: number; parts: Uint8Array[] | undefined } | undefined;
  let pending: { path?: string; linkpath?: string; size?: number } = {};
  let ended = false;

  function finish(): void {
    if (current === undefined) return;
    const data = current.parts === undefined ? undefined : concat(current.parts).subarray(0, current.size);
    const h = current.header;
    current = undefined;
    if ('meta' in h) {
      if (data === undefined) return;
      if (h.meta === 'L') pending.path = cstr(data, 0, data.length);
      else if (h.meta === 'K') pending.linkpath = cstr(data, 0, data.length);
      else if (h.meta === 'x') {
        const pax = parsePax(data);
        if (pax['path'] !== undefined) pending.path = pax['path'];
        if (pax['linkpath'] !== undefined) pending.linkpath = pax['linkpath'];
        if (pax['size'] !== undefined) pending.size = Number(pax['size']);
      }
      return;
    }
    onEntry(data === undefined ? h : { ...h, content: data });
  }

  function header(b: Uint8Array): void {
    if (b.every((x) => x === 0)) {
      ended = true;
      return;
    }
    const flag = String.fromCharCode(b[156] ?? 0);
    const magic = cstr(b, 257, 6);
    let name = cstr(b, 0, 100);
    if (magic.startsWith('ustar')) {
      const prefix = cstr(b, 345, 155);
      if (prefix !== '' && magic === 'ustar') name = `${prefix}/${name}`;
    }
    let size = octal(b, 124, 12);
    const padded = (n: number): number => Math.ceil(n / 512) * 512;
    if (flag === 'L' || flag === 'K' || flag === 'x' || flag === 'g') {
      current = { header: { meta: flag }, size, remaining: padded(size), parts: [] };
      if (size === 0) finish();
      return;
    }
    const p = pending;
    pending = {};
    if (p.size !== undefined) size = p.size;
    const type = typeOf(flag);
    const path = normalizePath(p.path ?? name);
    const rawLink = p.linkpath ?? cstr(b, 157, 100);
    const entry: TarEntry = {
      path,
      type,
      mode: octal(b, 100, 8) & 0o7777,
      size: type === 'file' ? size : 0,
      ...(type === 'symlink' ? { linkname: rawLink } : type === 'hardlink' ? { linkname: normalizePath(rawLink) } : {}),
    };
    // directories and symlinks carry no data; anything else is skipped by its size field
    const dataSize = type === 'dir' || type === 'symlink' ? 0 : size;
    current = { header: entry, size: dataSize, remaining: padded(dataSize), parts: type === 'file' && wantContent(path) ? [] : undefined };
    if (dataSize === 0) finish();
  }

  return {
    push(chunk: Uint8Array): void {
      buf = buf.length === 0 ? chunk : concat([buf, chunk]);
      let off = 0;
      while (off < buf.length) {
        if (current !== undefined) {
          const n = Math.min(current.remaining, buf.length - off);
          current.parts?.push(buf.slice(off, off + n));
          current.remaining -= n;
          off += n;
          if (current.remaining === 0) finish();
          continue;
        }
        if (ended) {
          off = buf.length;
          break;
        }
        if (buf.length - off < 512) break;
        header(buf.subarray(off, off + 512));
        off += 512;
      }
      buf = buf.slice(off);
    },
    end(): void {
      if (current !== undefined) throw new Error('tar archive ends inside an entry');
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ----- the union of layers -----

export interface FsNode {
  type: EntryType;
  mode: number;
  linkname?: string;
  content?: Uint8Array;
}

/** A layered filesystem, path → node (tools only, so a Map is fine). */
export type Fs = Map<string, FsNode>;

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function removeTree(fs: Fs, path: string, keepSelf: boolean): void {
  const prefix = path === '/' ? '/' : `${path}/`;
  for (const k of [...fs.keys()]) if ((!keepSelf && k === path) || k.startsWith(prefix)) fs.delete(k);
}

/** Applies one layer's entries on top of `fs`. */
export function applyLayer(fs: Fs, entries: readonly TarEntry[]): void {
  for (const e of entries) {
    const base = basename(e.path);
    if (base === '.wh..wh..opq') removeTree(fs, dirname(e.path), true);
    else if (base.startsWith('.wh.')) removeTree(fs, `${dirname(e.path) === '/' ? '' : dirname(e.path)}/${base.slice(4)}`, false);
  }
  for (const e of entries) {
    if (basename(e.path).startsWith('.wh.')) continue;
    const prev = fs.get(e.path);
    // a non-directory replacing a directory hides what was under it
    if (prev?.type === 'dir' && e.type !== 'dir') removeTree(fs, e.path, true);
    if (e.type === 'dir' && prev?.type === 'dir') {
      fs.set(e.path, { ...prev, mode: e.mode });
      continue;
    }
    fs.set(e.path, {
      type: e.type,
      mode: e.mode,
      ...(e.linkname !== undefined ? { linkname: e.linkname } : {}),
      ...(e.content !== undefined ? { content: e.content } : {}),
    });
  }
}

/**
 * Resolves symlinks in every component of `path` (and the last one when `followLast`), the way
 * path lookup inside the container's root does: absolute targets start at the image root.
 * Returns the resolved path, which may not exist; undefined after 40 links (ELOOP).
 */
export function resolvePath(fs: Fs, path: string, followLast = true): string | undefined {
  let todo = normalizePath(path).split('/').filter((c) => c !== '');
  let done = '';
  let hops = 0;
  while (todo.length > 0) {
    const c = todo.shift() as string;
    const next = `${done}/${c}`;
    const node = fs.get(next);
    if (node?.type === 'symlink' && node.linkname !== undefined && (todo.length > 0 || followLast)) {
      if (++hops > 40) return undefined;
      const target = node.linkname.startsWith('/') ? node.linkname : `${done}/${node.linkname}`;
      todo = [...normalizePath(target).split('/').filter((x) => x !== ''), ...todo];
      done = '';
      continue;
    }
    done = next;
  }
  return done === '' ? '/' : done;
}

/** Direct children of a directory, sorted. */
export function children(fs: Fs, dir: string): string[] {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  const out: string[] = [];
  for (const k of fs.keys()) if (k !== '/' && k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(k);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
