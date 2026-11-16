// What a container's process sees of its image's filesystem: which executables exist (from the
// layer listings `npm run images:capture` records, IMAGE_FILES) and which behavior model implements
// each. execvp's PATH search, symlinks (Debian's /bin → /usr/bin, /usr/bin/sh → dash) and BusyBox's
// hard-linked applets are resolved as the kernel would.

import { UTILITIES, type Executable } from '@simlab/host';
import { IMAGE_CATALOG, IMAGE_FILES, type CapturedImage } from './catalog.data.ts';

interface FileTable {
  executables: ReadonlySet<string>;
  links: Readonly<Record<string, string>>;
  busybox?: string;
}

const tables = new Map<string, FileTable>();

function byConfig(id: string): CapturedImage | undefined {
  return IMAGE_CATALOG.find((i) => i.config.digest === id);
}

function tableOf(imageId: string): FileTable | undefined {
  const hit = tables.get(imageId);
  if (hit) return hit;
  const img = byConfig(imageId);
  const src = IMAGE_FILES[img?.filesFrom ?? imageId];
  if (!src) return undefined;
  const t: FileTable = { executables: new Set(src.executables), links: src.links };
  if (t.executables.has('/bin/busybox')) t.busybox = canonical(t, '/bin/busybox');
  tables.set(imageId, t);
  return t;
}

/** Resolves directory and file links until a path without a link remains. */
function canonical(t: FileTable, path: string): string {
  let p = path;
  for (let i = 0; i < 40; i++) {
    const direct = t.links[p];
    if (direct !== undefined) {
      p = direct.startsWith('/') ? direct : `${p.slice(0, p.lastIndexOf('/'))}/${direct}`;
      continue;
    }
    // A link on a leading directory: /bin/sh with /bin → /usr/bin.
    const parts = p.split('/');
    let moved = false;
    for (let j = parts.length - 1; j > 1; j--) {
      const dir = parts.slice(0, j).join('/');
      const to = t.links[dir];
      if (to !== undefined) {
        p = `${to.startsWith('/') ? to : `${dir.slice(0, dir.lastIndexOf('/'))}/${to}`}/${parts.slice(j).join('/')}`;
        moved = true;
        break;
      }
    }
    if (!moved) return p;
  }
  return p;
}

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Programs with a model of their own, by the canonical file's base name. */
const PROGRAM_MODELS: Readonly<Record<string, string>> = {
  nginx: 'nginx',
  httpd: 'httpd',
  'redis-server': 'redis-server',
  pause: 'pause',
  coredns: 'component',
  'kube-proxy': 'component',
  'kube-apiserver': 'component',
  'kube-controller-manager': 'component',
  'kube-scheduler': 'component',
  etcd: 'component',
  'go-runner': 'component',
};

/** Entrypoint scripts of the official images, modeled from their text (fixtures/reference/images/scripts). */
const SCRIPT_MODELS: Readonly<Record<string, string>> = {
  '/docker-entrypoint.sh': 'nginx-entrypoint',
  '/usr/local/bin/httpd-foreground': 'httpd-foreground',
  '/usr/local/bin/docker-entrypoint.sh': 'redis-entrypoint',
};

function describe(t: FileTable, path: string): Executable {
  const real = canonical(t, path);
  if (t.busybox !== undefined && real === t.busybox) {
    // A BusyBox applet: the binary behaves as the name it was invoked by.
    const applet = base(path);
    const model = applet === 'sh' || applet === 'ash' ? 'sh' : (UTILITIES as readonly string[]).includes(applet) ? applet : 'unmodeled';
    return { path, model, variant: 'busybox' };
  }
  const name = base(real);
  if (SCRIPT_MODELS[real]) return { path, model: SCRIPT_MODELS[real] as string, variant: 'script' };
  if (name === 'dash') return { path, model: 'sh', variant: 'dash' };
  if (name === 'bash') return { path, model: 'sh', variant: 'bash' };
  if (PROGRAM_MODELS[name]) return { path, model: PROGRAM_MODELS[name] as string, variant: name };
  if ((UTILITIES as readonly string[]).includes(name)) return { path, model: name, variant: 'gnu' };
  return { path, model: 'unmodeled', variant: name };
}

function exists(t: FileTable, path: string): boolean {
  return t.executables.has(path) || t.executables.has(canonical(t, path));
}

/** PATH when the environment has none: containerd's default (pkg/oci DefaultSpec, defaultUnixEnv). */
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface ImageView {
  which(env: [string, string][], name: string): Executable | undefined;
  file(path: string): string | undefined;
}

export function imageView(imageId: string): ImageView {
  const t = tableOf(imageId);
  return {
    which(env, name) {
      if (!t || name === '') return undefined;
      if (name.includes('/')) return exists(t, name) ? describe(t, name) : undefined;
      const path = env.find(([k]) => k === 'PATH')?.[1] ?? DEFAULT_PATH;
      for (const dir of path.split(':')) {
        const candidate = `${dir === '' ? '.' : dir.replace(/\/$/, '')}/${name}`;
        if (exists(t, candidate)) return describe(t, candidate);
      }
      return undefined;
    },
    file: () => undefined,
  };
}

/** Whether the image's files were captured (an image without a table cannot be resolved). */
export function hasFileTable(imageId: string): boolean {
  return tableOf(imageId) !== undefined;
}
