// The oracle's binaries: the official release builds of the pinned Kubernetes version, the etcd
// release kubeadm pairs with it, and KWOK. Downloaded into .upstream/bin/ (git-ignored) and
// verified against published SHA-256 digests (docs/FIDELITY.md §6).
//
// Checksums are trusted on first use and then pinned in checksums.json (committed): a later
// download whose published digest or content differs from the pinned one fails.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { repoRoot } from './paths.ts';

/** KWOK release used to make fake Nodes heartbeat and Pods reach Running. Not a reference for any string. */
export const KWOK_VERSION = 'v0.8.0';

export const binDir = path.join(repoRoot, '.upstream', 'bin');
const checksumsFile = path.join(import.meta.dirname, 'checksums.json');

export const KUBERNETES_BINARIES = ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler', 'kubectl', 'kubeadm'] as const;
export type Binary = (typeof KUBERNETES_BINARIES)[number] | 'etcd' | 'etcdctl' | 'kwok';

/**
 * The etcd version kubeadm deploys with this Kubernetes release.
 * upstream: cmd/kubeadm/app/constants/constants.go DefaultEtcdVersion ("3.7.0-0" at v1.37.2)
 */
export function etcdVersion(): string {
  const src = readFileSync(path.join(repoRoot, '.upstream/kubernetes/cmd/kubeadm/app/constants/constants.go'), 'utf8');
  const m = /DefaultEtcdVersion\s*=\s*"([0-9.]+)-\d+"/.exec(src);
  if (!m) throw new Error('DefaultEtcdVersion not found in the upstream checkout; run npm run upstream:fetch');
  return `v${m[1] as string}`;
}

/** Directory holding every binary for the pinned version: .upstream/bin/v1.37.2/. */
export const versionBinDir = path.join(binDir, KUBERNETES_TAG);

export function binaryPath(b: Binary): string {
  return path.join(versionBinDir, b);
}

type Pins = Record<string, string>;

function readPins(): Pins {
  return existsSync(checksumsFile) ? (JSON.parse(readFileSync(checksumsFile, 'utf8')) as Pins) : {};
}

function writePins(p: Pins): void {
  const sorted = Object.fromEntries(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(checksumsFile, JSON.stringify(sorted, null, 2) + '\n');
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

async function fetchBytes(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Checks a published digest against the pin (adding it when new) and the content against both. */
function verify(pins: Pins, key: string, published: string, content: Buffer): void {
  const pinned = pins[key];
  if (pinned !== undefined && pinned !== published)
    throw new Error(`${key}: published checksum ${published} differs from the pinned ${pinned}`);
  const actual = sha256(content);
  if (actual !== published) throw new Error(`${key}: downloaded content has checksum ${actual}, expected ${published}`);
  pins[key] = published;
}

function install(dest: string, content: Buffer): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest + '.part', content);
  chmodSync(dest + '.part', 0o755);
  renameSync(dest + '.part', dest);
}

/** Downloads whatever is missing. Returns the list of binaries fetched. */
export async function fetchBinaries(log: (s: string) => void = console.log): Promise<string[]> {
  const pins = readPins();
  const fetched: string[] = [];
  try {
    // docs: https://kubernetes.io/releases/download/ (binaries and their .sha256 files on dl.k8s.io)
    for (const b of KUBERNETES_BINARIES) {
      if (existsSync(binaryPath(b))) continue;
      const url = `https://dl.k8s.io/release/${KUBERNETES_TAG}/bin/linux/amd64/${b}`;
      log(`fetching ${url}`);
      const published = (await fetchText(`${url}.sha256`)).trim().split(/\s+/)[0] as string;
      const content = await fetchBytes(url);
      verify(pins, `kubernetes/${KUBERNETES_TAG}/linux-amd64/${b}`, published, content);
      install(binaryPath(b), content);
      fetched.push(b);
    }

    // docs: https://github.com/etcd-io/etcd/releases (tarball plus SHA256SUMS)
    if (!existsSync(binaryPath('etcd')) || !existsSync(binaryPath('etcdctl'))) {
      const v = etcdVersion();
      const name = `etcd-${v}-linux-amd64.tar.gz`;
      const base = `https://github.com/etcd-io/etcd/releases/download/${v}`;
      log(`fetching ${base}/${name}`);
      const sums = await fetchText(`${base}/SHA256SUMS`);
      const line = sums.split('\n').find((l) => l.trim().endsWith(` ${name}`));
      if (!line) throw new Error(`${name} is not listed in SHA256SUMS`);
      const content = await fetchBytes(`${base}/${name}`);
      verify(pins, `etcd/${v}/${name}`, line.split(/\s+/)[0] as string, content);
      const tmp = path.join(versionBinDir, '.etcd-extract');
      mkdirSync(tmp, { recursive: true });
      writeFileSync(path.join(tmp, name), content);
      execFileSync('tar', ['-xzf', name, '--strip-components=1', `etcd-${v}-linux-amd64/etcd`, `etcd-${v}-linux-amd64/etcdctl`], { cwd: tmp });
      for (const b of ['etcd', 'etcdctl'] as const) install(binaryPath(b), readFileSync(path.join(tmp, b)));
      execFileSync('rm', ['-r', tmp]);
      fetched.push('etcd', 'etcdctl');
    }

    // docs: https://github.com/kubernetes-sigs/kwok/releases — no checksum file is published; the
    // digest comes from the GitHub release API's asset metadata.
    if (!existsSync(binaryPath('kwok'))) {
      const api = `https://api.github.com/repos/kubernetes-sigs/kwok/releases/tags/${KWOK_VERSION}`;
      const rel = JSON.parse(await fetchText(api)) as { assets: { name: string; digest?: string; browser_download_url: string }[] };
      const asset = rel.assets.find((a) => a.name === 'kwok-linux-amd64');
      if (!asset?.digest?.startsWith('sha256:')) throw new Error('kwok-linux-amd64 has no sha256 digest in the release metadata');
      log(`fetching ${asset.browser_download_url}`);
      const content = await fetchBytes(asset.browser_download_url);
      verify(pins, `kwok/${KWOK_VERSION}/kwok-linux-amd64`, asset.digest.slice('sha256:'.length), content);
      install(binaryPath('kwok'), content);
      fetched.push('kwok');
    }
  } finally {
    writePins(pins);
  }
  return fetched;
}

/** Throws with a hint when a binary is missing. */
export function requireBinaries(): void {
  const all: Binary[] = [...KUBERNETES_BINARIES, 'etcd', 'etcdctl', 'kwok'];
  const missing = all.filter((b) => !existsSync(binaryPath(b)));
  if (missing.length > 0) throw new Error(`missing oracle binaries (${missing.join(', ')}); run npm run oracle -- fetch`);
}
