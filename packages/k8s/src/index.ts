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
