// clientcmd's writes: ModifyConfig finds what changed between the starting config and the new one
// and rewrites, for each change, the file the stanza came from (a new stanza goes to the default
// file; the current context always does), each file serialized whole by the codec.
//   upstream: staging/src/k8s.io/client-go/tools/clientcmd/config.go ModifyConfig (locks every
//             file of the loading precedence first, in sorted order; contexts of one file are
//             written together), writeCurrentContext, writePreferences, getConfigFromFile
//   upstream: clientcmd/loader.go WriteToFile (MkdirAll 0755 of the directory, os.WriteFile 0600),
//             Write (latest.Codec), lockFile (MkdirAll, then O_CREATE|O_EXCL of `<file>.lock`),
//             unlockFile
//   fixtures/golden/v1.37.2/config/contexts.yaml (the files after each write, a stale lock, a new
//   file's mode, the KUBECONFIG list)
// Writing changed clusters and users (set-cluster, set-credentials, delete-cluster, delete-user:
// phase 15) is not simulated: it also relativizes their file paths.

import { FsError, type ProcApi } from '@simlab/host';
import type { KubectlError } from '../../cli/errors.ts';
import { toYaml } from '../printing.ts';
import { configFromFile, defaultFilename, dirOf, loadingPrecedence, osError, startingConfig, type PathOptions } from './access.ts';
import { deepEqual, toV1, type Config } from '../../client/kubeconfigmodel.ts';

/** clientcmd.Write: the v1 serialization (YAML, keys sorted). */
export function serialize(c: Config): string {
  return toYaml(toV1(c));
}

/** os.MkdirAll(dir, 0755) */
function mkdirAll(p: ProcApi, dir: string): string | undefined {
  const fs = p.fs();
  const parts = dir.split('/');
  let path = dir.startsWith('/') ? '' : '.';
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    path = path === '' ? `/${part}` : `${path}/${part}`;
    try {
      const st = fs.stat(path);
      if (st.type !== 'dir') return osError('mkdir', path, new FsError('ENOTDIR', 'mkdir', path));
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (e.code !== 'ENOENT') return osError('stat', path, e);
      try {
        fs.mkdir(path, 0o755);
      } catch (e2) {
        if (e2 instanceof FsError) return osError('mkdir', path, e2);
        throw e2;
      }
    }
  }
  return undefined;
}

/** WriteToFile */
export function writeToFile(p: ProcApi, c: Config, filename: string): KubectlError | undefined {
  const content = serialize(c);
  const dir = dirOf(filename);
  const e = mkdirAll(p, dir);
  if (e !== undefined) return { type: 'message', message: e };
  try {
    p.fs().writeFile(filename, content, { mode: 0o600 });
  } catch (err) {
    if (err instanceof FsError) return { type: 'message', message: osError('open', filename, err) };
    throw err;
  }
  return undefined;
}

function lockFile(p: ProcApi, filename: string): KubectlError | undefined {
  const e = mkdirAll(p, dirOf(filename));
  if (e !== undefined) return { type: 'message', message: e };
  try {
    p.fs().writeFile(`${filename}.lock`, '', { exclusive: true, mode: 0 });
  } catch (err) {
    if (err instanceof FsError) return { type: 'message', message: osError('open', `${filename}.lock`, err) };
    throw err;
  }
  return undefined;
}

function unlockFile(p: ProcApi, filename: string): void {
  try {
    p.fs().unlink(`${filename}.lock`);
  } catch (e) {
    if (!(e instanceof FsError)) throw e;
  }
}

function exists(p: ProcApi, path: string): boolean {
  try {
    p.fs().stat(path);
    return true;
  } catch (e) {
    if (e instanceof FsError) return false;
    throw e;
  }
}

/** writeCurrentContext */
function writeCurrentContext(p: ProcApi, o: PathOptions, current: string): KubectlError | undefined {
  const start = startingConfig(p, o);
  if ('type' in start) return start;
  if (start.currentContext === current) return undefined;
  const write = (file: string): KubectlError | undefined => {
    const c = configFromFile(p, file);
    if ('type' in c) return c;
    c.currentContext = current;
    return writeToFile(p, c, file);
  };
  if (o.explicit !== '') return write(o.explicit);
  if (current !== '') return write(defaultFilename(p, o));
  // Clearing it: the first file in the chain that sets one.
  for (const file of loadingPrecedence(o)) {
    if (!exists(p, file)) continue;
    const c = configFromFile(p, file);
    if ('type' in c) return c;
    if (c.currentContext !== '') {
      c.currentContext = '';
      return writeToFile(p, c, file);
    }
  }
  return { type: 'message', message: 'no config found to write context' };
}

function modify(p: ProcApi, o: PathOptions, next: Config): KubectlError | undefined {
  const start = startingConfig(p, o);
  if ('type' in start) return start;
  if (deepEqual(start, next)) return undefined;
  if (start.currentContext !== next.currentContext) {
    const e = writeCurrentContext(p, o, next.currentContext);
    if (e) return e;
  }
  if (!deepEqual(start.preferences, next.preferences)) return { type: 'notSimulated', what: 'writing kubeconfig preferences' };
  if (!deepEqual(start.clusters, next.clusters) || !deepEqual(start.users, next.users)) {
    return { type: 'notSimulated', what: 'writing kubeconfig clusters and users' };
  }
  // Changed and new contexts, grouped by destination file.
  const seen = new Map<string, Config>();
  for (const key of Object.keys(next.contexts).sort()) {
    const ctx = next.contexts[key];
    const before = start.contexts[key];
    if (!ctx || (before && deepEqual(ctx, before))) continue;
    const dest = ctx.origin !== '' ? ctx.origin : defaultFilename(p, o);
    let c = seen.get(dest);
    if (!c) {
      const r = configFromFile(p, dest);
      if ('type' in r) return r;
      c = r;
      seen.set(dest, c);
    }
    c.contexts[key] = ctx;
  }
  for (const [dest, c] of seen) {
    const e = writeToFile(p, c, dest);
    if (e) return e;
  }
  // Deleted contexts.
  for (const key of Object.keys(start.contexts).sort()) {
    if (key in next.contexts) continue;
    const ctx = start.contexts[key];
    const dest = ctx && ctx.origin !== '' ? ctx.origin : defaultFilename(p, o);
    const c = configFromFile(p, dest);
    if ('type' in c) return c;
    delete c.contexts[key];
    const e = writeToFile(p, c, dest);
    if (e) return e;
  }
  return undefined;
}

/** clientcmd.ModifyConfig(configAccess, newConfig, true), with its locks. */
export function modifyConfig(p: ProcApi, o: PathOptions, next: Config): KubectlError | undefined {
  const sources = [...loadingPrecedence(o)].sort();
  const locked: string[] = [];
  let err: KubectlError | undefined;
  for (const f of sources) {
    err = lockFile(p, f);
    if (err) break;
    locked.push(f);
  }
  if (!err) err = modify(p, o, next);
  for (const f of locked.reverse()) unlockFile(p, f);
  return err;
}
