// The Kubernetes plugin: the `k8s` slice (etcd contents, watch subscriptions, controllers and
// their event recorders, the events.k8s.io broadcasters), the controller runtime's and the
// broadcasters' handlers, and the controllers.

import { put, TOPOLOGY, type Contribution, type Plugin, type SliceSpec } from '@simlab/kernel';
import { K8S, type K8sSlice } from './apiserver/store.ts';
import { CONTROLLERS } from './controllers/catalog.ts';
import { eventsHandlers } from './controllers/events.ts';
import { CONTROLLER, controllerHandlers } from './controllers/runtime.ts';
import { schedulerSpec } from './scheduler/scheduler.ts';
import { TOPOLOGIES } from './topology/build.ts';
import { kubeletSpec } from './kubelet/kubelet.ts';
import { nodeHandlers } from './kubelet/node.ts';
import { runtimeHandlers } from './runtime/runtime.ts';
import { healthHandlers } from './controllers/nodelifecycle/health.ts';

/**
 * 1: etcd data and watches (phase 05a). 2: controllers and recorders (05b). 3: events.k8s.io
 * broadcasters and the serving API servers (06a). 4: node container runtimes (06b).
 */
export const K8S_SLICE_VERSION = 4;

const k8sSliceSpec: SliceSpec<K8sSlice> = {
  name: K8S,
  version: K8S_SLICE_VERSION,
  init: () => ({ etcd: {}, watches: {}, controllers: {}, recorders: {}, eventBroadcasters: {}, apiServers: {}, runtimes: {} }),
  adopt(slice) {
    const refreeze = <V>(table: Record<string, V>): void => {
      for (const k of Object.keys(table)) put(table, k, table[k] as V);
    };
    for (const id of Object.keys(slice.etcd)) {
      const d = slice.etcd[id];
      if (!d) continue;
      for (const r of Object.keys(d.resources)) refreeze(d.resources[r] ?? {});
      refreeze(d.ranges);
      refreeze(d.history);
    }
    refreeze(slice.watches);
    refreeze(slice.controllers);
    refreeze(slice.recorders);
    refreeze(slice.eventBroadcasters);
    refreeze(slice.apiServers);
    refreeze(slice.runtimes);
  },
};

export const k8sPlugin: Plugin = {
  name: K8S,
  requires: ['host'],
  slice: k8sSliceSpec as SliceSpec<unknown>,
  handlers: [...controllerHandlers, ...eventsHandlers, ...runtimeHandlers, ...nodeHandlers, ...healthHandlers],
  contributions: { [CONTROLLER]: [...CONTROLLERS, schedulerSpec, kubeletSpec] as unknown as Contribution[], [TOPOLOGY]: [...TOPOLOGIES] },
};
