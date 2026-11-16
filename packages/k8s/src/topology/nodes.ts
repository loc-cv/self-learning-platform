// The Node object of each cluster node and its Lease, as a healthy kubeadm v1.37.2 node has them
// a few minutes after joining. Until the kubelet exists (phase 06b) they are written once at build
// time; the conditions, heartbeat times and Lease renewals do not move (STATUS.md, temporary
// shortcuts).
//
// Who writes what in a real cluster (traced from source, v1.37.2):
// - kubelet initialNode (pkg/kubelet/kubelet_node_status.go): name, the five os/arch/hostname
//   labels, the controller-managed-attach-detach annotation, and the status setters in
//   defaultNodeStatusFuncs order: addresses (nodestatus.NodeAddress), capacity and allocatable
//   (MachineInfo: capacity minus the default evictionHard memory.available<100Mi and
//   nodefs.available<10%, no reservations with kubeadm's KubeletConfiguration), nodeInfo
//   (VersionInfo, GoRuntime, runningInUserNamespace with KubeletInUserNamespace on), daemonEndpoints,
//   declaredFeatures (discoverNodeDeclaredFeatures with default gates: four features, sorted),
//   then the conditions MemoryPressure, DiskPressure, PIDPressure, Ready, Ready last on purpose
//   (pkg/kubelet/nodestatus/setters.go). containerd 1.7 reports no runtime handlers or features.
// - kubeadm markcontrolplane (cmd/kubeadm/app/phases/markcontrolplane): the control-plane and
//   exclude-from-external-load-balancers labels and the control-plane taint.
// - kube-controller-manager: podCIDR(s) (node-ipam range allocator, in registration order) and
//   the node.alpha.kubernetes.io/ttl annotation (ttl controller: "0" below 100 nodes).
// - No NetworkUnavailable condition: no cloud route controller, and the simulated clusters have no
//   CNI agent yet (phase 29a).
// The Lease (kube-node-lease/<node>): holderIdentity the node name, leaseDurationSeconds 40, an
// owner reference to the Node (pkg/kubelet/nodelease, component-helpers/apimachinery/lease).
// Values that are the topology's choice (capacity, IDs, versions) are D-033's.

import type { Ctx } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { microTimeOf, timeOf } from '../apimachinery/time.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { createClient } from '../client/client.ts';
import { KUBERNETES_TAG } from '../version.ts';
import type { ClusterNodeDef } from './cluster.ts';

/** Same machine for every node: 2 CPUs, 4 GiB, a 20 GiB root disk (D-033). */
export const NODE_CAPACITY = { cpu: '2', 'ephemeral-storage': '20134592Ki', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: '4010284Ki', pods: '110' } as const;
/** Capacity minus evictionHard memory.available 100Mi and nodefs.available 10% (float32 arithmetic). */
export const NODE_ALLOCATABLE = { cpu: '2', 'ephemeral-storage': '18556039957', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: '3907884Ki', pods: '110' } as const;

/** Software the nodes report (D-033). */
export const NODE_INFO = {
  architecture: 'amd64',
  containerRuntimeVersion: 'containerd://1.7.28',
  kernelVersion: '6.8.0-88-generic',
  operatingSystem: 'linux',
  osImage: 'Ubuntu 24.04.3 LTS',
} as const;

/** discoverNodeDeclaredFeatures with v1.37.2's default gates and containerd 1.7 (no runtime features). */
export const DECLARED_FEATURES = ['ExtendWebSocketsToKubelet', 'InPlacePodLevelResourcesVerticalScaling', 'InPlacePodVerticalScalingInitContainers', 'RestartAllContainersOnContainerExits'] as const;

/** kubelet's default --port. */
export const KUBELET_PORT = 10250;

export const CONTROL_PLANE_TAINT = { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' } as const;

export function nodeLabels(n: ClusterNodeDef): Record<string, string> {
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
  return labels;
}

function condition(type: string, status: string, reason: string, message: string, now: string): JsonObject {
  return { type, status, lastHeartbeatTime: now, lastTransitionTime: now, reason, message };
}

/** The Node as stored once the kubelet, kubeadm and the controller manager have done their part. */
export function nodeObject(n: ClusterNodeDef, opts: { taint: boolean; now: string }): JsonObject {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
      name: n.name,
      labels: nodeLabels(n),
      annotations: { 'node.alpha.kubernetes.io/ttl': '0', 'volumes.kubernetes.io/controller-managed-attach-detach': 'true' },
    },
    spec: {
      podCIDR: n.podCIDR,
      podCIDRs: [n.podCIDR],
      ...(opts.taint ? { taints: [{ ...CONTROL_PLANE_TAINT }] } : {}),
    },
    status: {
      capacity: { ...NODE_CAPACITY },
      allocatable: { ...NODE_ALLOCATABLE },
      conditions: [
        condition('MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available', opts.now),
        condition('DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure', opts.now),
        condition('PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available', opts.now),
        condition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status', opts.now),
      ],
      addresses: [
        { type: 'InternalIP', address: n.ip },
        { type: 'Hostname', address: n.name },
      ],
      daemonEndpoints: { kubeletEndpoint: { Port: KUBELET_PORT } },
      nodeInfo: {
        machineID: n.machineID,
        systemUUID: n.systemUUID,
        bootID: n.bootID,
        kernelVersion: NODE_INFO.kernelVersion,
        osImage: NODE_INFO.osImage,
        containerRuntimeVersion: NODE_INFO.containerRuntimeVersion,
        kubeletVersion: KUBERNETES_TAG,
        kubeProxyVersion: '',
        operatingSystem: NODE_INFO.operatingSystem,
        architecture: NODE_INFO.architecture,
        runningInUserNamespace: false,
      },
      declaredFeatures: [...DECLARED_FEATURES],
    },
  };
}

/** Registers a node: its Node object and its Lease, through the API server. */
export function registerNode(ctx: Ctx, server: ApiServerConfig, n: ClusterNodeDef, opts: { taint: boolean }): JsonObject {
  const user = { username: `system:node:${n.name}`, groups: ['system:nodes', 'system:authenticated'] };
  const client = createClient(ctx, server, user);
  const now = timeOf(ctx.now);
  const r = client.resource('v1/nodes').create(undefined, nodeObject(n, { taint: opts.taint, now }));
  if (!r.ok) throw new Error(`registering node ${n.name}: ${JSON.stringify(r)}`);
  const node = r.object as JsonObject;
  const meta = node.metadata as JsonObject;
  const lease = client.resource('coordination.k8s.io/v1/leases').create('kube-node-lease', {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: { name: n.name, namespace: 'kube-node-lease', ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: n.name, uid: meta.uid as string }] },
    spec: { holderIdentity: n.name, leaseDurationSeconds: 40, renewTime: microTimeOf(ctx.now) },
  });
  if (!lease.ok) throw new Error(`node lease ${n.name}: ${JSON.stringify(lease)}`);
  return node;
}
