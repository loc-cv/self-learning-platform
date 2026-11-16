// Provenance of kubectl's YAML and JSON encoding and of its manifest decoding (docs/FIDELITY.md
// §3). Golden-verified units are compared byte for byte with committed captures in the gate by
// tools/src/golden/yaml.test.ts; the ports were also run against the vendored Go packages
// (yaml.v2, sigs.k8s.io/yaml, apimachinery util/yaml) on generated inputs during development.

import type { ProvenanceSpec } from '@simlab/kernel';

const V = '.upstream/kubernetes/vendor';
const S = '.upstream/kubernetes/staging/src/k8s.io';
const G = 'fixtures/golden/v1.37.2';
const TEST = 'tools/src/golden/yaml.test.ts';

export const YAML_JSON_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.output.yaml',
    tag: 'golden-verified',
    sources: [
      `${S}/cli-runtime/pkg/printers/yaml.go YAMLPrinter.PrintObj`,
      `${V}/sigs.k8s.io/yaml/yaml.go Marshal JSONToYAML`,
      `${V}/go.yaml.in/yaml/v2/encode.go`,
      `${V}/go.yaml.in/yaml/v2/emitterc.go`,
      `${V}/go.yaml.in/yaml/v2/sorter.go keyList.Less`,
      `${V}/go.yaml.in/yaml/v2/resolve.go resolve`,
      `${G}/client/yaml-output.yaml`,
      `${G}/client/yaml-input.yaml`,
      `${G}/configmaps/list-output.yaml`,
      TEST,
    ],
    note: 'Every other -o yaml output in the fixtures is also parsed and written again in the gate.',
  },
  {
    name: 'kubectl.output.json',
    tag: 'golden-verified',
    sources: [
      `${S}/cli-runtime/pkg/printers/json.go JSONPrinter.PrintObj`,
      'Go src/encoding/json encode.go appendString (escapeHTML), indent.go appendIndent',
      `${G}/client/yaml-output.yaml`,
      `${G}/client/yaml-input.yaml`,
      `${G}/configmaps/list-output.yaml`,
      TEST,
    ],
  },
  {
    name: 'kubectl.output.list-wrapper',
    tag: 'golden-verified',
    sources: [`${S}/kubectl/pkg/cmd/get/get.go GetOptions.Run (corev1.List, then an UnstructuredList with metadata.resourceVersion)`, `${G}/configmaps/list-output.yaml`],
    note: 'The wrapper is built by the get command; the printers only encode it.',
  },
  {
    name: 'kubectl.input.yaml',
    tag: 'golden-verified',
    sources: [
      `${V}/go.yaml.in/yaml/v2/readerc.go`,
      `${V}/go.yaml.in/yaml/v2/scannerc.go`,
      `${V}/go.yaml.in/yaml/v2/parserc.go`,
      `${V}/go.yaml.in/yaml/v2/decode.go`,
      `${V}/sigs.k8s.io/yaml/yaml.go YAMLToJSON Unmarshal convertToJSONableObject`,
      `${S}/apimachinery/pkg/util/yaml/decoder.go YAMLOrJSONDecoder YAMLReader`,
      `${G}/client/yaml-input.yaml`,
      TEST,
    ],
  },
  {
    name: 'kubectl.input.yaml-errors',
    tag: 'golden-verified',
    sources: [
      `${V}/go.yaml.in/yaml/v2/scannerc.go (problem strings)`,
      `${V}/go.yaml.in/yaml/v2/parserc.go (problem strings)`,
      `${V}/go.yaml.in/yaml/v2/decode.go parser.fail`,
      `${V}/sigs.k8s.io/yaml/yaml.go unmarshal ("error converting YAML to JSON: %w")`,
      `${S}/apimachinery/pkg/util/yaml/decoder.go JSONSyntaxError ("json: offset %d: %s"), YAMLReader ("invalid Yaml document separator: %s")`,
      `${S}/cli-runtime/pkg/resource/visitor.go StreamVisitor ("error parsing %s: %v")`,
      `${G}/client/yaml-input.yaml`,
      `${G}/configmaps/list-output.yaml`,
      TEST,
    ],
  },
];
