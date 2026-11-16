// Kubernetes domain plugin: API machinery, controllers, scheduler, kubelet, network, kubectl, kubeadm.
// Specified in docs/ARCHITECTURE.md §4.

export const packageName = '@simlab/k8s';

export { KUBERNETES_MINOR, KUBERNETES_TAG, KUBERNETES_VERSION } from './version.ts';
export { k8sPlugin, K8S_SLICE_VERSION } from './plugin.ts';
export { DEFAULT_APISERVER, type ApiServerConfig } from './apiserver/config.ts';
export { handle, openWatch, watchEvents } from './apiserver/pipeline.ts';
export { bootstrapApiServer, SYSTEM_NAMESPACES } from './apiserver/bootstrap.ts';
export type { ApiRequest, ApiResponse, RequestOptions, Strategy, StrategyCtx } from './apiserver/types.ts';
export { createClient, gvr, type Client, type ResourceClient } from './client/client.ts';
export { registry, type ApiResource } from './discovery/registry.ts';
export { schema } from './openapi/schema.ts';
export { CLUSTERS, KUBEADM_1CP_2W, KUBEADM_1N, controlPlaneNode, type ClusterDef, type ClusterNodeDef } from './topology/cluster.ts';
export { NODE_ALLOCATABLE, NODE_CAPACITY, NODE_INFO, nodeLabels, nodeObject } from './topology/nodes.ts';
export { apiServerConfig, buildCluster, TOPOLOGIES } from './topology/build.ts';
export { isSchedulerRunning, startScheduler, stopScheduler } from './scheduler/scheduler.ts';
export { isKubeletRunning, startKubelet, stopKubelet, type KubeletNode } from './kubelet/kubelet.ts';
export { runtimeOf } from './runtime/runtime.ts';
export type { NodeRuntime, RuntimeContainer, Sandbox, RuntimeImage } from './runtime/types.ts';
