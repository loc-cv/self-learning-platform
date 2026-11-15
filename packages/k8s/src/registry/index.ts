// The kinds with behavior: one strategy per resource, ported from pkg/registry/<group>/<resource>.
// Every other resource in the discovery registry answers with a [sim] notice.

import type { Strategy } from '../apiserver/types.ts';
import { configMapStrategy } from './core/configmap.ts';
import { namespaceStrategy } from './core/namespace.ts';
import { eventStrategy } from './core/event.ts';
import { nodeStrategy } from './core/node.ts';
import { secretStrategy } from './core/secret.ts';
import { serviceAccountStrategy } from './core/serviceaccount.ts';
import { leaseStrategy } from './coordination/lease.ts';
import { eventsEventStrategy } from './events/event.ts';
import { podStrategy } from './core/pod.ts';
import { deploymentStrategy } from './apps/deployment.ts';
import { replicaSetStrategy } from './apps/replicaset.ts';
import { serviceStrategy } from './core/service.ts';
import { endpointsStrategy } from './core/endpoints.ts';
import { endpointSliceStrategy } from './discovery/endpointslice.ts';
import { ipAddressStrategy } from './networking/ipaddress.ts';
import { serviceCIDRStrategy } from './networking/servicecidr.ts';

export const STRATEGIES: readonly Strategy[] = [
  configMapStrategy,
  namespaceStrategy,
  secretStrategy,
  serviceAccountStrategy,
  eventStrategy,
  eventsEventStrategy,
  leaseStrategy,
  nodeStrategy,
  podStrategy,
  deploymentStrategy,
  replicaSetStrategy,
  serviceStrategy,
  endpointsStrategy,
  endpointSliceStrategy,
  ipAddressStrategy,
  serviceCIDRStrategy,
];
