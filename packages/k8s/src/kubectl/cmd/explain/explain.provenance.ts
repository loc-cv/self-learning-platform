// Provenance of kubectl explain's output units (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2/explain';
const EXPLAIN = 'staging/src/k8s.io/kubectl/pkg/cmd/explain/explain.go';
const V2 = 'staging/src/k8s.io/kubectl/pkg/explain/v2';

export const EXPLAIN_OUTPUT_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.explain.output',
    tag: 'golden-verified',
    sources: [`${G}/resources.yaml`, `${G}/recursive.yaml`, `${G}/api-version.yaml`, `${V2}/templates/plaintext.tmpl`, `${V2}/funcs.go`],
    note: 'GROUP/KIND/VERSION header, FIELD line, DESCRIPTION, FIELDS with types, enums, -required-; --recursive and --max-depth; text from the OpenAPI v3 documents the real server serves (npm run openapi:capture)',
  },
  {
    name: 'kubectl.explain.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/errors.yaml`,
      `${G}/api-version.yaml`,
      `${G}/no-server.yaml`,
      `${EXPLAIN} Validate, Run`,
      'staging/src/k8s.io/kubectl/pkg/explain/explain.go SplitAndParseResourceRequest, SplitAndParseResourceRequestWithMatchingPrefix',
      `${V2}/explain.go printModelDescriptionWithGenerator`,
      `${V2}/generator.go Render`,
      'staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go ParseGroupVersion',
      'staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go checkErr (NoResourceMatchError)',
    ],
    note: 'missing or extra arguments, --max-depth, unknown resource type and field, group versions that do not serve the type or are not served, unrecognized format, jsonpath errors; "invalid multiple recursive descent" is source-derived (client-go/util/jsonpath/parser.go parseRecursive)',
  },
];
