// Builds a cluster topology (a ClusterDef) into an empty world: the machines, the API server's
// store with the system namespaces, the Nodes and their Leases, kubeadm's files and kube-system
// objects (kubeadm.ts), then the components that run. The same code builds every topology;
// differences are data in the ClusterDef.
//
// What runs, and what is a stand-in until its phase (STATUS.md, temporary shortcuts): the API
// server is bootstrapped by the builder and recorded as serving (phase 27 starts it from its static
// Pod); kube-controller-manager and kube-scheduler are started directly (phase 27); the control
// plane's mirror Pods and the DaemonSet's Pods are created with containers already running in the
// node's runtime (phases 27 and 18a); each node's kubelet is started directly (phase 26a ties it to
// kubelet.service) and takes over the Node's status, its Lease and every Pod bound to the node.

import { put, type Ctx, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { buildUbuntuBase, createMachine } from '@simlab/host';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { bootstrapApiServer } from '../apiserver/bootstrap.ts';
import { k8sSlice } from '../apiserver/store.ts';
import { startControllerManager } from '../controllers/manager.ts';
import { startScheduler } from '../scheduler/scheduler.ts';
import { startKubelet } from '../kubelet/kubelet.ts';
import { CLUSTERS, controlPlaneNode, type ClusterDef } from './cluster.ts';
import { installKubeadmFiles, seedKubeSystem } from './kubeadm.ts';
import { registerNode } from './nodes.ts';

/**
 * The login user of every node: Ubuntu's cloud images create `ubuntu` (cloud-init's default_user
 * on Ubuntu), the account a kubeadm lab machine has besides root.
 */
export const NODE_USER = 'ubuntu';

/** kubeadm's API server, as its static Pod manifest configures it for this cluster. */
export function apiServerConfig(def: ClusterDef): ApiServerConfig {
  const cp = controlPlaneNode(def);
  return {
    etcd: `${cp.name}:/var/lib/etcd`,
    serviceClusterIPRange: def.serviceCIDR,
    serviceNodePortRange: [30000, 32767],
    advertiseAddress: cp.ip,
    securePort: 6443,
  };
}

/** Builds `def` into the world and returns where the terminal opens. */
export function buildCluster(ctx: Ctx, def: ClusterDef): TopologyInfo {
  for (const n of def.nodes) {
    createMachine(ctx, { id: n.name, hostname: n.name, kind: 'node', addresses: [n.ip] });
    buildUbuntuBase(ctx, n.name, { user: { name: NODE_USER } });
  }
  const server = apiServerConfig(def);
  installKubeadmFiles(ctx, def);
  bootstrapApiServer(ctx, server);
  put(k8sSlice(ctx).apiServers, `${server.advertiseAddress}:${server.securePort}`, server);
  const nodeUIDs: Record<string, string> = {};
  for (const n of def.nodes) {
    const node = registerNode(ctx, server, n, { taint: n.controlPlane && !def.untaintControlPlane });
    nodeUIDs[n.name] = String((node.metadata as { uid?: string }).uid ?? '');
  }
  seedKubeSystem(ctx, def, server, nodeUIDs);
  const cp = controlPlaneNode(def);
  startControllerManager(ctx, server);
  startScheduler(ctx, server, { host: cp.name });
  for (const n of def.nodes) startKubelet(ctx, server, { name: n.name, ip: n.ip, podCIDR: n.podCIDR });
  return { entry: { ...def.entry }, machines: def.nodes.map((n) => n.name) };
}

export function clusterTopology(def: ClusterDef): TopologySpec {
  return {
    name: def.name,
    params: { type: 'object', properties: {}, additionalProperties: false },
    build: (ctx) => buildCluster(ctx, def),
  };
}

/** The topologies the k8s plugin registers. */
export const TOPOLOGIES: readonly TopologySpec[] = CLUSTERS.map(clusterTopology);
