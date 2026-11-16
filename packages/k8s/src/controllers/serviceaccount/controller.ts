// The ServiceAccount controller (kube-controller-manager `serviceaccount`): makes sure every
// active namespace has the ServiceAccount `default`.
// upstream: pkg/controller/serviceaccount/serviceaccounts_controller.go (namespaceAdded,
// namespaceUpdated, serviceAccountDeleted, syncNamespace, DefaultServiceAccountsControllerOptions),
// started by cmd/kube-controller-manager/app/core.go newServiceAccountController with the client
// "service-account-controller". It records no events.
//
// The ConfigMap kube-root-ca.crt every namespace also gets comes from another controller
// (root-ca-certificate-publisher), not this one.

import type { JsonObject } from '../../apimachinery/json.ts';
import type { ControllerSpec, SyncCtx, SyncResult } from '../types.ts';

/** DefaultServiceAccountsControllerOptions: the accounts to ensure, as created (name only). */
export const SERVICE_ACCOUNTS_TO_ENSURE: readonly string[] = ['default'];

/** v1.NamespaceTerminatingCause. */
const NAMESPACE_TERMINATING_CAUSE = 'NamespaceTerminating';

const meta = (o: JsonObject): JsonObject => (o.metadata ?? {}) as JsonObject;

/** syncNamespace. */
function syncNamespace(c: SyncCtx, key: string): SyncResult {
  const ns = c.get('v1/namespaces', undefined, key);
  if (!ns) return { done: true };
  if (((ns.status ?? {}) as JsonObject).phase !== 'Active') return { done: true };
  const failures: string[] = [];
  for (const name of SERVICE_ACCOUNTS_TO_ENSURE) {
    if (c.get('v1/serviceaccounts', key, name)) continue;
    const res = c.client.resource('v1/serviceaccounts').create(key, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: key } });
    if (res.ok) continue;
    if ('notSimulated' in res) {
      failures.push(`[sim] not simulated: ${res.notSimulated}`);
      continue;
    }
    if (res.status.reason === 'AlreadyExists') continue;
    if ((res.status.details?.causes ?? []).some((cause) => cause.reason === NAMESPACE_TERMINATING_CAUSE)) continue;
    failures.push(res.status.message ?? '');
  }
  // utilerrors.Flatten(NewAggregate(...)).Error().
  if (failures.length === 0) return { done: true };
  return { error: failures.length === 1 ? (failures[0] as string) : `[${failures.join(', ')}]` };
}

export const serviceAccountController: ControllerSpec = {
  name: 'serviceaccount',
  component: 'kube-controller-manager',
  serviceAccount: 'service-account-controller',
  watches: [
    // namespaceAdded, namespaceUpdated.
    { resource: 'v1/namespaces', keys: (ev) => (ev.type === 'DELETED' ? [] : [String(meta(ev.object).name)]) },
    // serviceAccountDeleted: the namespace of the deleted account.
    { resource: 'v1/serviceaccounts', keys: (ev) => (ev.type === 'DELETED' ? [String(meta(ev.object).namespace)] : []) },
  ],
  sync: syncNamespace,
  latency: 5,
};
