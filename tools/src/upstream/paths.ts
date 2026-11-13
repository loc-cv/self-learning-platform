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
  // admission plugins, RBAC authorizer and bootstrap policy (20a, 20b)
  'plugin/pkg',
  // Pod Security admission checks and messages (20b)
  'staging/src/k8s.io/pod-security-admission',
  // shared helpers used by kubectl and controllers: tolerations, node affinity, resource math
  'staging/src/k8s.io/component-helpers',
  // CRD types, structural schema validation (20c)
  'staging/src/k8s.io/apiextensions-apiserver/pkg/apis',
  'staging/src/k8s.io/apiextensions-apiserver/pkg/apiserver',
  // kubeadm (27–29c)
  'cmd/kubeadm',
  // component flags: kube-apiserver, kube-controller-manager, kube-scheduler, kubelet (27)
  'cmd/kube-apiserver',
  'cmd/kube-controller-manager',
  'cmd/kube-scheduler',
  'cmd/kubelet',
];
