import { describe, expect, it } from 'vitest';
import { envPathDirs, executablesAndLinks, imageFiles, listedDirs } from './files.ts';
import { applyLayer, createTarParser, normalizePath, resolvePath, type Fs, type TarEntry } from './tar.ts';

const enc = new TextEncoder();

/** One ustar header block (POSIX.1-1988 layout), checksum included. */
function header(name: string, opts: { type?: string; mode?: number; size?: number; linkname?: string; prefix?: string } = {}): Uint8Array {
  const b = new Uint8Array(512);
  const put = (off: number, len: number, s: string): void => b.set(enc.encode(s).subarray(0, len), off);
  const oct = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(0, 100, name);
  put(100, 8, oct(opts.mode ?? 0o644, 8));
  put(108, 8, oct(0, 8));
  put(116, 8, oct(0, 8));
  put(124, 12, oct(opts.size ?? 0, 12));
  put(136, 12, oct(0, 12));
  put(156, 1, opts.type ?? '0');
  put(157, 100, opts.linkname ?? '');
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(345, 155, opts.prefix ?? '');
  put(148, 8, '        ');
  let sum = 0;
  for (const x of b) sum += x;
  put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return b;
}

function data(text: string): Uint8Array[] {
  const bytes = enc.encode(text);
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return [padded];
}

function archive(blocks: Uint8Array[]): Uint8Array {
  const all = [...blocks, new Uint8Array(1024)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of all) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

function parse(bytes: Uint8Array, chunk = 7, want: (p: string) => boolean = () => true): TarEntry[] {
  const out: TarEntry[] = [];
  const p = createTarParser((e) => out.push(e), want);
  for (let i = 0; i < bytes.length; i += chunk) p.push(bytes.subarray(i, i + chunk));
  p.end();
  return out;
}

function pax(records: Record<string, string>): Uint8Array[] {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = rest.length + 1;
    while (`${len}${rest}`.length !== len) len++;
    body += `${len}${rest}`;
  }
  return [header('PaxHeaders/x', { type: 'x', size: enc.encode(body).length }), ...data(body)];
}

describe('createTarParser', () => {
  it('reads files, directories, links, ustar prefixes, GNU long names and pax paths across any chunking', () => {
    const longName = `usr/share/${'d'.repeat(120)}/file`;
    const bytes = archive([
      header('./', { type: '5', mode: 0o755 }),
      header('./usr/bin/', { type: '5', mode: 0o755 }),
      header('./usr/bin/tool', { mode: 0o755, size: 5 }),
      ...data('hello'),
      header('./bin', { type: '2', linkname: 'usr/bin', mode: 0o777 }),
      header('./usr/bin/tool2', { type: '1', linkname: './usr/bin/tool', mode: 0o755 }),
      header('script.sh', { prefix: 'deep/dir', size: 3, mode: 0o775 }),
      ...data('#!\n'),
      header('././@LongLink', { type: 'L', size: longName.length + 1 }),
      ...data(`${longName}\0`),
      header('truncated', { size: 0 }),
      ...pax({ path: 'pax/named/file', linkpath: 'ignored-for-files' }),
      header('short', { size: 2 }),
      ...data('ok'),
    ]);
    for (const chunk of [1, 7, 512, 100000]) {
      const entries = parse(bytes, chunk);
      expect(entries.map((e) => [e.path, e.type, e.mode.toString(8), e.linkname ?? ''])).toEqual([
        ['/', 'dir', '755', ''],
        ['/usr/bin', 'dir', '755', ''],
        ['/usr/bin/tool', 'file', '755', ''],
        ['/bin', 'symlink', '777', 'usr/bin'],
        ['/usr/bin/tool2', 'hardlink', '755', '/usr/bin/tool'],
        ['/deep/dir/script.sh', 'file', '775', ''],
        [`/${longName}`, 'file', '644', ''],
        ['/pax/named/file', 'file', '644', ''],
      ]);
      expect(new TextDecoder().decode(entries[2]?.content)).toBe('hello');
      expect(new TextDecoder().decode(entries[7]?.content)).toBe('ok');
    }
  });

  it('keeps contents only for the paths asked for', () => {
    const bytes = archive([header('a', { size: 1 }), ...data('A'), header('b', { size: 1 }), ...data('B')]);
    const entries = parse(bytes, 64, (p) => p === '/b');
    expect(entries[0]?.content).toBeUndefined();
    expect(new TextDecoder().decode(entries[1]?.content)).toBe('B');
  });

  it('rejects an archive cut inside an entry', () => {
    const p = createTarParser(() => {}, () => false);
    p.push(header('a', { size: 600 }));
    expect(() => p.end()).toThrow(/ends inside an entry/);
  });
});

function entry(path: string, type: TarEntry['type'], mode = 0o755, linkname?: string): TarEntry {
  return { path: normalizePath(path), type, mode, size: 0, ...(linkname !== undefined ? { linkname } : {}) };
}

describe('applyLayer', () => {
  it('applies whiteouts and opaque directories to lower layers only', () => {
    const fs: Fs = new Map();
    applyLayer(fs, [entry('/etc', 'dir'), entry('/etc/a', 'file', 0o644), entry('/etc/b', 'file', 0o644), entry('/opt', 'dir'), entry('/opt/x', 'dir'), entry('/opt/x/y', 'file')]);
    applyLayer(fs, [entry('/etc/.wh.a', 'file'), entry('/opt/.wh..wh..opq', 'file'), entry('/opt/new', 'file')]);
    expect([...fs.keys()].sort()).toEqual(['/etc', '/etc/b', '/opt', '/opt/new']);
  });

  it('a file replacing a directory hides its contents', () => {
    const fs: Fs = new Map();
    applyLayer(fs, [entry('/d', 'dir'), entry('/d/f', 'file')]);
    applyLayer(fs, [entry('/d', 'symlink', 0o777, 'elsewhere')]);
    expect([...fs.keys()]).toEqual(['/d']);
  });
});

describe('resolvePath and imageFiles', () => {
  // a merged-/usr Debian-like root with a busybox-like hardlink farm and an entrypoint
  const fs: Fs = new Map();
  applyLayer(fs, [
    entry('/', 'dir'),
    entry('/usr', 'dir'),
    entry('/usr/bin', 'dir'),
    entry('/usr/sbin', 'dir'),
    entry('/usr/local', 'dir'),
    entry('/usr/local/bin', 'dir'),
    entry('/bin', 'symlink', 0o777, 'usr/bin'),
    entry('/sbin', 'symlink', 0o777, 'usr/sbin'),
    entry('/usr/bin/dash', 'file', 0o755),
    entry('/usr/bin/sh', 'symlink', 0o777, 'dash'),
    entry('/usr/bin/busybox', 'file', 0o755),
    entry('/usr/bin/ls', 'hardlink', 0o755, '/usr/bin/busybox'),
    entry('/usr/bin/README', 'file', 0o644),
    entry('/usr/bin/dangling', 'symlink', 0o777, '/nowhere'),
    entry('/usr/local/bin/entry', 'symlink', 0o777, '/bin/sh'),
    entry('/docker-entrypoint.sh', 'file', 0o775),
    entry('/docker-entrypoint.d', 'dir'),
    entry('/docker-entrypoint.d/10-a.sh', 'file', 0o755),
    entry('/notes.txt', 'file', 0o644),
  ]);

  it('follows symlinks in every component', () => {
    expect(resolvePath(fs, '/bin/sh')).toBe('/usr/bin/dash');
    expect(resolvePath(fs, '/bin/sh', false)).toBe('/usr/bin/sh');
    expect(resolvePath(fs, '/usr/local/bin/entry')).toBe('/usr/bin/dash');
    const loop: Fs = new Map([['/a', { type: 'symlink', mode: 0o777, linkname: 'b' }], ['/b', { type: 'symlink', mode: 0o777, linkname: 'a' }]]);
    expect(resolvePath(loop, '/a')).toBeUndefined();
  });

  it('records PATH entries, entrypoints and what is executable', () => {
    const f = imageFiles(fs);
    expect(f.dirs.find((d) => d.path === '/bin')).toEqual({ path: '/bin', type: 'symlink', target: 'usr/bin', resolved: '/usr/bin' });
    expect(f.dirs.find((d) => d.path === '/usr/local/sbin')).toEqual({ path: '/usr/local/sbin', type: 'missing' });
    expect(f.files.map((r) => `${r.path} ${r.type} ${r.executable ? 'x' : '-'}`)).toEqual([
      '/docker-entrypoint.d/10-a.sh file x',
      '/docker-entrypoint.sh file x',
      '/usr/bin/README file -',
      '/usr/bin/busybox file x',
      '/usr/bin/dangling symlink -',
      '/usr/bin/dash file x',
      '/usr/bin/ls hardlink x',
      '/usr/bin/sh symlink x',
      '/usr/local/bin/entry symlink x',
    ]);
    const s = executablesAndLinks(f);
    expect(s.executables).toEqual(['/docker-entrypoint.d/10-a.sh', '/docker-entrypoint.sh', '/usr/bin/busybox', '/usr/bin/dash', '/usr/bin/ls', '/usr/bin/sh', '/usr/local/bin/entry']);
    expect(s.links).toEqual({
      '/bin': '/usr/bin',
      '/sbin': '/usr/sbin',
      '/usr/bin/dangling': '/nowhere',
      '/usr/bin/ls': '/usr/bin/busybox',
      '/usr/bin/sh': '/usr/bin/dash',
      '/usr/local/bin/entry': '/usr/bin/dash',
    });
  });
});

describe('listing options', () => {
  it('adds the config PATH directories and, for distroless images, every executable', () => {
    expect(envPathDirs(['A=1', 'PATH=/usr/local/apache2/bin:/usr/bin:relative:/opt//x/'])).toEqual(['/usr/local/apache2/bin', '/usr/bin', '/opt/x']);
    expect(listedDirs({ envPath: ['/usr/local/apache2/bin', '/usr/bin'] }).slice(-2)).toEqual(['/bin', '/usr/local/apache2/bin']);
    const fs: Fs = new Map();
    applyLayer(fs, [
      entry('/usr/local/apache2/bin', 'dir'),
      entry('/usr/local/apache2/bin/httpd', 'file', 0o755),
      entry('/go-runner', 'file', 0o755),
      entry('/usr/lib/thing', 'file', 0o755),
      entry('/etc/conf', 'file', 0o644),
    ]);
    const plain = imageFiles(fs, { envPath: ['/usr/local/apache2/bin'] }).files.map((f) => f.path);
    expect(plain).toEqual(['/go-runner', '/usr/local/apache2/bin/httpd']);
    const all = imageFiles(fs, { allExecutables: true }).files.map((f) => f.path);
    expect(all).toEqual(['/go-runner', '/usr/lib/thing', '/usr/local/apache2/bin/httpd']);
  });
});
