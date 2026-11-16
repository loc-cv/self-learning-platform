// Provenance of the output units of version, api-resources, api-versions and cluster-info
// (docs/FIDELITY.md §3).

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const CMD = 'staging/src/k8s.io/kubectl/pkg/cmd';

export const INFO_UNITS: ProvenanceSpec[] = [
  {
    name: 'kubectl.version.output',
    tag: 'golden-verified',
    sources: [`${G}/info/version.yaml`, `${G}/info/no-server.yaml`, `${G}/client/no-server.yaml`, `${CMD}/version/version.go Run`],
    note: 'text, -o yaml and -o json; the client and server version.Info are the real binaries\' (buildDate is normalized in the fixtures, its value read from the binaries)',
  },
  {
    name: 'kubectl.version.errors',
    tag: 'golden-verified',
    sources: [`${G}/info/no-server.yaml`, `${CMD}/version/version.go Validate`],
  },
  {
    name: 'kubectl.version.skew-warning',
    tag: 'source-derived',
    sources: [`${CMD}/version/skew_warning.go getVersionSkewWarning`],
    note: 'never printed against the simulated server, whose version is the pin; unit-tested',
  },
  {
    name: 'kubectl.api-resources.output',
    tag: 'golden-verified',
    sources: [`${G}/info/api-resources.yaml`, `${G}/api/discovery.yaml`, `${CMD}/apiresources/apiresources.go RunAPIResources`, `${CMD}/apiresources/print_flags.go`],
    note: 'table, wide, name, json, yaml; filters and sorting',
  },
  {
    name: 'kubectl.api-resources.errors',
    tag: 'golden-verified',
    sources: [`${G}/info/api-resources.yaml`, `${G}/info/no-server.yaml`, `${CMD}/apiresources/apiresources.go Complete, Validate`],
  },
  {
    name: 'kubectl.api-versions.output',
    tag: 'golden-verified',
    sources: [`${G}/info/api-resources.yaml`, `${G}/info/no-server.yaml`, `${CMD}/apiresources/apiversions.go RunAPIVersions`],
  },
  {
    name: 'kubectl.cluster-info.output',
    tag: 'golden-verified',
    sources: [`${G}/info/cluster-info.yaml`, `${G}/info/no-server.yaml`, `${G}/client/no-server.yaml`, `${CMD}/clusterinfo/clusterinfo.go Run, printService`],
    note: 'LoadBalancer ingress links (http://<ip>:<port> per port) are source-derived: no case gives a Service an ingress',
  },
  {
    name: 'apiserver.nonresource.discovery',
    tag: 'source-derived',
    sources: [`${G}/api/discovery.yaml`, `${G}/info/version.yaml`, 'staging/src/k8s.io/apiserver/pkg/endpoints/discovery'],
    note: 'GET /version, /api, /apis, /api/v1, /apis/<g>/<v>; equal to the fixtures in packages/k8s/src/apiserver/nonresource.test.ts',
  },
];
