// Provenance of the output units of kubectl config (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const CMD = 'staging/src/k8s.io/kubectl/pkg/cmd/config';
const CLIENTCMD = 'staging/src/k8s.io/client-go/tools/clientcmd';

export const CONFIG_UNITS: ProvenanceSpec[] = [
  {
    name: 'kubectl.config.view.output',
    tag: 'golden-verified',
    sources: [`${G}/config/view.yaml`, `${G}/client/config.yaml`, `${CMD}/view.go Run`, `${CLIENTCMD}/api/helpers.go MinifyConfig, FlattenConfig, RedactSecrets, ShortenConfig`],
    note: 'YAML, JSON and name output; redaction, --raw, --minify, --flatten, --merge, the KUBECONFIG list merged',
  },
  {
    name: 'kubectl.config.view.errors',
    tag: 'golden-verified',
    sources: [`${G}/config/view.yaml`, `${CMD}/view.go Complete, Validate`, `${CLIENTCMD}/loader.go Load, LoadFromFile`],
  },
  ...(
    [
      ['get-contexts', 'get_contexts.go RunGetContexts', 'the table (CURRENT, NAME, CLUSTER, AUTHINFO, NAMESPACE), -o name, --no-headers, the errors'],
      ['current-context', 'current_context.go RunCurrentContext', 'the name, "current-context is not set"'],
      ['use-context', 'use_context.go run, validate', '"Switched to context", the help and errors'],
      ['set-context', 'set_context.go run, modifyContext, validate', '"Context … modified." / "created.", the help and errors'],
      ['delete-context', 'delete_context.go runDeleteContext', '"deleted context … from <file>", the warning, the errors'],
      ['get-clusters', 'get_clusters.go runGetClusters', 'NAME and the names'],
      ['get-users', 'get_users.go', 'NAME and the names, sorted'],
    ] as const
  ).map(
    ([verb, source, note]): ProvenanceSpec => ({
      name: `kubectl.config.${verb}.output`,
      tag: 'golden-verified',
      sources: [`${G}/config/contexts.yaml`, `${G}/client/config.yaml`, `${CMD}/${source}`],
      note,
    }),
  ),
  {
    name: 'kubectl.config.kubeconfig-file',
    tag: 'golden-verified',
    sources: [`${G}/config/contexts.yaml`, `${CLIENTCMD}/config.go ModifyConfig, writeCurrentContext`, `${CLIENTCMD}/loader.go WriteToFile, lockFile`, `${CLIENTCMD}/api/v1/conversion.go`],
    note: 'the file ModifyConfig writes (default file, KUBECONFIG list, --kubeconfig), its serialization, its mode, the lock file error',
  },
  {
    name: 'kubectl.config.decode-errors',
    tag: 'golden-verified',
    sources: [
      `${G}/config/broken-kubeconfig.yaml`,
      `${G}/config/view.yaml`,
      `${CLIENTCMD}/api/latest/latest.go`,
      `${CLIENTCMD}/api/v1/conversion.go Convert_Slice_v1_NamedCluster_To_Map_string_To_Pointer_api_Cluster`,
      `${CLIENTCMD}/loader.go LoadFromFile`,
      'staging/src/k8s.io/apimachinery/pkg/runtime/serializer/json/meta.go SimpleMetaFactory.Interpret',
      'Go src/encoding/json decode.go UnmarshalTypeError',
    ],
    note: 'what every verb prints for a kubeconfig it cannot load (one decoder, client/kubeconfigmodel.ts): type errors, a wrong apiVersion or kind, a repeated name (Go %v of the list), YAML syntax errors, read errors such as ENOTDIR',
  },
];
