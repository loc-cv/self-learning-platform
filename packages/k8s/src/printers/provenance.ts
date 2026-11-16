// Provenance of the `kubectl get` table output (docs/FIDELITY.md §3): one unit per kind's table
// (the server's Table conversion and kubectl's printing of it), the default convertor, the
// client-side decorations and the ages. A unit is golden-verified when tools/src/golden/tables.test.ts
// compares it with a committed capture in the gate.

import type { ProvenanceSpec } from '@simlab/kernel';

const PRINTERS = '.upstream/kubernetes/pkg/printers/internalversion/printers.go';
const TABLES_TEST = 'tools/src/golden/tables.test.ts';
const G = 'fixtures/golden/v1.37.2';

const kind = (resource: string, fn: string, fixtures: string[], note?: string): ProvenanceSpec => ({
  name: `kubectl.get.${resource}.table`,
  tag: fixtures.length > 0 ? 'golden-verified' : 'source-derived',
  sources: [`${PRINTERS} ${fn}`, ...fixtures.map((f) => `${G}/${f}`), ...(fixtures.length > 0 ? [TABLES_TEST] : [])],
  ...(note ? { note } : {}),
});

export const TABLE_PROVENANCE: ProvenanceSpec[] = [
  kind('pods', 'printPod', ['pods/run.yaml', 'deployments/create-and-read.yaml', 'namespaces/create-and-read.yaml', 'scheduling/cordoned.yaml'], 'Pod status cells of running Pods come from KWOK in the captures (FIDELITY §6.5); the layout and the Pending rows are rank 1.'),
  kind('deployments', 'printDeployment', ['deployments/create-and-read.yaml']),
  kind('replicasets', 'printReplicaSet', ['deployments/create-and-read.yaml']),
  kind('daemonsets', 'printDaemonSet', []),
  kind('services', 'printService', ['services/clusterip-and-nodeport.yaml']),
  kind('endpoints', 'printEndpoints', ['services/clusterip-and-nodeport.yaml']),
  kind('endpointslices', 'printEndpointSlice', ['services/clusterip-and-nodeport.yaml']),
  kind('nodes', 'printNode', ['nodes/read.yaml'], 'Node conditions are KWOK-authored in the capture; roles, version, addresses and node info are the topology.'),
  kind('namespaces', 'printNamespace', ['namespaces/create-and-read.yaml']),
  kind('configmaps', 'printConfigMap', ['configmaps/create-and-read.yaml']),
  kind('secrets', 'printSecret', []),
  kind('serviceaccounts', 'printServiceAccount', []),
  kind('events', 'printEvent', ['scheduling/cordoned.yaml']),
  kind('leases', 'printLease', []),
  kind('ipaddresses', 'printIPAddress', []),
  kind('servicecidrs', 'printServiceCIDR', []),
  kind('scale', 'printScale', []),
  {
    name: 'kubectl.get.default.table',
    tag: 'source-derived',
    sources: ['.upstream/kubernetes/staging/src/k8s.io/apiserver/pkg/registry/rest/table.go defaultTableConvertor', '.upstream/kubernetes/staging/src/k8s.io/cli-runtime/pkg/printers/tableprinter.go printObjectMeta'],
    note: 'Every served kind has its own printer; the default convertor serves kinds without one (CRDs later).',
  },
  {
    name: 'kubectl.get.table-printer',
    tag: 'golden-verified',
    sources: [
      '.upstream/kubernetes/staging/src/k8s.io/cli-runtime/pkg/printers/tableprinter.go HumanReadablePrinter.PrintObj, printTable, decorateTable',
      '.upstream/kubernetes/vendor/github.com/liggitt/tabwriter/tabwriter.go',
      `${G}/deployments/create-and-read.yaml`,
      `${G}/namespaces/create-and-read.yaml`,
      `${G}/pods/run.yaml`,
      TABLES_TEST,
    ],
    note: 'Header case and padding, wide columns, NAMESPACE (-A), LABELS (--show-labels), kind/name prefixes and blank lines between kinds (get all), --no-headers. -L and --output-watch-events are source-derived.',
  },
  {
    name: 'kubectl.get.age',
    tag: 'source-derived',
    sources: ['.upstream/kubernetes/staging/src/k8s.io/apimachinery/pkg/util/duration/duration.go HumanDuration, ShortHumanDuration', `${PRINTERS} translateTimestampSince`],
    note: 'Ages are tokens in the captures (FIDELITY §6.4); the values are checked against upstream duration_test.go and printers_test.go.',
  },
];
