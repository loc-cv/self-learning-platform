// kubeconfig loading and the client configuration it yields: files, contexts, the namespace and the
// server, with clientcmd's errors.
//   upstream: staging/src/k8s.io/client-go/tools/clientcmd/loader.go ClientConfigLoadingRules.Load
//             (explicit path must exist; KUBECONFIG list, missing files skipped; first file wins
//             for each map entry and each scalar), NewDefaultClientConfigLoadingRules
//   upstream: client_config.go DirectClientConfig Namespace, ClientConfig, ConfirmUsable,
//             getContext, getAuthInfo, getCluster; merged_client_builder.go DeferredLoadingClientConfig
//   upstream: validation.go validateClusterInfo, errContextNotFound, IsConfigurationInvalid
//   upstream: staging/src/k8s.io/cli-runtime/pkg/genericclioptions/config_flags.go
//             toRawKubeConfigLoader (ClusterDefaults: clientcmd.ClusterDefaults, whose server is
//             http://localhost:8080 unless KUBERNETES_MASTER is set: clientcmd getDefaultServer)
//   upstream: loader.go LoadFromFile (os.ReadFile: every error but IsNotExist is reported, so a
//             path under a regular file, ENOTDIR, is `open <f>: not a directory`), Load
// Files are decoded by `kubectl config`'s model (client/kubeconfigmodel.ts, D-086): Go's type
// errors, a wrong kind or version, and a repeated name in a list are the binary's errors.
// Behavior checked against the real kubectl v1.37.2 on this workstation (2026-11-16): --context,
// --cluster and --user naming nothing, with and without -n, a context whose cluster is missing,
// --kubeconfig naming a missing file; fixtures/golden/v1.37.2/config/broken-kubeconfig.yaml (a
// repeated name, a type error, a file under a regular file).
//
// Credentials are not read: kubeadm's kubeconfigs carry no certificate data yet (D-057), and the
// API server admits every request (authentication is phase 20a). A user entry stands for the
// certificate it would hold.

import type { Json } from '@simlab/kernel';
import type { KubectlError } from '../cli/errors.ts';
import { decodeConfig, type Config } from './kubeconfigmodel.ts';

export interface KubeconfigFile {
  clusters: Record<string, { server: string }>;
  contexts: Record<string, { cluster: string; user: string; namespace: string }>;
  users: Record<string, Record<string, never>>;
  currentContext: string;
}

export interface Overrides {
  kubeconfig?: string;
  context?: string;
  cluster?: string;
  user?: string;
  namespace?: string;
  server?: string;
}

export interface ClientConfig {
  /** The server URL as configured (`https://172.16.0.10:6443`, or a bare host:port). */
  server: string;
  namespace: string;
  /** Whether the namespace came from --namespace. */
  explicitNamespace: boolean;
  context: string;
  user: string;
}

/** Reads a file: its text, or 'missing' when it does not exist (os.IsNotExist), or Go's error text. */
export type ReadFile = (path: string) => string | { missing: true } | { error: string };

export type ParseYaml = (text: string) => { value: Json } | { error: string } | { unsupported: string };

/** clientcmd ClusterDefaults: getDefaultServer() without KUBERNETES_MASTER. */
export const DEFAULT_SERVER = 'http://localhost:8080';

/** What the loader keeps of clientcmd's internal api.Config. */
export function fromConfig(c: Config): KubeconfigFile {
  const out: KubeconfigFile = { clusters: {}, contexts: {}, users: {}, currentContext: c.currentContext };
  for (const [k, e] of Object.entries(c.clusters)) out.clusters[k] = { server: e.value.server };
  for (const [k, e] of Object.entries(c.contexts)) out.contexts[k] = { cluster: e.value.cluster, user: e.value.authInfo, namespace: e.value.namespace };
  for (const k of Object.keys(c.users)) out.users[k] = {};
  return out;
}

/**
 * clientcmd.Load of a file's YAML as JSON (undefined for an empty file): latest.Codec's decoding
 * and the v1 conversion, by the one decoder `kubectl config` uses (client/kubeconfigmodel.ts).
 */
export function decodeKubeconfig(doc: Json | undefined): KubeconfigFile | { error: string } | { notSimulated: string } {
  const r = decodeConfig(doc, '');
  return 'config' in r ? fromConfig(r.config) : r;
}

/** filepath.SplitList on Linux, then deduplicated (NewDefaultClientConfigLoadingRules). */
function kubeconfigPrecedence(env: Readonly<Record<string, string>>, home: string): string[] {
  const v = env.KUBECONFIG;
  if (v !== undefined && v !== '') {
    const out: string[] = [];
    for (const p of v.split(':')) if (!out.includes(p)) out.push(p);
    return out;
  }
  return [`${home}/.kube/config`];
}

function merge(files: readonly KubeconfigFile[]): KubeconfigFile {
  const out: KubeconfigFile = { clusters: {}, contexts: {}, users: {}, currentContext: '' };
  for (const f of files) {
    for (const [k, v] of Object.entries(f.clusters)) if (!(k in out.clusters)) out.clusters[k] = v;
    for (const [k, v] of Object.entries(f.contexts)) if (!(k in out.contexts)) out.contexts[k] = v;
    for (const [k, v] of Object.entries(f.users)) if (!(k in out.users)) out.users[k] = v;
    if (out.currentContext === '') out.currentContext = f.currentContext;
  }
  return out;
}

/** ClientConfigLoadingRules.Load */
export function loadKubeconfig(
  read: ReadFile,
  parse: ParseYaml,
  env: Readonly<Record<string, string>>,
  home: string,
  explicit: string | undefined,
): KubeconfigFile | KubectlError {
  let paths: string[];
  if (explicit) {
    const r = read(explicit);
    if (typeof r !== 'string' && 'missing' in r) return { type: 'message', message: `stat ${explicit}: no such file or directory` };
    paths = [explicit];
  } else paths = kubeconfigPrecedence(env, home);
  const files: KubeconfigFile[] = [];
  const errors: KubectlError[] = [];
  for (const p of paths) {
    if (p === '') continue;
    const r = read(p);
    if (typeof r !== 'string') {
      if ('missing' in r) continue;
      errors.push({ type: 'message', message: `error loading config file "${p}": ${r.error}` });
      continue;
    }
    // An empty file is an empty config (clientcmd.Load).
    let value: Json | undefined;
    if (r !== '') {
      const doc = parse(r);
      if ('unsupported' in doc) return { type: 'notSimulated', what: `${doc.unsupported} in ${p}` };
      if ('error' in doc) {
        errors.push({ type: 'message', message: `error loading config file "${p}": ${doc.error}` });
        continue;
      }
      value = doc.value;
    }
    const f = decodeKubeconfig(value);
    if ('notSimulated' in f) return { type: 'notSimulated', what: `${f.notSimulated} (${p})` };
    if ('error' in f) {
      errors.push({ type: 'message', message: `error loading config file "${p}": ${f.error}` });
      continue;
    }
    files.push(f);
  }
  if (errors.length > 0) return { type: 'aggregate', errors };
  return merge(files);
}

interface ConfigError {
  message: string;
  contextNotFound: boolean;
}

function configError(errs: ConfigError[]): KubectlError {
  // checkErr unwraps an aggregate of one; only a context-not-found error is still recognized as
  // invalid configuration then (IsConfigurationInvalid).
  if (errs.length === 1) {
    const e = errs[0] as ConfigError;
    return e.contextNotFound ? { type: 'config', errors: [e.message] } : { type: 'message', message: e.message };
  }
  return { type: 'config', errors: errs.map((e) => e.message) };
}

/** DirectClientConfig.ConfirmUsable (authentication methods are not validated, see above). */
function confirmUsable(cfg: KubeconfigFile, o: Overrides): ConfigError[] {
  const errs: ConfigError[] = [];
  const contextName = o.context || cfg.currentContext;
  if (contextName !== '' && !(contextName in cfg.contexts)) {
    errs.push({ message: `context was not found for specified context: ${contextName}`, contextNotFound: true });
  }
  const ctx = cfg.contexts[contextName];
  const clusterName = o.cluster || ctx?.cluster || '';
  const required = Boolean(o.cluster);
  const cluster = cfg.clusters[clusterName];
  // A required cluster that is missing yields an empty Cluster{} (no defaults): no server.
  if (!cluster && required && !o.server) {
    errs.push({ message: clusterName === '' ? 'default cluster has no server defined' : `no server found for cluster "${clusterName}"`, contextNotFound: false });
  }
  return errs;
}

/** What `kubectl` resolves before its first request: namespace (Namespace()), then the server (ClientConfig()). */
export function clientConfig(cfg: KubeconfigFile, o: Overrides): ClientConfig | KubectlError {
  let namespace: string;
  const explicitNamespace = Boolean(o.namespace);
  const contextName = o.context || cfg.currentContext;
  const ctx = cfg.contexts[contextName];
  if (o.namespace) namespace = o.namespace;
  else {
    const errs = confirmUsable(cfg, o);
    if (errs.length > 0) return configError(errs);
    namespace = ctx?.namespace || 'default';
  }
  const userName = o.user || ctx?.user || '';
  if (o.user && !(o.user in cfg.users)) return { type: 'message', message: `auth info "${o.user}" does not exist` };
  if (o.context && !(o.context in cfg.contexts)) return { type: 'message', message: `context "${o.context}" does not exist` };
  const clusterName = o.cluster || ctx?.cluster || '';
  if (o.cluster && !(o.cluster in cfg.clusters)) return { type: 'message', message: `cluster "${o.cluster}" does not exist` };
  const errs = confirmUsable(cfg, o);
  if (errs.length > 0) return configError(errs);
  const server = o.server || cfg.clusters[clusterName]?.server || DEFAULT_SERVER;
  return { server, namespace, explicitNamespace, context: contextName, user: userName };
}
