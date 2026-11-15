// The configuration of one kube-apiserver: what its flags select. Phase 27 parses these from the
// static Pod manifest; until then callers pass a config, and DEFAULT_APISERVER is what kubeadm
// sets up.

export interface ApiServerConfig {
  /** The etcd data directory this server's --etcd-servers reaches (store id in the k8s slice). */
  etcd: string;
  /** --service-cluster-ip-range. kubeadm: networking.serviceSubnet, default 10.96.0.0/12. */
  serviceClusterIPRange: string;
  /** --service-node-port-range. Default 30000-32767. */
  serviceNodePortRange: [number, number];
  /** --advertise-address: the endpoint of the `kubernetes` Service. */
  advertiseAddress: string;
  /** --secure-port: the targetPort of the `kubernetes` Service. kubeadm: 6443. */
  securePort: number;
}

/**
 * upstream: cmd/kubeadm/app/apis/kubeadm/v1beta4/defaults.go DefaultServicesSubnet;
 * pkg/kubeapiserver/options DefaultServiceNodePortRange (30000-32767, kube-apiserver --help).
 * The etcd id names kubeadm's data directory on the control plane node.
 */
export const DEFAULT_APISERVER: ApiServerConfig = {
  etcd: 'controlplane:/var/lib/etcd',
  serviceClusterIPRange: '10.96.0.0/12',
  serviceNodePortRange: [30000, 32767],
  // The control plane node of kubeadm-1cp-2w (D-033; tools/src/oracle/topology.ts CLUSTER).
  advertiseAddress: '172.16.0.10',
  securePort: 6443,
};
