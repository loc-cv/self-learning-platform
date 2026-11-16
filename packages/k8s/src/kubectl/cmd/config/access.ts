// Which kubeconfig files `kubectl config` reads and writes, and how it reads them: clientcmd's
// PathOptions (--kubeconfig, the KUBECONFIG list, ~/.kube/config) and its loading rules with
// paths left as written (NewDefaultPathOptions sets DoNotResolvePaths).
//   upstream: staging/src/k8s.io/client-go/tools/clientcmd/config.go PathOptions
//             GetEnvVarFiles (filepath.SplitList, deduplicated), GetLoadingPrecedence,
//             GetStartingConfig (a missing file is an empty config), GetDefaultFilename (the one
//             KUBECONFIG file, else the first that exists, else the last), getConfigFromFile
//   upstream: clientcmd/loader.go ClientConfigLoadingRules.Load (the explicit file must exist;
//             missing files are skipped; read errors are aggregated as `error loading config file
//             "<f>": <err>`), LoadFromFile (LocationOfOrigin), Load (an empty file is an empty
//             config), Migrate (~/.kube/.kubeconfig is copied to ~/.kube/config)
//   upstream: clientcmd/merge.go merge (maps: a later source overwrites a key; Load merges the
//             files forwards for maps and backwards for the rest, so the first file wins both)
//   upstream: Go src/os (PathError: `<op> <path>: <errno text>`), src/path/filepath Dir, Abs
// The files are read as the process (its credentials and working directory).

import { FsError, strerror, type ProcApi } from '@simlab/host';
import type { KubectlError } from '../../cli/errors.ts';
import { cleanPath, joinPath } from '../../resource/glob.ts';
import { parseYaml } from '../printing.ts';
import { decodeConfig, newConfig, type Config } from '../../client/kubeconfigmodel.ts';

export interface PathOptions {
  /** --kubeconfig */
  explicit: string;
  /** KUBECONFIG, split and deduplicated. */
  envFiles: string[];
  /** $HOME/.kube/config */
  globalFile: string;
}

export function pathOptions(p: ProcApi, explicit: string): PathOptions {
  const env = p.env.KUBECONFIG ?? '';
  const envFiles: string[] = [];
  if (env !== '') for (const f of env.split(':')) if (!envFiles.includes(f)) envFiles.push(f);
  return { explicit, envFiles, globalFile: `${p.env.HOME ?? ''}/.kube/config` };
}

export function loadingPrecedence(o: PathOptions): string[] {
  if (o.explicit !== '') return [o.explicit];
  if (o.envFiles.length > 0) return [...o.envFiles];
  return [o.globalFile];
}

/** Go's error text of a failed file system call. */
export function osError(op: string, path: string, e: FsError): string {
  return `${op} ${path}: ${strerror(e.code).toLowerCase()}`;
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

export function defaultFilename(p: ProcApi, o: PathOptions): string {
  if (o.explicit !== '') return o.explicit;
  if (o.envFiles.length === 1) return o.envFiles[0] as string;
  if (o.envFiles.length > 1) {
    for (const f of o.envFiles) if (exists(p, f)) return f;
    return o.envFiles[o.envFiles.length - 1] as string;
  }
  return o.globalFile;
}

export type Loaded = { config: Config } | { missing: true } | { error: KubectlError };

/** LoadFromFile: the file's config, `missing` (os.IsNotExist), or the error. */
export function loadFromFile(p: ProcApi, filename: string): Loaded {
  let text: string;
  try {
    text = p.fs().readFile(filename);
  } catch (e) {
    if (!(e instanceof FsError)) throw e;
    if (e.code === 'ENOENT') return { missing: true };
    return { error: { type: 'message', message: osError(e.code === 'EISDIR' ? 'read' : 'open', filename, e) } };
  }
  let doc;
  if (text !== '') {
    const r = parseYaml(text);
    if ('unsupported' in r) return { error: { type: 'notSimulated', what: `${r.unsupported} in ${filename}` } };
    if ('error' in r) return { error: { type: 'message', message: r.error } };
    doc = r.value;
  }
  const d = decodeConfig(doc, filename);
  if ('notSimulated' in d) return { error: { type: 'notSimulated', what: `${d.notSimulated} (${filename})` } };
  if ('error' in d) return { error: { type: 'message', message: d.error } };
  return d;
}

/** getConfigFromFile: a missing file is an empty config. */
export function configFromFile(p: ProcApi, filename: string): Config | KubectlError {
  const r = loadFromFile(p, filename);
  if ('error' in r) return r.error;
  return 'missing' in r ? newConfig() : r.config;
}

/** Load's merge: the first file to define a map key or set a value wins. */
function mergeConfigs(files: readonly Config[]): Config {
  const out = newConfig();
  for (const f of files) {
    for (const [k, v] of Object.entries(f.clusters)) if (!(k in out.clusters)) out.clusters[k] = v;
    for (const [k, v] of Object.entries(f.users)) if (!(k in out.users)) out.users[k] = v;
    for (const [k, v] of Object.entries(f.contexts)) if (!(k in out.contexts)) out.contexts[k] = v;
    if (out.currentContext === '') out.currentContext = f.currentContext;
    if (!out.preferences.colors) out.preferences.colors = f.preferences.colors;
  }
  return out;
}

/** The migration of the pre-1.x home file (Migrate), which the simulator does not perform. */
function migrationNeeded(p: ProcApi): boolean {
  const home = p.env.HOME ?? '';
  return !exists(p, `${home}/.kube/config`) && exists(p, `${home}/.kube/.kubeconfig`);
}

/** PathOptions.GetStartingConfig */
export function startingConfig(p: ProcApi, o: PathOptions): Config | KubectlError {
  if (migrationNeeded(p)) return { type: 'notSimulated', what: 'migrating ~/.kube/.kubeconfig to ~/.kube/config' };
  let files: string[];
  if (o.explicit !== '') {
    // Load fails with the stat error only when it is IsNotExist, which GetStartingConfig turns
    // into an empty config; any other (ENOTDIR) is reported by reading the file below.
    try {
      p.fs().stat(o.explicit);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (e.code === 'ENOENT') return newConfig();
    }
    files = [o.explicit];
  } else files = loadingPrecedence(o);
  const configs: Config[] = [];
  const errors: KubectlError[] = [];
  for (const f of files) {
    if (f === '') continue;
    const r = loadFromFile(p, f);
    if ('missing' in r) continue;
    if ('error' in r) {
      if (r.error.type === 'notSimulated') return r.error;
      errors.push({ type: 'message', message: `error loading config file "${f}": ${r.error.type === 'message' ? r.error.message : ''}` });
      continue;
    }
    configs.push(r.config);
  }
  if (errors.length > 0) return { type: 'aggregate', errors };
  return mergeConfigs(configs);
}

/** filepath.Dir */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return cleanPath(i < 0 ? '.' : path.slice(0, i + 1));
}

/** filepath.Abs (MakeAbs with no base): against the working directory. */
export function absPath(p: ProcApi, path: string): string {
  return path.startsWith('/') ? cleanPath(path) : joinPath(p.cwd, path);
}
