// The image references `npm run images:capture` records: the images learners and the Kubernetes
// docs use most, and every image a kubeadm v1.37.2 control plane on containerd 1.7.28 pulls.

/** A registry the tool queries, and how (docs: https://distribution.github.io/distribution/spec/api/). */
export interface RegistrySpec {
  /** The name in an image reference, e.g. docker.io. */
  readonly name: string;
  /** Base URL of the registry's /v2/ API. */
  readonly api: string;
  /** Anonymous bearer token endpoint and service, when the registry requires a token for public pulls. */
  readonly token?: { readonly realm: string; readonly service: string };
  readonly note?: string;
}

export const REGISTRIES: readonly RegistrySpec[] = [
  {
    name: 'docker.io',
    api: 'https://registry-1.docker.io',
    token: { realm: 'https://auth.docker.io/token', service: 'registry.docker.io' },
    note: 'anonymous pull token per repository (scope repository:<path>:pull); docker.io/<name> is docker.io/library/<name>',
  },
  {
    name: 'registry.k8s.io',
    api: 'https://registry.k8s.io',
    note: 'manifests and blobs answer anonymously; existing repositories redirect (307) to a regional Artifact Registry mirror',
  },
];

/**
 * A patch tag found at capture time: the value of `env` in the image config of `from`, e.g. nginx's
 * NGINX_VERSION in 1.29 names the current 1.29.x tag. With `minor`, its X.Y tag too (the current
 * mainline and stable lines move: on 2026-11-16 latest was 1.31.8 and stable 1.30.6).
 */
export interface PatchTagRule {
  readonly from: string;
  readonly env: string;
  readonly minor?: boolean;
}

export interface RepositorySpec {
  readonly registry: string;
  /** Repository path in the registry, e.g. library/nginx. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly patchTags?: readonly PatchTagRule[];
}

export const REPOSITORIES: readonly RepositorySpec[] = [
  {
    registry: 'docker.io',
    path: 'library/nginx',
    // 1.14.2 is the Kubernetes docs' example (https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
    tags: ['latest', 'stable', 'mainline', '1', '1.29', '1.28', 'alpine', '1.27', '1.25', '1.23', '1.21', '1.20', '1.19', '1.17', '1.16', '1.14.2'],
    patchTags: [
      { from: 'latest', env: 'NGINX_VERSION', minor: true },
      { from: 'stable', env: 'NGINX_VERSION', minor: true },
      { from: '1.29', env: 'NGINX_VERSION' },
      { from: '1.28', env: 'NGINX_VERSION' },
    ],
  },
  {
    registry: 'docker.io',
    path: 'library/httpd',
    tags: ['latest', '2', '2.4', 'alpine'],
    patchTags: [{ from: '2.4', env: 'HTTPD_VERSION' }],
  },
  {
    registry: 'docker.io',
    path: 'library/redis',
    tags: ['latest', '8', '7', '7.4', '7.2', '6', '6.2', 'alpine'],
    patchTags: [{ from: '8', env: 'REDIS_VERSION', minor: true }],
  },
  {
    registry: 'docker.io',
    path: 'library/busybox',
    // 1.28 is used throughout the Kubernetes docs.
    tags: ['latest', '1', '1.37', '1.36', '1.35', '1.28', 'musl', 'glibc', 'uclibc'],
  },
  {
    registry: 'docker.io',
    path: 'library/alpine',
    // 3.24 and 3.23 are newer than the list first asked for (3.22 down), added at the first capture
    tags: ['latest', '3', '3.24', '3.23', '3.22', '3.21', '3.20', '3.19'],
  },
  // containerd 1.7.28's default sandbox image (upstream: containerd v1.7.28 pkg/cri/config/config_unix.go
  // DefaultConfig SandboxImage "registry.k8s.io/pause:3.8") and the ones kubeadm and kubelets name.
  { registry: 'registry.k8s.io', path: 'pause', tags: ['3.10.2', '3.10.1', '3.10', '3.9', '3.8'] },
  // packages/k8s/src/topology/kubeadm/reference.ts: the images in kubeadm v1.37.2's manifests and addons.
  { registry: 'registry.k8s.io', path: 'coredns/coredns', tags: ['v1.14.6'] },
  { registry: 'registry.k8s.io', path: 'etcd', tags: ['3.7.0-0'] },
  { registry: 'registry.k8s.io', path: 'kube-apiserver', tags: ['v1.37.2'] },
  { registry: 'registry.k8s.io', path: 'kube-controller-manager', tags: ['v1.37.2'] },
  { registry: 'registry.k8s.io', path: 'kube-scheduler', tags: ['v1.37.2'] },
  { registry: 'registry.k8s.io', path: 'kube-proxy', tags: ['v1.37.2'] },
];

/** References that must not resolve, recorded for the error text containerd builds from the answers. */
export interface ErrorProbe {
  readonly reference: string;
  readonly registry: string;
  readonly path: string;
  readonly tag: string;
  readonly what: string;
}

export const ERROR_PROBES: readonly ErrorProbe[] = [
  { reference: 'docker.io/library/nginx:nosuchtag-simlab', registry: 'docker.io', path: 'library/nginx', tag: 'nosuchtag-simlab', what: 'missing tag of an existing Docker Hub repository' },
  { reference: 'docker.io/library/nosuchimage-simlab:latest', registry: 'docker.io', path: 'library/nosuchimage-simlab', tag: 'latest', what: 'missing official-image repository' },
  { reference: 'docker.io/simlab-nouser/nosuch:1', registry: 'docker.io', path: 'simlab-nouser/nosuch', tag: '1', what: 'missing user repository' },
  { reference: 'registry.k8s.io/pause:nosuchtag-simlab', registry: 'registry.k8s.io', path: 'pause', tag: 'nosuchtag-simlab', what: 'missing tag of an existing registry.k8s.io repository' },
  { reference: 'registry.k8s.io/nosuchimage-simlab:latest', registry: 'registry.k8s.io', path: 'nosuchimage-simlab', tag: 'latest', what: 'missing registry.k8s.io repository' },
];

/**
 * The Accept header containerd 1.7.28 sends when it resolves a reference (upstream: containerd
 * v1.7.28 remotes/docker/resolver.go NewResolver): the registry picks the document type from it.
 */
export const RESOLVE_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  '*/*',
].join(', ');

/** The node platform (packages/k8s/src/topology/nodes.ts: linux/amd64 Ubuntu nodes). */
export const PLATFORM = { os: 'linux', architecture: 'amd64' } as const;

/**
 * Images whose layers the tool downloads to list their files (PATH entries, entrypoint scripts).
 * Every other captured image takes the files of its family's representative: the first family of
 * its repository, unless one of its tags is a family's `tag` or is in its `alsoTags`. That is an
 * approximation (a different tag of the same family can add or drop a binary).
 */
export interface FamilySpec {
  readonly family: string;
  readonly repository: string;
  readonly tag: string;
  readonly alsoTags?: readonly string[];
  /**
   * Distroless or scratch: also list every executable regular file wherever it is. kube-proxy is
   * not one (its base is Debian with iptables) and is listed through PATH like the others.
   */
  readonly distroless?: boolean;
}

export const FAMILIES: readonly FamilySpec[] = [
  { family: 'alpine', repository: 'docker.io/library/alpine', tag: 'latest' },
  // busybox:latest is the glibc build; uclibc is approximated by it
  { family: 'busybox', repository: 'docker.io/library/busybox', tag: 'latest' },
  { family: 'busybox-1.28', repository: 'docker.io/library/busybox', tag: '1.28' },
  { family: 'busybox-musl', repository: 'docker.io/library/busybox', tag: 'musl' },
  { family: 'httpd', repository: 'docker.io/library/httpd', tag: 'latest' },
  { family: 'httpd-alpine', repository: 'docker.io/library/httpd', tag: 'alpine' },
  { family: 'nginx', repository: 'docker.io/library/nginx', tag: 'latest' },
  { family: 'nginx-alpine', repository: 'docker.io/library/nginx', tag: 'alpine' },
  // before 1.19 the nginx images had no /docker-entrypoint.sh (Debian stretch/buster bases)
  { family: 'nginx-1.14.2', repository: 'docker.io/library/nginx', tag: '1.14.2', alsoTags: ['1.16', '1.17'] },
  { family: 'redis', repository: 'docker.io/library/redis', tag: 'latest' },
  { family: 'redis-alpine', repository: 'docker.io/library/redis', tag: 'alpine' },
  { family: 'coredns', repository: 'registry.k8s.io/coredns/coredns', tag: 'v1.14.6', distroless: true },
  { family: 'etcd', repository: 'registry.k8s.io/etcd', tag: '3.7.0-0', distroless: true },
  { family: 'kube-apiserver', repository: 'registry.k8s.io/kube-apiserver', tag: 'v1.37.2', distroless: true },
  { family: 'kube-controller-manager', repository: 'registry.k8s.io/kube-controller-manager', tag: 'v1.37.2', distroless: true },
  { family: 'kube-proxy', repository: 'registry.k8s.io/kube-proxy', tag: 'v1.37.2' },
  { family: 'kube-scheduler', repository: 'registry.k8s.io/kube-scheduler', tag: 'v1.37.2', distroless: true },
  { family: 'pause', repository: 'registry.k8s.io/pause', tag: '3.10.1', distroless: true },
];

export function familyFor(repository: string, tags: readonly string[]): FamilySpec | undefined {
  const own = FAMILIES.filter((f) => f.repository === repository);
  return own.find((f) => tags.includes(f.tag)) ?? own.find((f) => f.alsoTags?.some((t) => tags.includes(t))) ?? own[0];
}

/**
 * Tag lists kept in the catalog. registry.k8s.io's kube-* repositories hold every release for
 * every architecture: only v1.30 to v1.39 are kept (plus the captured tags). Cosign signature,
 * attestation and SBOM tags (sha256-<hex>.sig/.att/.sbom) are not images and are dropped everywhere.
 */
export function keepTag(repository: string, tag: string, captured: readonly string[]): boolean {
  if (captured.includes(tag)) return true;
  if (/^sha256-[0-9a-f]{64}(\.[a-z]+)?$/.test(tag)) return false;
  if (/^registry\.k8s\.io\/kube-/.test(repository)) return /^v1\.3[0-9]\./.test(tag);
  return true;
}

/** Where the official image names come from. */
export const OFFICIAL_IMAGES_SOURCES = {
  // every repository in the library namespace, deprecated ones included (still pullable)
  hub: 'https://hub.docker.com/v2/repositories/library/?page_size=100',
  // the images currently maintained: one file per image in library/
  github: { repository: 'docker-library/official-images', path: 'library' },
} as const;
