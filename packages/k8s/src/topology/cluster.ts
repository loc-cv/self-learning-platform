// Cluster topologies as data (docs/SCENARIO_FORMAT.md §5.1). A topology is a ClusterDef: which
// machines exist, which of them are kubeadm control-plane or worker nodes, their addresses and Pod
// CIDRs, and the cluster's network ranges. One builder (build.ts) turns any ClusterDef into a
// world; nothing in the engine branches on a topology's name.
//
// The values of `kubeadm-1cp-2w` were fixed for the oracle in phase 04 (docs/decisions.md D-033)
// and live here now; tools/src/oracle/topology.ts imports them, so a simulator run and a golden
// fixture describe the same cluster.

export interface ClusterNodeDef {
  /** Machine id, hostname and Node name. */
  name: string;
  /** The node's InternalIP. */
  ip: string;
  /** Allocated by kube-controller-manager's node-ipam controller in registration order. */
  podCIDR: string;
  controlPlane: boolean;
  /** /etc/machine-id (32 hex digits). */
  machineID: string;
  /** The DMI product UUID. */
  systemUUID: string;
  /** /proc/sys/kernel/random/boot_id. */
  bootID: string;
}

export interface ClusterDef {
  /** Topology name, as content names it: `kubeadm-1cp-2w`. */
  name: string;
  /** kubeadm ClusterConfiguration clusterName. */
  clusterName: string;
  /** kubeadm init --pod-network-cidr (kube-controller-manager --cluster-cidr). */
  podCIDR: string;
  /** kubeadm networking.serviceSubnet (kube-apiserver --service-cluster-ip-range). */
  serviceCIDR: string;
  /** kubeadm networking.dnsDomain. */
  dnsDomain: string;
  /** The control plane node first, then workers in join order. */
  nodes: ClusterNodeDef[];
  /**
   * Whether the control-plane taint was removed after init, as the kubeadm guide's "Control plane
   * node isolation" step does for a single-machine cluster.
   */
  untaintControlPlane: boolean;
  /** Where a learner's terminal opens. */
  entry: { machine: string; user: string };
}

/** The control plane node (kubeadm init ran there). */
export function controlPlaneNode(def: ClusterDef): ClusterNodeDef {
  const n = def.nodes.find((x) => x.controlPlane);
  if (!n) throw new Error(`topology ${def.name} has no control plane node`);
  return n;
}

/**
 * kubeadm defaults: ServiceSubnet 10.96.0.0/12, DNSDomain cluster.local
 * (cmd/kubeadm/app/apis/kubeadm/v1beta4/defaults.go), ClusterName kubernetes; the Pod network
 * 10.244.0.0/16 as the kubeadm and Flannel documentation use it for --pod-network-cidr.
 */
const KUBEADM_NETWORK = { clusterName: 'kubernetes', podCIDR: '10.244.0.0/16', serviceCIDR: '10.96.0.0/12', dnsDomain: 'cluster.local' } as const;

/** One control plane node and two workers; the terminal opens as root on the control plane. */
export const KUBEADM_1CP_2W: ClusterDef = {
  name: 'kubeadm-1cp-2w',
  ...KUBEADM_NETWORK,
  nodes: [
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
  ],
  untaintControlPlane: false,
  entry: { machine: 'controlplane', user: 'root' },
};

/** A single machine that is control plane and worker at once (the taint removed). */
export const KUBEADM_1N: ClusterDef = {
  name: 'kubeadm-1n',
  ...KUBEADM_NETWORK,
  nodes: [
    {
      name: 'controlplane', ip: '172.16.0.10', podCIDR: '10.244.0.0/24', controlPlane: true,
      machineID: '5b0d6c4ee0a94fa8b1c3e2d7f9a10c01', systemUUID: '4c4c4544-0000-1010-8010-b2c04f000001', bootID: '1f7c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b01',
    },
  ],
  untaintControlPlane: true,
  entry: { machine: 'controlplane', user: 'root' },
};

export const CLUSTERS: readonly ClusterDef[] = [KUBEADM_1CP_2W, KUBEADM_1N];
