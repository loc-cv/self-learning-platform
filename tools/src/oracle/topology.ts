// The fake cluster the oracle stands up: the `kubeadm-1cp-2w` topology's Node objects and network
// ranges, taken from the simulator's topology definition (docs/decisions.md D-033), so that a
// simulator run and a golden fixture describe the same cluster. KWOK registers these Nodes
// without a kubelet: no declaredFeatures, no runningInUserNamespace, and its own conditions
// (docs/FIDELITY.md §6.5); the simulated Node is compared with this one in
// tools/src/golden/topology.test.ts.
//
// Node objects are registered the way a kubelet registers itself (upstream:
// pkg/kubelet/kubelet_node_status.go initialNode: hostname, os and arch labels, the
// controller-managed-attach-detach annotation) and then marked by kubeadm (upstream:
// cmd/kubeadm/app/phases/markcontrolplane/markcontrolplane.go: control-plane label,
// exclude-from-external-load-balancers label, control-plane taint). The capacity, addresses and
// node info are this topology's choice, not a reference.

import { KUBEADM_1CP_2W, NODE_ALLOCATABLE, NODE_CAPACITY, NODE_INFO, controlPlaneNode, type ClusterNodeDef } from '@simlab/k8s';

const CP = controlPlaneNode(KUBEADM_1CP_2W);

/** The cluster's values, from the simulator's topology definition (packages/k8s/src/topology/cluster.ts). */
export const CLUSTER = {
  controlPlaneName: CP.name,
  /** kube-apiserver --advertise-address; the `kubernetes` Service's endpoint. */
  advertiseAddress: CP.ip,
  /** The port the simulated API server listens on (kubeadm's default). The oracle uses another. */
  apiserverPort: 6443,
  serviceCIDR: KUBEADM_1CP_2W.serviceCIDR,
  /** The first address of the service range, always the `kubernetes` Service's ClusterIP. */
  kubernetesServiceIP: '10.96.0.1',
  podCIDR: KUBEADM_1CP_2W.podCIDR,
  clusterName: KUBEADM_1CP_2W.clusterName,
} as const;

export type FakeNode = ClusterNodeDef;

export const NODES: readonly FakeNode[] = KUBEADM_1CP_2W.nodes;

const CAPACITY = NODE_CAPACITY;
const ALLOCATABLE = NODE_ALLOCATABLE;

export { NODE_INFO };

export function nodeManifest(n: FakeNode, kubeletVersion: string): object {
  const labels: Record<string, string> = {
    'beta.kubernetes.io/arch': 'amd64',
    'beta.kubernetes.io/os': 'linux',
    'kubernetes.io/arch': 'amd64',
    'kubernetes.io/hostname': n.name,
    'kubernetes.io/os': 'linux',
  };
  if (n.controlPlane) {
    labels['node-role.kubernetes.io/control-plane'] = '';
    labels['node.kubernetes.io/exclude-from-external-load-balancers'] = '';
  }
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
      name: n.name,
      labels,
      annotations: { 'volumes.kubernetes.io/controller-managed-attach-detach': 'true' },
    },
    spec: {
      podCIDR: n.podCIDR,
      podCIDRs: [n.podCIDR],
      ...(n.controlPlane ? { taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] } : {}),
    },
    status: {
      addresses: [
        { type: 'InternalIP', address: n.ip },
        { type: 'Hostname', address: n.name },
      ],
      capacity: CAPACITY,
      allocatable: ALLOCATABLE,
      daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
      nodeInfo: {
        ...NODE_INFO,
        bootID: n.bootID,
        kubeProxyVersion: '',
        kubeletVersion,
        machineID: n.machineID,
        systemUUID: n.systemUUID,
      },
    },
  };
}
