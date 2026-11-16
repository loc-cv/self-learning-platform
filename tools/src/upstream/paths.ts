// What `npm run upstream:fetch` checks out of kubernetes/kubernetes at the pinned tag.
// Cone-mode sparse-checkout directories; each line says which phases read it. Add a directory
// here when a phase needs one that is missing, and rerun the fetch (it is incremental).

export const UPSTREAM_REPO = 'https://github.com/kubernetes/kubernetes';

export const UPSTREAM_SPARSE_PATHS: readonly string[] = [
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
];
