// The simulated registries: which images exist, what a pull of a reference yields, and the error
// containerd 1.7.28 reports when it fails. Images come from the captured catalog
// (catalog.data.ts, `npm run images:capture`). A reference the catalog cannot answer for — an image
// that may well exist in reality but was not captured — is not invented: the pull fails with a
// `[sim]` message and a gap (docs/FIDELITY.md, hard rule 2).
//
// Error texts, piece by piece (.upstream/containerd at v1.7.28):
// - pkg/cri/server/image_pull.go PullImage: `failed to pull and unpack image %q: %w`;
// - pull.go fetch: `failed to resolve reference %q: %w`;
// - remotes/docker/resolver.go Resolve: `%s: %w` of the reference and errdefs.ErrNotFound
//   (`not found`) when every host answered 404; `pull access denied, repository does not exist or
//   may require authorization: %w` around authorizer.go's `server message: %s: %w` (the
//   registry's WWW-Authenticate error parameter, `insufficient_scope` on Docker Hub) and
//   ErrInvalidAuthorization (`authorization failed`); `failed to do request: %w` around Go's
//   url.Error (`Head "<url>": dial tcp: lookup <host> on 127.0.0.53:53: no such host`).
// - errdefs.ToGRPC: NotFound keeps code NotFound, the others are Unknown; the kubelet's CRI client
//   strips `rpc error: code = Unknown desc = ` only for Unknown
//   (staging/src/k8s.io/cri-client/pkg/remote_image.go PullImage).

import type { RuntimeImage } from '../types.ts';
import { DOCKER_OFFICIAL_IMAGES, IMAGE_CATALOG, IMAGE_REPOSITORY_TAGS, type CapturedImage } from './catalog.data.ts';
import type { ImageName } from './reference.ts';

export type PullOutcome =
  | { ok: CapturedImage }
  | { error: string; kind: 'not-found' | 'denied' | 'no-such-host' }
  | { notSimulated: string };

/** The registry host of a domain: Docker Hub's API host for docker.io (remotes/docker/resolver.go DefaultHost). */
export function registryHost(domain: string): string {
  return domain === 'docker.io' ? 'registry-1.docker.io' : domain;
}

/** Top-level domains reserved by RFC 2606 / RFC 6761: they never resolve. */
const NEVER_RESOLVES = /\.(example|invalid|test|localhost)$/;

function reference(n: ImageName): string {
  return `${n.repository}${n.tag !== undefined && n.digest === undefined ? `:${n.tag}` : ''}${n.digest !== undefined ? `@${n.digest}` : ''}`;
}

export function findCaptured(n: ImageName): CapturedImage | undefined {
  return IMAGE_CATALOG.find((i) => i.repository === n.repository && (n.digest !== undefined ? i.digest === n.digest || i.manifest.digest === n.digest : i.tags.includes(n.tag ?? 'latest')));
}

/** What pulling `n` gives, as containerd sees the registry answer. */
export function pullOutcome(n: ImageName): PullOutcome {
  const ref = reference(n);
  const hit = findCaptured(n);
  if (hit) return { ok: hit };
  const wrap = (inner: string): string => `failed to pull and unpack image "${ref}": failed to resolve reference "${ref}": ${inner}`;
  const host = n.domain.replace(/:\d+$/, '');
  if (NEVER_RESOLVES.test(host)) {
    const path = `/v2/${n.path}/manifests/${n.digest ?? n.tag ?? 'latest'}`;
    return { kind: 'no-such-host', error: wrap(`failed to do request: Head "https://${n.domain}${path}": dial tcp: lookup ${host} on 127.0.0.53:53: no such host`) };
  }
  const tags = IMAGE_REPOSITORY_TAGS[n.repository];
  if (tags) {
    // The capture keeps only v1.3x tags of the kube-* repositories: other tags are unknown, not absent.
    const filtered = /^registry\.k8s\.io\/kube-/.test(n.repository) && !/^v1\.3[0-9]\./.test(n.tag ?? '');
    if (n.digest === undefined && !filtered && !tags.includes(n.tag ?? 'latest')) {
      return { kind: 'not-found', error: `rpc error: code = NotFound desc = ${wrap(`${ref}: not found`)}` };
    }
    return { notSimulated: `image ${ref} exists but is not in the simulator's image catalog` };
  }
  if (n.domain === 'docker.io' && n.path.startsWith('library/') && !n.path.slice('library/'.length).includes('/') && !DOCKER_OFFICIAL_IMAGES.includes(n.path.slice('library/'.length))) {
    return { kind: 'denied', error: wrap('pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed') };
  }
  return { notSimulated: `image ${ref} is not in the simulator's image catalog` };
}

/**
 * The size containerd reports (ImageStatus, the Pulled event, node status.images): the index, the
 * one platform manifest, the config and the compressed layers (containerd image.go Size → Usage
 * with WithUsageManifestLimit(1) and WithManifestUsage).
 */
export function imageSize(img: CapturedImage): number {
  return (img.index?.size ?? 0) + img.manifest.size + img.config.size + img.layers.reduce((a, l) => a + l.size, 0);
}

/**
 * The image as the store holds it after pulling `n` (pkg/cri/server/image_pull.go: the tag named,
 * and `<name>@<target digest>`; helpers.go getRepoDigestAndTag).
 */
export function storedImage(img: CapturedImage, n: ImageName): RuntimeImage {
  const tag = n.digest === undefined ? [`${n.repository}:${n.tag ?? 'latest'}`] : [];
  return { id: img.config.digest, repoTags: tag, repoDigests: [`${n.repository}@${img.digest}`], size: imageSize(img) };
}

/** The image named `repository:tag` as preloaded on a node (kubeadm's `config images pull`). */
export function preloaded(repository: string, tag: string): RuntimeImage {
  const img = IMAGE_CATALOG.find((i) => i.repository === repository && i.tags.includes(tag));
  if (!img) throw new Error(`image ${repository}:${tag} is not in the catalog`);
  return { id: img.config.digest, repoTags: [`${repository}:${tag}`], repoDigests: [`${repository}@${img.digest}`], size: imageSize(img) };
}

export function capturedById(id: string): CapturedImage | undefined {
  return IMAGE_CATALOG.find((i) => i.config.digest === id);
}
