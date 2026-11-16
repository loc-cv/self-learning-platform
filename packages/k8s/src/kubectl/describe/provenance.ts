// Provenance of kubectl describe's output units (docs/FIDELITY.md §3). The differential runner
// (tools/src/golden/kubectl/, in the gate) compares every describe step of the golden cases with
// the simulator's output; what KWOK cannot show (a kubelet's container IDs, states, conditions and
// events, D-046's admission fields) is masked there and stays source-derived in the notes.

import type { ProvenanceSpec } from '@simlab/kernel';

const G = 'fixtures/golden/v1.37.2';
const DESCRIBE = 'staging/src/k8s.io/kubectl/pkg/describe/describe.go';

export const DESCRIBE_PROVENANCE: ProvenanceSpec[] = [
  {
    name: 'kubectl.describe.pod',
    tag: 'golden-verified',
    sources: [
      `${G}/describe/pod-spec.yaml`,
      `${G}/describe/selection.yaml`,
      `${G}/pods/manifest.yaml`,
      `${G}/pods/run.yaml`,
      `${G}/scheduling/failures.yaml`,
      `${DESCRIBE} describePod, describeContainers, describeStatus, describeVolumes, DescribeProbe, describeContainerEnvVars, describeContainerEnvFrom`,
      'staging/src/k8s.io/kubectl/pkg/util/resource/resource.go ExtractContainerResourceValue',
    ],
    note: 'Pending Pods and the layout of Running ones are compared with the oracle; what a kubelet writes (container and image IDs, Running/Waiting/Terminated states, Last State, restart counts, PodReadyToStartContainers) and the Terminating status line are source-derived (packages/k8s/transcripts/kubectl/describe/)',
  },
  {
    name: 'kubectl.describe.deployment',
    tag: 'golden-verified',
    sources: [
      `${G}/describe/deployment.yaml`,
      `${G}/deployments/create-and-read.yaml`,
      `${G}/deployments/rollout.yaml`,
      `${DESCRIBE} describeDeployment, DescribePodTemplate, printReplicaSetsByLabels`,
      'staging/src/k8s.io/kubectl/pkg/util/deployment/deployment.go GetAllReplicaSetsInChunks',
    ],
  },
  {
    name: 'kubectl.describe.service',
    tag: 'golden-verified',
    sources: [`${G}/describe/service.yaml`, `${G}/services/clusterip-and-nodeport.yaml`, `${DESCRIBE} describeService, formatEndpointSlices, buildIngressString`],
    note: 'LoadBalancer Ingress (no load-balancer controller is simulated) is source-derived',
  },
  {
    name: 'kubectl.describe.node',
    tag: 'golden-verified',
    sources: [
      `${G}/describe/node.yaml`,
      `${G}/nodes/read.yaml`,
      `${G}/scheduling/extended-resources.yaml`,
      `${DESCRIBE} describeNode, describeNodeLease, describeNodeResource, findNodeRoles`,
      'staging/src/k8s.io/component-helpers/resource/helpers.go PodRequests, PodLimits',
    ],
    note: "the kubelet's Node conditions and Lease holder are source-derived (KWOK writes its own, FIDELITY §6.5)",
  },
  {
    name: 'kubectl.describe.events',
    tag: 'golden-verified',
    sources: [`${G}/describe/deployment.yaml`, `${G}/describe/node.yaml`, `${G}/scheduling/failures.yaml`, `${DESCRIBE} DescribeEvents, translateMicroTimestampSince`, 'staging/src/k8s.io/kubectl/pkg/util/event/sorted_event_list.go'],
    note: 'the aggregated form `<age> (xN over <age>)` and the fieldPath prefix of kubelet events are source-derived: the oracle has no kubelet and its captures aggregate nothing (FIDELITY §6.9)',
  },
  {
    name: 'kubectl.describe.errors',
    tag: 'golden-verified',
    sources: [
      `${G}/describe/selection.yaml`,
      `${G}/errors/not-found.yaml`,
      'staging/src/k8s.io/kubectl/pkg/cmd/describe/describe.go ToOptions, Run, DescribeMatchingResources',
      'staging/src/k8s.io/cli-runtime/pkg/resource/builder.go visitorResult',
    ],
    note: 'missing type, no match ("No resources found"), not found, prefix matching, selector and argument errors',
  },
];
