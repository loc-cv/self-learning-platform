// npm run kubeadm:capture [-- --check]
//
// What a real `kubeadm init` writes and creates on the `kubeadm-1cp-2w` control plane
// (tools/src/oracle/topology.ts, docs/decisions.md D-033), captured from the pinned kubeadm binary
// (.upstream/bin/v1.37.2/kubeadm, rank 1 in docs/FIDELITY.md §2) as an unprivileged user:
//
//   unshare -r -u sh -c 'umask 022; hostname controlplane; exec kubeadm init --config <cfg> \
//     --dry-run --ignore-preflight-errors=all'
//   with the environment exactly HOME=<temp> PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8
//   KUBEADM_INIT_DRYRUN_DIR=<temp>/dry-run
//
// Why each part:
// - --dry-run writes every file into one directory instead of /etc/kubernetes and /var/lib/kubelet
//   and prints the API objects it would create. By default that directory is made under
//   /etc/kubernetes/tmp, which needs root; KUBEADM_INIT_DRYRUN_DIR moves it
//   (upstream: cmd/kubeadm/app/constants/constants.go GetDryRunDir).
// - --ignore-preflight-errors=all: there is no containerd, no kubelet binary, swap is on.
// - unshare -r -u: a user and UTS namespace, so the hostname can be `controlplane` without touching
//   the workstation. kubeadm writes --hostname-override into kubeadm-flags.env when the node name
//   differs from the hostname (upstream: cmd/kubeadm/app/phases/kubelet/flags.go
//   buildKubeletArgsCommon); on the real control plane they are equal.
// - umask 022, as for root on Ubuntu, so the recorded file modes are the ones kubeadm asks for.
//
// A run takes about 90 seconds: for each GET and LIST the dry-run client first tries the real API
// server at https://172.16.0.10:6443 and falls back to its fake tracker when that fails, which
// takes 30 s per request here (upstream: cmd/kubeadm/app/util/apiclient/dryrun.go handleGetAction).
// Nothing answers there; if something did, the output would change, and --check would say so.
//
// Outputs (fixtures/reference/kubeadm/v1.37.2/, docs/decisions.md D-021):
//   init-config.yaml        the kubeadm configuration given to init (the input)
//   files/<real path>       every file except certificates and keys, verbatim except tokens below
//   kubelet-finalize/etc/kubernetes/kubelet.conf
//                           kubelet.conf after init's kubelet-finalize phase, which a dry run skips
//                           (upstream: cmd/kubeadm/app/cmd/phases/init/kubeletfinalize.go): the same
//                           edit made by the real kubectl's `config set-credentials`, which writes
//                           through the same clientcmd serializer
//   files.json              every file kubeadm writes (pki included) with its mode
//   objects.json            the API objects kubeadm creates, in order, as JSON (a v1 List)
//   node.json               the labels and taints kubeadm patches onto the control-plane Node
//   init-dry-run.txt        kubeadm's standard output, tokens replaced
// and the engine's copy, packages/k8s/src/topology/kubeadm/reference.ts.
//
// Tokens (certificates and keys come in a later phase; random values differ per run):
//   <<cert:ca>>, <<cert:NAME>>, <<key:NAME>>  base64 PEM data in a kubeconfig; NAME is the file's
//                                             base name (admin, super-admin, controller-manager,
//                                             scheduler, kubelet)
//   <<token:id>>, <<token:secret>>            the bootstrap token's two halves
//   <<base64:token:id>> <<base64:token:secret>> <<base64:token:expiration>>
//                                             the bootstrap token Secret's random data values
//   <<sha256:ca>>                             the CA public key hash in the printed join command
//   <<dryrundir>>                             the dry-run directory in printed paths
//
// Host detection that changes the output, checked before capturing so a capture on another machine
// fails instead of drifting: the CA directories kubeadm mounts into the API server and controller
// manager when they exist (upstream: cmd/kubeadm/app/phases/controlplane/volumes.go
// caCertsExtraVolumePaths) must be those of an Ubuntu 24.04 server (/etc/ca-certificates,
// /usr/share/ca-certificates, /usr/local/share/ca-certificates from the ca-certificates package;
// no /etc/pki), and systemd-resolved must be active, which makes the kubelet's resolvConf
// /run/systemd/resolve/resolv.conf (upstream: cmd/kubeadm/app/componentconfigs/kubelet_unix.go).
//
// Recorded with kubeadm v1.37.2 and kubectl v1.37.2 (release binaries), util-linux 2.39.3 unshare,
// Linux 7.2.15-76070215-generic, Node 26.13.1, on 2026-11-16.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { binaryPath } from '../oracle/binaries.ts';
import { repoRoot } from '../oracle/paths.ts';
import { CLUSTER } from '../oracle/topology.ts';

const outDir = path.join(repoRoot, 'fixtures', 'reference', 'kubeadm', KUBERNETES_TAG);
const moduleFile = path.join(repoRoot, 'packages', 'k8s', 'src', 'topology', 'kubeadm', 'reference.ts');
const COMMAND = 'npm run kubeadm:capture';

// The cluster's values come from the topology (D-033); the CRI socket and cgroup driver are
// kubeadm's defaults for containerd, left implicit as a real `kubeadm init` would.
const INIT_CONFIG = `apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: ${CLUSTER.advertiseAddress}
  bindPort: ${CLUSTER.apiserverPort}
nodeRegistration:
  name: ${CLUSTER.controlPlaneName}
  criSocket: unix:///var/run/containerd/containerd.sock
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: ${KUBERNETES_TAG}
clusterName: ${CLUSTER.clusterName}
networking:
  podSubnet: ${CLUSTER.podCIDR}
  serviceSubnet: ${CLUSTER.serviceCIDR}
`;

/** Where each file in the dry-run directory lives on the real node (upstream: cmd/kubeadm/app/constants/constants.go). */
const REAL_PATHS: Record<string, string> = {
  'etcd.yaml': '/etc/kubernetes/manifests/etcd.yaml',
  'kube-apiserver.yaml': '/etc/kubernetes/manifests/kube-apiserver.yaml',
  'kube-controller-manager.yaml': '/etc/kubernetes/manifests/kube-controller-manager.yaml',
  'kube-scheduler.yaml': '/etc/kubernetes/manifests/kube-scheduler.yaml',
  'admin.conf': '/etc/kubernetes/admin.conf',
  'super-admin.conf': '/etc/kubernetes/super-admin.conf',
  'controller-manager.conf': '/etc/kubernetes/controller-manager.conf',
  'scheduler.conf': '/etc/kubernetes/scheduler.conf',
  'kubelet.conf': '/etc/kubernetes/kubelet.conf',
  'config.yaml': '/var/lib/kubelet/config.yaml',
  'kubeadm-flags.env': '/var/lib/kubelet/kubeadm-flags.env',
  'instance-config.yaml': '/var/lib/kubelet/instance-config.yaml',
};
const PKI_DIR = '/etc/kubernetes/pki';
const FINALIZED_CERT = '/var/lib/kubelet/pki/kubelet-client-current.pem';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

interface CapturedFile {
  path: string;
  mode: string;
  text?: string;
}

interface Capture {
  files: CapturedFile[];
  finalizedKubeletConf: string;
  objects: JsonObject[];
  node: { labels: Record<string, string>; taints: { key: string; effect: string }[] };
  stdout: string;
}

function fail(msg: string): never {
  console.error(`kubeadm:capture: ${msg}`);
  process.exit(1);
}

function checkHost(): void {
  const want = ['/etc/ca-certificates', '/usr/share/ca-certificates', '/usr/local/share/ca-certificates'];
  const unwanted = ['/etc/pki/ca-trust', '/etc/pki/tls/certs'];
  for (const d of want) if (!existsSync(d)) fail(`${d} is missing; an Ubuntu 24.04 server has it and kubeadm would mount it`);
  for (const d of unwanted) if (existsSync(d)) fail(`${d} exists; an Ubuntu 24.04 server has no /etc/pki and kubeadm would mount it`);
  const r = spawnSync('systemctl', ['is-active', 'systemd-resolved'], { encoding: 'utf8' });
  if (r.stdout.trim() !== 'active') fail('systemd-resolved is not active; on an Ubuntu 24.04 server it is, and kubeadm sets resolvConf from that');
}

function runKubeadm(work: string): { stdout: string; dryRunDir: string } {
  const dryRunDir = path.join(work, 'dry-run');
  mkdirSync(dryRunDir);
  const cfg = path.join(work, 'init-config.yaml');
  writeFileSync(cfg, INIT_CONFIG);
  const kubeadm = binaryPath('kubeadm');
  if (!existsSync(kubeadm)) fail(`${kubeadm} is missing; run npm run oracle -- fetch`);
  const script = `umask 022 && hostname ${CLUSTER.controlPlaneName} && exec "$0" init --config "$1" --dry-run --ignore-preflight-errors=all`;
  const r = spawnSync('unshare', ['-r', '-u', '/bin/sh', '-c', script, kubeadm, cfg], {
    cwd: work,
    encoding: 'utf8',
    env: { HOME: work, PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', KUBEADM_INIT_DRYRUN_DIR: dryRunDir },
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) fail(`kubeadm init --dry-run exited ${String(r.status)}:\n${r.stderr}`);
  return { stdout: r.stdout, dryRunDir };
}

function walk(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel))
    .sort()
    .flatMap((n) => {
      const r = rel ? `${rel}/${n}` : n;
      return statSync(path.join(dir, r)).isDirectory() ? walk(dir, r) : [r];
    });
}

function mode(file: string): string {
  return '0' + (statSync(file).mode & 0o777).toString(8);
}

/** The blocks printed after `[dryrun] Would write file "<path>" with content:`, up to the next `[` line. */
function printedFiles(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[dryrun\] Would write file "([^"]+)" with content:$/.exec(lines[i] as string);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !(lines[j] as string).startsWith('[')) j++;
    out.set(m[1] as string, lines.slice(i + 1, j).join('\n'));
    i = j - 1;
  }
  return out;
}

interface Action {
  verb: string;
  resource: string;
  group: string;
  object?: string;
}

/** Every `[dryrun] Would perform action …` with the YAML object attached to it, if any. */
function actions(stdout: string): Action[] {
  const out: Action[] = [];
  const lines = stdout.split('\n');
  let cur: Action | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^\[dryrun\] Would perform action (\w+) on resource "([^"]+)" in API group "([^"]+)"$/.exec(line);
    if (m) {
      cur = { verb: m[1] as string, resource: m[2] as string, group: m[3] as string };
      out.push(cur);
      continue;
    }
    if (line === '[dryrun] Attached object:') {
      if (!cur) fail(`an attached object with no action at stdout line ${i + 1}`);
      let j = i + 1;
      while (j < lines.length && !(lines[j] as string).startsWith('[')) j++;
      cur.object = lines.slice(i + 1, j).join('\n');
      i = j - 1;
      continue;
    }
    // A line that is neither part of the action nor its object ends the action.
    if (!line.startsWith('[dryrun] Resource name ') && !line.startsWith('[dryrun] Real object does not exist')) cur = undefined;
  }
  return out;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function replaceAll(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

const DATA_LINE = /^(\s*)(certificate-authority-data|client-certificate-data|client-key-data): (\S+)$/gm;

/** Replaces a kubeconfig's base64 certificate and key data with tokens; the CA must be the cluster CA. */
function tokenizeKubeconfig(text: string, name: string, caB64: string, where: string): string {
  let n = 0;
  const out = text.replace(DATA_LINE, (_all, indent: string, field: string, value: string) => {
    n++;
    if (field === 'certificate-authority-data') {
      if (value !== caB64) fail(`${where}: certificate-authority-data is not the cluster CA`);
      return `${indent}${field}: <<cert:ca>>`;
    }
    return `${indent}${field}: <<${field === 'client-key-data' ? 'key' : 'cert'}:${name}>>`;
  });
  if (n === 0) fail(`${where}: no certificate data found`);
  return out;
}

function capture(): Capture {
  checkHost();
  const work = mkdtempSync(path.join(tmpdir(), 'simlab-kubeadm-'));
  try {
    const { stdout, dryRunDir } = runKubeadm(work);
    const caB64 = readFileSync(path.join(dryRunDir, 'ca.crt')).toString('base64');

    const tokenMatch = /^\[bootstrap-token\] Using token: ([a-z0-9]{6})\.([a-z0-9]{16})$/m.exec(stdout);
    if (!tokenMatch) fail('the bootstrap token line is missing from the output');
    const [tokenId, tokenSecret] = [tokenMatch[1] as string, tokenMatch[2] as string];

    // Files.
    const printed = printedFiles(stdout);
    const files: CapturedFile[] = [];
    for (const rel of walk(dryRunDir)) {
      const abs = path.join(dryRunDir, rel);
      const real = REAL_PATHS[rel];
      if (!real) {
        if (!/\.(crt|key|pub)$/.test(rel)) fail(`unexpected file in the dry-run directory: ${rel}`);
        files.push({ path: `${PKI_DIR}/${rel}`, mode: mode(abs) });
        continue;
      }
      let text = readFileSync(abs, 'utf8');
      if (text.includes(dryRunDir)) fail(`${rel} mentions the dry-run directory`);
      const shown = printed.get(real);
      if (shown !== undefined && shown.replace(/\n+$/, '') !== text.replace(/\n+$/, '')) fail(`${real}: the printed content differs from the file written`);
      if (rel.endsWith('.conf')) text = tokenizeKubeconfig(text, rel.replace(/\.conf$/, ''), caB64, rel);
      files.push({ path: real, mode: mode(abs), text });
    }
    for (const real of Object.values(REAL_PATHS)) if (!files.some((f) => f.path === real)) fail(`kubeadm did not write ${real}`);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // kubelet-finalize: point the node's credentials at the rotated certificate, as the phase does.
    const kubeletConf = path.join(work, 'kubelet.conf');
    writeFileSync(kubeletConf, readFileSync(path.join(dryRunDir, 'kubelet.conf')));
    execFileSync(binaryPath('kubectl'), ['config', 'set-credentials', `system:node:${CLUSTER.controlPlaneName}`, `--kubeconfig=${kubeletConf}`,
      `--client-certificate=${FINALIZED_CERT}`, `--client-key=${FINALIZED_CERT}`], { env: { HOME: work, PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
    const finalizedKubeletConf = tokenizeKubeconfig(readFileSync(kubeletConf, 'utf8'), 'kubelet', caB64, 'finalized kubelet.conf');
    if (/client-(certificate|key)-data/.test(finalizedKubeletConf)) fail('the finalized kubelet.conf still embeds the client certificate');

    // Objects: every CREATE. GETs and LISTs read; the one PATCH (the Node) prints the dry-run
    // client's stand-in Node rather than the patch, so the marks come from the phase's own lines.
    const objects: JsonObject[] = [];
    for (const a of actions(stdout)) {
      if (a.verb === 'GET' || a.verb === 'LIST') continue;
      if (a.verb === 'PATCH' && a.resource === 'nodes') continue;
      if (a.verb !== 'CREATE') fail(`unexpected dry-run action ${a.verb} ${a.resource}`);
      if (a.object === undefined) fail(`CREATE ${a.resource} has no attached object`);
      const obj = parseYaml(a.object) as JsonObject;
      objects.push(tokenizeObject(obj, caB64, tokenId, tokenSecret));
    }

    const labelsLine = /^\[mark-control-plane\] Marking the node \S+ as control-plane by adding the labels: \[([^\]]*)\]$/m.exec(stdout);
    const taintsLine = /^\[mark-control-plane\] Marking the node \S+ as control-plane by adding the taints \[([^\]]*)\]$/m.exec(stdout);
    if (!labelsLine || !taintsLine) fail('the mark-control-plane lines are missing from the output');
    // Label values are empty (upstream: cmd/kubeadm/app/phases/markcontrolplane/markcontrolplane.go
    // markControlPlaneNode); taints print as key:Effect (Taint.ToString), no value.
    const node = {
      labels: Object.fromEntries((labelsLine[1] as string).split(' ').map((k) => [k, ''])),
      taints: (taintsLine[1] as string).split(' ').map((t) => {
        const m = /^([^=:]+):(\w+)$/.exec(t);
        if (!m) fail(`unexpected taint ${t}`);
        return { key: m[1] as string, effect: m[2] as string };
      }),
    };

    // Standard output, for reference.
    const hashMatch = /--discovery-token-ca-cert-hash sha256:([0-9a-f]{64})/.exec(stdout);
    if (!hashMatch) fail('the join command is missing from the output');
    let out = replaceAll(stdout, dryRunDir, '<<dryrundir>>');
    out = replaceAll(out, `${tokenId}.${tokenSecret}`, '<<token:id>>.<<token:secret>>');
    out = replaceAll(out, `bootstrap-token-${tokenId}`, 'bootstrap-token-<<token:id>>');
    out = replaceAll(out, caB64, '<<cert:ca>>');
    out = replaceAll(out, hashMatch[1] as string, '<<sha256:ca>>');
    out = out.replace(/^( {2}(token-id|token-secret|expiration): )\S+$/gm, (_a, p: string, k: string) => `${p}<<base64:token:${k === 'token-id' ? 'id' : k === 'token-secret' ? 'secret' : 'expiration'}>>`);
    if (out.includes(tokenSecret)) fail('the token secret survived normalization');

    return { files, finalizedKubeletConf, objects, node, stdout: out };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function tokenizeObject(obj: JsonObject, caB64: string, tokenId: string, tokenSecret: string): JsonObject {
  const meta = obj['metadata'] as JsonObject;
  const where = `${String(obj['kind'])} ${String(meta['namespace'] ?? '')}/${String(meta['name'])}`;
  if (obj['kind'] === 'Secret' && obj['type'] === 'bootstrap.kubernetes.io/token') {
    const data = obj['data'] as Record<string, string>;
    if (data['token-id'] !== b64(tokenId) || data['token-secret'] !== b64(tokenSecret)) fail(`${where}: the token does not match the printed one`);
    data['token-id'] = '<<base64:token:id>>';
    data['token-secret'] = '<<base64:token:secret>>';
    data['expiration'] = '<<base64:token:expiration>>';
    meta['name'] = replaceAll(String(meta['name']), tokenId, '<<token:id>>');
  }
  if (obj['kind'] === 'ConfigMap' && meta['name'] === 'cluster-info') {
    const data = obj['data'] as Record<string, string>;
    data['kubeconfig'] = tokenizeKubeconfig(data['kubeconfig'] as string, 'cluster-info', caB64, where);
  }
  const s = JSON.stringify(obj);
  if (s.includes(tokenSecret) || s.includes(caB64)) fail(`${where}: a secret value survived tokenization`);
  return obj;
}

// ---- output ----

function fixtureFiles(c: Capture): Map<string, string> {
  const m = new Map<string, string>();
  m.set('init-config.yaml', INIT_CONFIG);
  for (const f of c.files) if (f.text !== undefined) m.set(`files${f.path}`, f.text);
  m.set('kubelet-finalize/etc/kubernetes/kubelet.conf', c.finalizedKubeletConf);
  m.set('files.json', JSON.stringify(c.files.map((f) => ({ path: f.path, mode: f.mode })), null, 2) + '\n');
  m.set('objects.json', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: c.objects }, null, 2) + '\n');
  m.set('node.json', JSON.stringify(c.node, null, 2) + '\n');
  m.set('init-dry-run.txt', c.stdout);
  return m;
}

function generatedModule(c: Capture): string {
  const byKind: Record<string, JsonObject[]> = {};
  for (const o of c.objects) (byKind[String(o['kind'])] ??= []).push(o);
  const kinds = Object.keys(byKind).sort();
  const order = c.objects.map((o) => {
    const meta = o['metadata'] as JsonObject;
    return { apiVersion: o['apiVersion'], kind: o['kind'], ...(meta['namespace'] ? { namespace: meta['namespace'] } : {}), name: meta['name'] };
  });
  const files = c.files.filter((f) => f.text !== undefined);
  const pki = c.files.filter((f) => f.text === undefined);
  const manifests = staticPodManifests(files);
  const j = (v: unknown): string => JSON.stringify(v, null, 2);
  return `// Generated by tools/src/kubeadm/capture.ts. Do not edit; regenerate with \`${COMMAND}\`.
//
// What the real kubeadm ${KUBERNETES_TAG} \`init\` writes and creates on the kubeadm-1cp-2w control plane
// (rank 1, docs/FIDELITY.md §2; the capture and its inputs: fixtures/reference/kubeadm/${KUBERNETES_TAG}/).
// File texts are verbatim except for tokens: <<cert:ca>>, <<cert:NAME>> and <<key:NAME>> stand for
// base64 PEM data (NAME is the kubeconfig's base name), <<token:id>> and <<token:secret>> for the
// bootstrap token, <<base64:token:…>> for the bootstrap token Secret's random data values.
// Not captured, because a dry run skips it: the kubeadm:cluster-admins ClusterRoleBinding (see
// UPSTREAM_OBJECTS).

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type JsonObject = { readonly [k: string]: Json };

export interface KubeadmFile {
  /** Absolute path on the control-plane node. */
  readonly path: string;
  /** Permission bits, octal, as kubeadm creates the file. */
  readonly mode: string;
  readonly text: string;
}

/** Static Pod manifests, kubeconfigs and kubelet files, as written during init. */
export const KUBEADM_FILES: readonly KubeadmFile[] = ${j(files)};

/**
 * The four static Pod manifests as objects (etcd, kube-apiserver, kube-controller-manager,
 * kube-scheduler), parsed by the capture script from exactly the texts in KUBEADM_FILES.
 */
export const STATIC_POD_MANIFESTS: readonly JsonObject[] = ${j(manifests)};

/** /etc/kubernetes/kubelet.conf after init's kubelet-finalize phase, the state a running node has. */
export const KUBELET_CONF_FINALIZED: string = ${j(c.finalizedKubeletConf)};

/** Certificates and keys under /etc/kubernetes/pki: names and modes only. */
export const PKI_FILES: readonly { readonly path: string; readonly mode: string }[] = ${j(pki.map((f) => ({ path: f.path, mode: f.mode })))};

/** The objects kubeadm creates through the API, grouped by kind (${kinds.join(', ')}). */
export const KUBEADM_OBJECTS: { readonly [kind: string]: readonly JsonObject[] } = ${j(Object.fromEntries(kinds.map((k) => [k, byKind[k]])))};

/** The order kubeadm creates them in. */
export const KUBEADM_OBJECT_ORDER: readonly { readonly apiVersion: string; readonly kind: string; readonly namespace?: string; readonly name: string }[] = ${j(order)};

/** Labels and taints kubeadm's mark-control-plane phase patches onto the control-plane Node. */
export const CONTROL_PLANE_NODE_MARKS: { readonly labels: { readonly [k: string]: string }; readonly taints: readonly { readonly key: string; readonly effect: string }[] } = ${j(c.node)};

/**
 * Objects a real init creates that a dry run does not print, transcribed from source (rank 2).
 * upstream: cmd/kubeadm/app/phases/kubeconfig/kubeconfig.go EnsureAdminClusterRoleBindingImpl
 * (created with the admin.conf or super-admin.conf client before the upload-config phase).
 */
export const UPSTREAM_OBJECTS: readonly JsonObject[] = ${j([CLUSTER_ADMINS_CRB])};
`;
}

const STATIC_PODS = ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler'];

/**
 * Parses the manifests the way both YAML versions read them and requires the two to agree, so the
 * objects do not depend on a 1.1-versus-1.2 scalar rule (the kubelet decodes with sigs.k8s.io/yaml,
 * which follows YAML 1.1; kubeadm's marshaller quotes every string either version could misread).
 */
function staticPodManifests(files: CapturedFile[]): JsonObject[] {
  return STATIC_PODS.map((name) => {
    const p = `/etc/kubernetes/manifests/${name}.yaml`;
    const text = files.find((f) => f.path === p)?.text;
    if (text === undefined) fail(`${p} was not captured`);
    const v12 = JSON.stringify(parseYaml(text));
    const v11 = JSON.stringify(parseYaml(text, { version: '1.1' }));
    if (v12 !== v11) fail(`${p} reads differently as YAML 1.1 and 1.2`);
    const obj = JSON.parse(v12) as JsonObject;
    const meta = obj['metadata'] as JsonObject;
    if (obj['kind'] !== 'Pod' || meta['name'] !== name || meta['namespace'] !== 'kube-system') fail(`${p} is not the kube-system/${name} Pod`);
    return obj;
  });
}

const CLUSTER_ADMINS_CRB = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'ClusterRoleBinding',
  metadata: { name: 'kubeadm:cluster-admins' },
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
  subjects: [{ kind: 'Group', name: 'kubeadm:cluster-admins' }],
};

function main(): void {
  const check = process.argv.includes('--check');
  const c = capture();
  const want = fixtureFiles(c);
  want.set(path.relative(outDir, moduleFile), generatedModule(c));
  const resolveOut = (rel: string): string => path.resolve(outDir, rel);
  if (check) {
    let differ = false;
    for (const [rel, text] of want) {
      const p = resolveOut(rel);
      const have = existsSync(p) ? readFileSync(p, 'utf8') : undefined;
      if (have !== text) {
        differ = true;
        console.error(`${path.relative(repoRoot, p)}: ${have === undefined ? 'missing' : 'differs from a fresh capture'}`);
      }
    }
    for (const rel of existsSync(outDir) ? walk(outDir) : []) {
      if (!want.has(rel)) {
        differ = true;
        console.error(`${path.relative(repoRoot, resolveOut(rel))}: not produced by a fresh capture`);
      }
    }
    if (differ) fail(`the committed capture is out of date; run ${COMMAND}`);
    console.log(`kubeadm:capture: ${want.size} files match a fresh capture`);
    return;
  }
  rmSync(outDir, { recursive: true, force: true });
  for (const [rel, text] of want) {
    const p = resolveOut(rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  console.log(`kubeadm:capture: wrote ${want.size - 1} files to ${path.relative(repoRoot, outDir)} and ${path.relative(repoRoot, moduleFile)}`);
}

main();
