// The garbage collector controller (kube-controller-manager `garbage-collector`).
// upstream: pkg/controller/garbagecollector (NewGarbageCollector, GraphBuilder), started by
// cmd/kube-controller-manager/app/core.go newGarbageCollectorController with the client
// "generic-garbage-collector"; events from the graph builder's recorder, component
// "garbage-collector-controller".
//
// One watch per monitored resource (graph.ts monitoredResources). Upstream's three queues —
// graphChanges, attemptToDelete and attemptToOrphan — become the watch handler (graph_builder.ts,
// run when the event arrives, as the graph builder runs right away) and one work queue whose keys
// name the upstream queue (graph.ts gcKey). Upstream runs 20 workers (ConcurrentGCSyncs) with no
// delay; here keys are synced one at a time after the common 5 ms latency. All three upstream
// queues use DefaultTypedControllerRateLimiter and retry forever, as the runtime does without
// maxRetries.
//
// Not modeled: the periodic discovery resync of monitors (GarbageCollector.Sync, every 30 s), which
// only matters when resources come and go (CustomResourceDefinitions, aggregated APIs).

import type { ControllerSpec } from '../types.ts';
import { syncGarbageCollector } from './garbagecollector.ts';
import { graphChangeKeys } from './graph_builder.ts';
import { monitoredResources } from './graph.ts';
import { resourcePath } from './resources.ts';

export const garbageCollectorController: ControllerSpec = {
  name: 'garbage-collector',
  component: 'kube-controller-manager',
  serviceAccount: 'generic-garbage-collector',
  eventSource: 'garbage-collector-controller',
  watches: monitoredResources().map((r) => ({ resource: resourcePath(r), keys: (ev, read) => graphChangeKeys(r, ev, read) })),
  sync: syncGarbageCollector,
  latency: 5,
};
