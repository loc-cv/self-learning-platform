// The fake cluster the oracle stands up: the `kubeadm-1cp-2w` topology's Node objects and network
// ranges. Phase 06a builds the simulated topology to match these values (docs/decisions.md D-033),
// so that a simulator run and a golden fixture describe the same cluster.
//
// Node objects are registered the way a kubelet registers itself (upstream:
// pkg/kubelet/kubelet_node_status.go initialNode: hostname, os and arch labels, the
// controller-managed-attach-detach annotation) and then marked by kubeadm (upstream:
// cmd/kubeadm/app/phases/markcontrolplane/markcontrolplane.go: control-plane label,
// exclude-from-external-load-balancers label, control-plane taint). The capacity, addresses and
// node info are this topology's choice, not a reference.

export const CLUSTER = {
  controlPlaneName: 'controlplane',
  /** kube-apiserver --advertise-address; the `kubernetes` Service's endpoint. */
  advertiseAddress: '172.16.0.10',
  /** The port the simulated API server listens on (kubeadm's default). The oracle uses another. */
  apiserverPort: 6443,
  /** kubeadm defaults: ServiceSubnet 10.96.0.0/12 (cmd/kubeadm/app/apis/kubeadm/v1beta4/defaults.go). */
  serviceCIDR: '10.96.0.0/12',
  /** The first address of the service range, always the `kubernetes` Service's ClusterIP. */
  kubernetesServiceIP: '10.96.0.1',
  /** kubeadm init --pod-network-cidr, as the Flannel and kubeadm docs use it. */
  podCIDR: '10.244.0.0/16',
  clusterName: 'kubernetes',
} as const;

export interface FakeNode {
  name: string;
  ip: string;
  podCIDR: string;
  controlPlane: boolean;
  machineID: string;
  systemUUID: string;
  bootID: string;
}

export const NODES: readonly FakeNode[] = [
  {
    name: 'controlplane', ip: '172.16.0.10', podCIDR: '10.244.0.0/24', controlPlane: true,
    machineID: '5b0d6c4ee0a94fa8b1c3e2d7f9a10c01', systemUUID: '4c4c4544-0000-1010-8010-b2c04f000001', bootID: '1f7c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b01',
  },
  {
    name: 'node01', ip: '172.16.0.11', podCIDR: '10.244.1.0/24', controlPlane: false,
    machineID: '5b0d6c4ee0a94fa8b1c3e2d7f9a10c02', systemUUID: '4c4c4544-0000-1010-8010-b2c04f000002', bootID: '1f7c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b02',
  },
  {
    name: 'node02', ip: '172.16.0.12', podCIDR: '10.244.2.0/24', controlPlane: false,
    machineID: '5b0d6c4ee0a94fa8b1c3e2d7f9a10c03', systemUUID: '4c4c4544-0000-1010-8010-b2c04f000003', bootID: '1f7c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b03',
  },
];

/** Same machine for every node: 2 CPUs, 4 GiB, a 20 GiB root disk. */
const CAPACITY = { cpu: '2', 'ephemeral-storage': '20134592Ki', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: '4010284Ki', pods: '110' };
// kubelet defaults: evictionHard memory.available<100Mi, nodefs.available<10% (no reservations).
const ALLOCATABLE = { cpu: '2', 'ephemeral-storage': '18556039957', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: '3907884Ki', pods: '110' };

/** Software the nodes report; the simulated nodes report the same. */
export const NODE_INFO = {
  architecture: 'amd64',
  containerRuntimeVersion: 'containerd://1.7.28',
  kernelVersion: '6.8.0-88-generic',
  operatingSystem: 'linux',
  osImage: 'Ubuntu 24.04.3 LTS',
} as const;

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
