// Provenance of strategic merge patch (docs/FIDELITY.md §3): the API server's application of a
// patch with its errors, and the patches kubectl apply computes. The server side is compared with
// the real kube-apiserver by tools/src/golden/api.test.ts; the algorithm runs upstream's own test
// tables (patch.upstream.test.ts).

import type { ProvenanceSpec } from '@simlab/kernel';

const S = '.upstream/kubernetes/staging/src/k8s.io';
const FIXTURE = 'fixtures/golden/v1.37.2/api/strategic-patch.yaml';

export const STRATEGIC_PATCH_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'apiserver.patch.strategic',
    tag: 'golden-verified',
    sources: [
      `${S}/apiserver/pkg/endpoints/handlers/patch.go smpPatcher strategicPatchObject applyPatchToObject interpretStrategicMergePatchError`,
      `${S}/apimachinery/pkg/util/strategicpatch/patch.go StrategicMergeMapPatch`,
      `${S}/apimachinery/pkg/util/mergepatch/errors.go`,
      `${S}/apimachinery/pkg/runtime/converter.go FromUnstructuredWithValidation`,
      `${S}/apiserver/pkg/endpoints/handlers/responsewriters/status.go ErrorToAPIStatus`,
      FIXTURE,
      'tools/src/golden/api.test.ts',
    ],
    note: 'Merged objects, Status bodies (400, 422, the reason-less 500 of plain errors) and unknown-field warnings; the algorithm also passes patch_test.go tables (packages/k8s/src/apimachinery/strategicpatch/patch.upstream.test.ts).',
  },
  {
    name: 'kubectl.apply.patch',
    tag: 'source-derived',
    sources: [
      `${S}/apimachinery/pkg/util/strategicpatch/patch.go CreateThreeWayMergePatch CreateTwoWayMergePatch`,
      `${S}/apimachinery/pkg/util/strategicpatch/patch_test.go`,
      `${S}/apimachinery/pkg/util/mergepatch/errors.go NewErrConflict`,
      'packages/k8s/src/apimachinery/strategicpatch/patch.upstream.test.ts',
    ],
    note: 'The patch body kubectl apply sends and the conflict error of --overwrite=false. Patch meta from the Go struct tags; kubectl reads the same strategies from OpenAPI v3, whose lookup errors read differently.',
  },
];
