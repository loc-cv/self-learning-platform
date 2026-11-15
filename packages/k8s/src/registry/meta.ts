// Field sets and label conversion shared by strategies.
// upstream: staging/src/k8s.io/apiserver/pkg/registry/generic/matcher.go ObjectMetaFieldsSet,
// AddObjectMetaFieldsSet; staging/src/k8s.io/apimachinery/pkg/runtime/conversion.go
// DefaultMetaV1FieldSelectorConversion.

import type { JsonObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';

const metaOf = (o: ApiObject): JsonObject => (o.metadata ?? {}) as JsonObject;

/** metadata.name and, for namespaced objects, metadata.namespace. */
export function objectMetaFields(o: ApiObject, namespaced: boolean): Record<string, string> {
  const m = metaOf(o);
  const out: Record<string, string> = { 'metadata.name': typeof m.name === 'string' ? m.name : '' };
  if (namespaced) out['metadata.namespace'] = typeof m.namespace === 'string' ? m.namespace : '';
  return out;
}

/** The conversion of kinds without their own: only metadata.name and metadata.namespace. */
export function defaultFieldLabel(label: string, value: string): { label: string; value: string } | { error: string } {
  if (label === 'metadata.name' || label === 'metadata.namespace') return { label, value };
  return { error: `${JSON.stringify(label)} is not a known field selector: only "metadata.name", "metadata.namespace"` };
}
