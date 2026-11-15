// Admission: the explicit hook between decoding and persisting (docs/ARCHITECTURE.md §4.2).
// Mutating plugins run before the strategy's PrepareForCreate/Validate, validating plugins after
// (upstream: endpoints/handlers/create.go, registry/rest/create.go BeforeCreate). The chain of
// kube-apiserver's default plugins is phase 20b's; only NamespaceLifecycle exists now (D-039),
// because without it objects would be accepted into namespaces that do not exist.

import { forbiddenError, notFoundError, type Status } from '../apimachinery/errors.ts';
import type { JsonObject } from '../apimachinery/json.ts';
import { objectKey, storeGet, type EtcdData } from './store.ts';

export interface AdmissionAttributes {
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  group: string;
  version: string;
  resource: string;
  subresource?: string;
  kind: string;
  namespace?: string;
  name: string;
  object?: JsonObject;
  oldObject?: JsonObject;
  dryRun: boolean;
}

export interface AdmissionPlugin {
  name: string;
  admit?(a: AdmissionAttributes, etcd: EtcdData): Status | undefined;
  validate?(a: AdmissionAttributes, etcd: EtcdData): Status | undefined;
}

/** kube-apiserver's immortal namespaces (upstream: options/admission.go, lifecycle). */
const IMMORTAL = new Set(['default', 'kube-system', 'kube-public']);

/**
 * upstream: staging/src/k8s.io/apiserver/pkg/admission/plugin/namespace/lifecycle/admission.go
 * Lifecycle.Admit. The informer-cache waits and live lookups have no counterpart: the simulated
 * server reads its store directly.
 */
export const namespaceLifecycle: AdmissionPlugin = {
  name: 'NamespaceLifecycle',
  admit(a, etcd) {
    const gr = { group: a.group, resource: a.resource };
    const isNamespace = a.group === '' && a.kind === 'Namespace';
    if (a.operation === 'DELETE' && isNamespace && IMMORTAL.has(a.name)) {
      return forbiddenError(gr, a.name, 'this namespace may not be deleted');
    }
    if (!a.namespace && !isNamespace) return undefined;
    if (isNamespace) return undefined;
    if (a.operation === 'DELETE' || a.operation === 'UPDATE') return undefined;
    const ns = storeGet(etcd, 'namespaces', objectKey(undefined, a.namespace as string));
    if (!ns) return notFoundError({ group: '', resource: 'namespaces' }, a.namespace as string);
    if (a.operation === 'CREATE' && (ns.status as JsonObject | undefined)?.phase === 'Terminating') {
      const err = `unable to create new content in namespace ${a.namespace as string} because it is being terminated`;
      // admission.NewForbidden: the resource and the object's name; then the NamespaceTerminating cause.
      return forbiddenError(gr, a.name, err, [
        { reason: 'NamespaceTerminating', message: `namespace ${a.namespace as string} is being terminated`, field: 'metadata.namespace' },
      ]);
    }
    return undefined;
  },
};

/** The plugins in order. */
export const ADMISSION_CHAIN: readonly AdmissionPlugin[] = [namespaceLifecycle];

export function admitAll(a: AdmissionAttributes, etcd: EtcdData): Status | undefined {
  for (const p of ADMISSION_CHAIN) {
    const s = p.admit?.(a, etcd);
    if (s) return s;
  }
  return undefined;
}

export function validateAll(a: AdmissionAttributes, etcd: EtcdData): Status | undefined {
  for (const p of ADMISSION_CHAIN) {
    const s = p.validate?.(a, etcd);
    if (s) return s;
  }
  return undefined;
}
