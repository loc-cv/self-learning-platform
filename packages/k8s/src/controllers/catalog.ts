// The controllers the k8s plugin contributes (registry kind `k8s.controller`).

import type { ControllerSpec } from './types.ts';
import { deploymentController } from './deployment/deployment_controller.ts';
import { endpointsController } from './endpoint/controller.ts';
import { endpointSliceController } from './endpointslice/controller.ts';
import { garbageCollectorController } from './garbagecollector/controller.ts';
import { namespaceController } from './namespace/controller.ts';
import { nodeLifecycleController } from './nodelifecycle/controller.ts';
import { replicaSetController } from './replicaset/replica_set.ts';
import { serviceAccountController } from './serviceaccount/controller.ts';

export const CONTROLLERS: readonly ControllerSpec[] = [
  endpointsController,
  endpointSliceController,
  namespaceController,
  serviceAccountController,
  garbageCollectorController,
  deploymentController,
  replicaSetController,
  nodeLifecycleController,
];
