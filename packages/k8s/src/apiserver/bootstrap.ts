// What a kube-apiserver creates in an empty store when it starts: the system namespaces and the
// `kubernetes` Service. upstream: pkg/controlplane/controller/systemnamespaces (kube-system,
// kube-public, kube-node-lease, then default from the kubernetes service controller),
// pkg/controlplane/controller/kubernetesservice (the Service, ClusterIP = first address of
// --service-cluster-ip-range, port https 443 → --secure-port).
// Each creation goes through the request pipeline, so defaults and allocations are the real ones.

import type { Ctx } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import type { ApiServerConfig } from './config.ts';
import { handle } from './pipeline.ts';
import { STRATEGIES } from '../registry/index.ts';
import { strategyFor } from './strategies.ts';

export const SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'default'] as const;

export function bootstrapApiServer(ctx: Ctx, server: ApiServerConfig): void {
  for (const name of SYSTEM_NAMESPACES) {
    const body: JsonObject = { apiVersion: 'v1', kind: 'Namespace', metadata: { name } };
    const r = handle(ctx, server, { verb: 'create', group: '', version: 'v1', resource: 'namespaces', body });
    if (!r.ok && strategyFor('', 'namespaces')) throw new Error(`bootstrap: namespace ${name}: ${JSON.stringify(r)}`);
  }
  // Objects a kind's port contributes (the kubernetes Service), in strategy order.
  for (const st of STRATEGIES) st.bootstrap?.(ctx, server);
}
