// Provenance of the API server's warnings (docs/FIDELITY.md §3), the `Warning` headers kubectl
// prints as `Warning: …`, golden-verified by tools/src/golden/api.test.ts against
// fixtures/golden/v1.37.2/api/warnings.yaml; and of the create refusal of a resourceVersion.

import type { ProvenanceSpec } from '@simlab/kernel';

const FIXTURE = 'fixtures/golden/v1.37.2/api/warnings.yaml';
const TEST = 'tools/src/golden/api.test.ts';

export const APISERVER_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'apiserver.warnings.pod',
    tag: 'golden-verified',
    sources: ['.upstream/kubernetes/pkg/api/pod/warnings.go warningsForPodSpecAndMeta', '.upstream/kubernetes/pkg/api/node/util.go', FIXTURE, TEST],
    note: 'Pods, and the pod templates of Deployments, ReplicaSets and DaemonSets (packages/k8s/src/apis/core/validation/podwarnings.ts).',
  },
  {
    name: 'apiserver.warnings.service',
    tag: 'golden-verified',
    sources: ['.upstream/kubernetes/pkg/api/service/warnings.go GetWarningsForService', FIXTURE, TEST],
  },
  {
    name: 'apiserver.warnings.recorder',
    tag: 'golden-verified',
    sources: ['.upstream/kubernetes/staging/src/k8s.io/apiserver/pkg/endpoints/filters/warning.go recorder.AddWarning', FIXTURE, TEST],
    note: 'Dedupe is golden-verified; truncation past 4096 runes is source-derived (packages/k8s/src/apiserver/warning.test.ts).',
  },
  {
    name: 'apiserver.create.resource-version-set',
    tag: 'golden-verified',
    sources: [
      '.upstream/kubernetes/staging/src/k8s.io/apiserver/pkg/storage/etcd3/store.go Create',
      '.upstream/kubernetes/staging/src/k8s.io/apiserver/pkg/storage/errors.go ErrResourceVersionSetOnCreate',
      'fixtures/golden/v1.37.2/api/create-resource-version.yaml',
      TEST,
    ],
    note: 'The 500 Status of a create that carries a resourceVersion (packages/k8s/src/apiserver/pipeline.ts createOnce). kubectl create -f and apply -f clear the field first (fixtures/golden/v1.37.2/create/resource-version.yaml).',
  },
];
