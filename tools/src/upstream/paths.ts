// What `npm run upstream:fetch` checks out, one entry per upstream repository, each at a pinned
// tag into .upstream/<name>. Cone-mode sparse-checkout directories (files at the repository root
// always come along); each line says what reads it. Add a directory here when a phase needs one
// that is missing, or a repository with its tag and directories, and rerun the fetch (it is
// incremental). Every pin is recorded in docs/FIDELITY.md §1.

import { KUBERNETES_TAG, NODE_INFO } from '@simlab/k8s';

export interface UpstreamCheckout {
  /** Directory under .upstream/ and the name of its .upstream/<name>.json record. */
  readonly name: string;
  readonly repo: string;
  readonly tag: string;
  readonly paths: readonly string[];
  /**
   * A file in another checkout that states this checkout's tag (its first line, trimmed), as
   * containerd's script/setup/runc-version states the runc it is built and tested with. The
   * fetch fails if the two disagree, so a containerd bump cannot leave a stale runc behind.
   */
  readonly pinnedBy?: { readonly checkout: string; readonly file: string };
}

// The nodes' container runtime, `containerd://<version>` in Node.status.nodeInfo; the tag is
// derived from it so the version is written in one place.
const CONTAINERD_PREFIX = 'containerd://';
if (!NODE_INFO.containerRuntimeVersion.startsWith(CONTAINERD_PREFIX)) {
  throw new Error(`unexpected containerRuntimeVersion ${NODE_INFO.containerRuntimeVersion}`);
}
export const CONTAINERD_TAG = `v${NODE_INFO.containerRuntimeVersion.slice(CONTAINERD_PREFIX.length)}`;

export const KUBERNETES_CHECKOUT: UpstreamCheckout = {
  name: 'kubernetes',
  repo: 'https://github.com/kubernetes/kubernetes',
  tag: KUBERNETES_TAG,
  paths: [
    // kubectl: commands, describers, generators, error text (phases 07a–08, 15)
    'staging/src/k8s.io/kubectl',
    // -o formats, resource builder, printers shared by kubectl (07a, 15)
    'staging/src/k8s.io/cli-runtime',
    // server-side table printers: the columns of `kubectl get` (07a onward)
    'pkg/printers',
    // versioned API types and their doc comments (05a onward)
    'staging/src/k8s.io/api',
    // internal types, defaulting and validation per API group (05a onward)
    'pkg/apis',
    // meta/v1, validation helpers, field errors, status errors, label selectors, quantities
    'staging/src/k8s.io/apimachinery',
    // generic registry and request handling errors (conflict, already exists, not found) (05a)
    'staging/src/k8s.io/apiserver/pkg/registry',
    'staging/src/k8s.io/apiserver/pkg/endpoints',
    'staging/src/k8s.io/apiserver/pkg/admission',
    // generateName's suffix (names/generate.go), storage errors and preconditions (05a)
    'staging/src/k8s.io/apiserver/pkg/storage',
    // API-level helpers: Pod and Service warnings (pkg/api/pod/warnings.go, pkg/api/service), dropping
    // disabled fields (carry-over of 05a)
    'pkg/api',
    // feature gates and their defaults at the pin (kube_features.go)
    'pkg/features',
    // the API server's own bootstrap: system namespaces, the kubernetes Service (05a)
    'pkg/controlplane',
    // per-resource strategies: what create/update allow, immutability (05a onward)
    'pkg/registry',
    // OpenAPI v3 documents: explain, schema validation (05a, 08, 20c)
    'api/openapi-spec',
    // scheduler framework and plugins, FailedScheduling messages (06a, 20b)
    'pkg/scheduler',
    // kubelet: events, container and Pod lifecycle, probes, eviction, status (06b, 16a, 16b, 26a)
    'pkg/kubelet',
    // the CRI the kubelet speaks to containerd: messages and fields (api.proto), and the kubelet's
    // remote runtime and image clients, which pass containerd's gRPC errors through (06b, 16a)
    'staging/src/k8s.io/cri-api',
    'staging/src/k8s.io/cri-client',
    // image reference parsing and normalization behind the kubelet's InvalidImageName
    // (pkg/util/parsers ParseImageName, which calls distribution/reference) (06b)
    'pkg/util/parsers',
    'vendor/github.com/distribution/reference',
    // the `rpc error: code = … desc = …` text of a gRPC error as the kubelet prints it (06b)
    'vendor/google.golang.org/grpc/internal/status',
    'vendor/google.golang.org/grpc/codes',
    // kube-proxy (30)
    'pkg/proxy',
    // controllers (05b, 18a, 18b, 21)
    'pkg/controller',
    // the EndpointSlice reconciler the endpointslice controller calls (05b)
    'staging/src/k8s.io/endpointslice',
    // event recorders (record: core/v1 with the correlator; events: events.k8s.io/v1 with series),
    // work queue rate limiters, the informer's resync (05b)
    'staging/src/k8s.io/client-go/tools/record',
    'staging/src/k8s.io/client-go/tools/events',
    'staging/src/k8s.io/client-go/util/workqueue',
    // DeepHashObject: the pod-template-hash and ControllerRevision hashes (05b, 18a)
    'pkg/util/hash',
    // go-spew, which DeepHashObject prints objects with (05b)
    'vendor/github.com/davecgh/go-spew',
    // dump.ForHash: the go-spew configuration DeepHashObject prints with (05b)
    'vendor/k8s.io/utils/dump',
    // integer.RoundToInt32: the deployment controller's proportional scaling (05b)
    'vendor/k8s.io/utils/integer',
    // inf.Dec: the layout of resource.Quantity's decimal form, which DeepHashObject prints (05b)
    'vendor/gopkg.in/inf.v0',
    // NodeUnreachablePodReason ("NodeLost"), which the Pod printer shows (07a)
    'pkg/util/node',
    // kubectl's command framework: cobra commands, usage and errors, pflag parsing (07a)
    'vendor/github.com/spf13/cobra',
    'vendor/github.com/spf13/pflag',
    // the tab writer kubectl's table printer aligns with (07a)
    'vendor/github.com/liggitt/tabwriter',
    // the word wrapping of kubectl's help on a terminal (term_writer.go, help_flags_printer.go) (07a)
    'vendor/github.com/mitchellh/go-wordwrap',
    // kubectl's YAML output and input: sigs.k8s.io/yaml over go.yaml.in/yaml/v2 (07a, 07b)
    'vendor/sigs.k8s.io/yaml',
    'vendor/go.yaml.in/yaml/v2',
    // kubeconfig loading, contexts and the client's connection errors (07a)
    'staging/src/k8s.io/client-go/tools/clientcmd',
    'staging/src/k8s.io/client-go/rest',
    'staging/src/k8s.io/client-go/discovery',
    'staging/src/k8s.io/client-go/restmapper',
    // admission plugins, RBAC authorizer and bootstrap policy (20a, 20b)
    'plugin/pkg',
    // Pod Security admission checks and messages (20b)
    'staging/src/k8s.io/pod-security-admission',
    // shared helpers used by kubectl and controllers: tolerations, node affinity, resource math
    'staging/src/k8s.io/component-helpers',
    // the scheduler framework's interfaces, Status codes and config types (06a)
    'staging/src/k8s.io/kube-scheduler',
    // CRD types, structural schema validation (20c)
    'staging/src/k8s.io/apiextensions-apiserver/pkg/apis',
    'staging/src/k8s.io/apiextensions-apiserver/pkg/apiserver',
    // APIService types, for the schema of apiregistration.k8s.io (05a)
    'staging/src/k8s.io/kube-aggregator/pkg/apis',
    // kubeadm (27–29c)
    'cmd/kubeadm',
    // component flags: kube-apiserver, kube-controller-manager, kube-scheduler, kubelet (27)
    'cmd/kube-apiserver',
    'cmd/kube-controller-manager',
    'cmd/kube-scheduler',
    'cmd/kubelet',
    // the pause container: what the sandbox's init does with signals and children (06b)
    'build/pause',
  ],
};

// The root of the repository (client.go, pull.go, image.go, task.go: the client the CRI plugin
// calls) comes along with every cone-mode checkout.
export const CONTAINERD_CHECKOUT: UpstreamCheckout = {
  name: 'containerd',
  repo: 'https://github.com/containerd/containerd',
  tag: CONTAINERD_TAG,
  paths: [
    // the CRI plugin: image pull, status and size, container create/start/stop/status, sandboxes,
    // the CRI log format (io/), and the config defaults such as sandbox_image (06b, 16a, 16b)
    'pkg/cri',
    // the registry client: reference resolution, auth, the errors a registry returns (06b)
    'remotes',
    // image reference parsing and docker.io/library/…:latest normalization (06b)
    'reference',
    // containerd's error kinds and the gRPC codes they map to; errdefs/ re-exports the error
    // values and their texts ("not found") from the vendored github.com/containerd/errdefs (06b)
    'errdefs',
    'vendor/github.com/containerd/errdefs',
    // image manifests, indexes, platform matching, what an image's size sums (06b)
    'images',
    // the task API between the CRI plugin and the shim: "failed to create shim task" (06b)
    'runtime',
    // the runc shim and its process code: "OCI runtime create failed", exit statuses (06b)
    'cmd/containerd-shim-runc-v2',
    'pkg/process',
    // the shim's reaper: a signaled process's exit status is 128 + the signal (137 for SIGKILL) (06b)
    'sys/reaper',
    // the daemon's tasks service between the client and the shim manager, and ttrpc, which
    // turns a shim's error into the status the daemon maps back with errdefs.FromGRPC (06b)
    'services',
    'vendor/github.com/containerd/ttrpc',
    // OCI spec options built from the image config and the CRI request (06b)
    'oci',
    // go-cni, the CNI library behind a sandbox's network setup: "cni plugin not initialized",
    // the default interface eth0 and the IPs a sandbox gets (06b, 29a)
    'vendor/github.com/containerd/go-cni',
    // the go-runc wrapper the shim runs runc through (06b)
    'vendor/github.com/containerd/go-runc',
    // the gRPC status a CRI error becomes (06b)
    'vendor/google.golang.org/grpc/status',
    'vendor/google.golang.org/grpc/internal/status',
    'vendor/google.golang.org/grpc/codes',
    // the reference grammar the CRI plugin normalizes image names with (06b)
    'vendor/github.com/distribution/reference',
    // OCI image media types and config fields (StopSignal, Entrypoint, Cmd) (06b)
    'vendor/github.com/opencontainers/image-spec',
  ],
};

export const RUNC_CHECKOUT: UpstreamCheckout = {
  name: 'runc',
  repo: 'https://github.com/opencontainers/runc',
  tag: 'v1.3.0',
  pinnedBy: { checkout: 'containerd', file: 'script/setup/runc-version' },
  paths: [
    // container create and init: "runc create failed", "unable to start container process",
    // "error during container init", the exec lookup in the container (06b, 16a). The commands
    // themselves (create.go, utils_linux.go) are at the repository root.
    'libcontainer',
  ],
};

// The Go standard library at the release Go of containerd (its .github/workflows/release.yml
// GO_VERSION). runc v1.3.0 builds with Go 1.23 too (its Dockerfile). Error texts that reach
// a learner come from here: exec.LookPath inside the container, DNS and dial errors of the
// registry client, errno strings.
export const GO_CHECKOUT: UpstreamCheckout = {
  name: 'go',
  repo: 'https://github.com/golang/go',
  tag: 'go1.23.11',
  paths: [
    // os/exec Error and ErrNotFound: `exec: "foo": executable file not found in $PATH`; os.Stat's
    // `stat <path>` PathError (stat_unix.go) that LookPath wraps for a path with a slash (06b)
    'src/os',
    // fs.PathError (os.PathError): `stat /app: no such file or directory` (06b)
    'src/io/fs',
    // net.OpError, net.DNSError: `dial tcp: lookup … on …: no such host` (06b)
    'src/net',
    // time.RFC3339Nano and how the layout trims trailing zeros: CRI log line timestamps (06b)
    'src/time',
    // syscall.Errno strings on linux (zerrors_linux_amd64.go): ENOENT, EACCES (06b)
    'src/syscall',
    // strconv.Quote and CanBackquote: the %q and %#q of arguments in cobra's and kubectl's messages (07a)
    'src/strconv',
    // sort.SliceStable's insertion sort and symMerge: the order strategic merge patch gives list
    // items its comparison cannot place (apimachinery strategicpatch normalizeSliceOrder) (07b)
    'src/sort',
    // filepath.Glob, Match and Walk: how `kubectl create -f` and `apply -f` expand a pattern
    // that names no file, and the order they read a directory in (07b)
    'src/path/filepath',
  ],
};

// The programs of the official images the behavior models stand for (packages/host/src/models/
// images), each at the version the latest tag of its image ships (the image's NGINX_VERSION,
// HTTPD_VERSION, REDIS_VERSION in packages/k8s/src/runtime/images/catalog.data.ts). Their startup and
// shutdown log lines come from here.
export const NGINX_CHECKOUT: UpstreamCheckout = {
  name: 'nginx',
  repo: 'https://github.com/nginx/nginx',
  tag: 'release-1.31.8',
  paths: [
    // ngx_log_error's format, the startup notices (nginx.c, ngx_cycle.c), signals (ngx_process.c,
    // ngx_process_cycle.c), the epoll module's name (06b)
    'src/core',
    'src/event',
    'src/os/unix',
  ],
};

export const HTTPD_CHECKOUT: UpstreamCheckout = {
  name: 'httpd',
  repo: 'https://github.com/apache/httpd',
  tag: '2.4.71',
  paths: [
    // AH00558 (util.c ap_get_local_host), AH00094 and AH00489/AH00492 (mpm), the error log format
    // (log.c), the graceful-stop and shutdown paths of the event MPM (06b)
    'server',
    'include',
    // the signal handlers (unixd.c: SIGTERM, SIGINT and SIGWINCH set shutdown_pending) and the
    // PLATFORM name (os.h) in the server description (06b)
    'os/unix',
  ],
};

/** redis at the latest patch of each major (and minor of 7) the image catalog carries. */
function redisCheckout(tag: string): UpstreamCheckout {
  return {
    name: `redis-${tag}`,
    repo: 'https://github.com/redis/redis',
    tag,
    // server.c's startup and shutdown lines, serverLogRaw's line format (06b)
    paths: ['src'],
  };
}
export const REDIS_CHECKOUTS: readonly UpstreamCheckout[] = ['8.10.3', '7.4.12', '7.2.17', '6.2.24'].map(redisCheckout);

/** Every checkout, in fetch order: a checkout named by another's pinnedBy comes first. */
export const UPSTREAM_CHECKOUTS: readonly UpstreamCheckout[] = [
  KUBERNETES_CHECKOUT,
  CONTAINERD_CHECKOUT,
  RUNC_CHECKOUT,
  GO_CHECKOUT,
  NGINX_CHECKOUT,
  HTTPD_CHECKOUT,
  ...REDIS_CHECKOUTS,
];
