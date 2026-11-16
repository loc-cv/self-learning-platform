// The namespace controller (kube-controller-manager `namespace`): deletes the content of a
// terminating namespace, then removes the `kubernetes` finalizer so the API server can remove it.
// upstream: pkg/controller/namespace/namespace_controller.go, started by
// cmd/kube-controller-manager/app/core.go newNamespaceController with the client
// "namespace-controller". It records no events.
//
// Every add or update of a namespace with a deletionTimestamp queues it after
// namespaceDeletionGracePeriod (5 s, AddAfter): the latency of this controller. Content that
// remains requeues it after estimate/2 + 1 s (deleter.ts).
//
// Not modeled: the informer resync (--namespace-sync-period, 5 min), which re-queues terminating
// namespaces that nothing else re-queues: one whose only remaining spec finalizers belong to
// someone else. A resync then finds the same state and does nothing new. The work queue's rate
// limiter caps its backoff at 60 s (nsControllerRateLimiter); the runtime's cap is 1000 s, reached
// only after 18 consecutive failures.

import type { JsonObject } from '../../apimachinery/json.ts';
import type { ControllerSpec } from '../types.ts';
import { deleteNamespace } from './deleter.ts';

/** namespaceDeletionGracePeriod. */
export const NAMESPACE_DELETION_GRACE_PERIOD_MS = 5000;

export const namespaceController: ControllerSpec = {
  name: 'namespace',
  component: 'kube-controller-manager',
  serviceAccount: 'namespace-controller',
  watches: [
    {
      resource: 'v1/namespaces',
      // enqueueNamespace, from AddFunc and UpdateFunc (deletes are not handled).
      keys(ev) {
        if (ev.type === 'DELETED') return [];
        const m = (ev.object.metadata ?? {}) as JsonObject;
        return typeof m.deletionTimestamp === 'string' && m.deletionTimestamp !== '' ? [String(m.name)] : [];
      },
    },
  ],
  sync: (c, key) => deleteNamespace(c, key),
  latency: NAMESPACE_DELETION_GRACE_PERIOD_MS,
};
