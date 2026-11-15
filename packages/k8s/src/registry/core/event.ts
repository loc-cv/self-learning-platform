// Event (core/v1). upstream: pkg/registry/core/event/strategy.go (namespaced, no status, no
// defaulting; create on update allowed, unconditional update allowed; garbage collection policy
// Unsupported; Validate and ValidateUpdate pass the request's group version to
// ValidateEventCreate/Update; ToSelectableFields), pkg/registry/core/event/storage/storage.go
// (Status on delete; a TTL, --event-ttl, default 1h: not simulated yet, events stay until
// deleted), pkg/apis/core/v1/conversion.go AddFieldLabelConversionsForEvent. The events.k8s.io
// API serves the same storage (registry/events/event.ts).

import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { validateEventCreate, validateEventUpdate } from '../../apis/core/validation/event.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { objectMetaFields } from '../meta.ts';

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});

/** ToSelectableFields, on the stored core/v1 form. */
export function eventFields(o: ApiObject): Record<string, string> {
  const involved = obj(o.involvedObject);
  const source = str(obj(o.source).component) || str(o.reportingComponent);
  return {
    'involvedObject.kind': str(involved.kind),
    'involvedObject.namespace': str(involved.namespace),
    'involvedObject.name': str(involved.name),
    'involvedObject.uid': str(involved.uid),
    'involvedObject.apiVersion': str(involved.apiVersion),
    'involvedObject.resourceVersion': str(involved.resourceVersion),
    'involvedObject.fieldPath': str(involved.fieldPath),
    reason: str(o.reason),
    reportingComponent: str(o.reportingComponent),
    source,
    type: str(o.type),
    ...objectMetaFields(o, true),
  };
}

const CORE_LABELS = new Set([
  'involvedObject.kind',
  'involvedObject.namespace',
  'involvedObject.name',
  'involvedObject.uid',
  'involvedObject.apiVersion',
  'involvedObject.resourceVersion',
  'involvedObject.fieldPath',
  'reason',
  'reportingComponent',
  'source',
  'type',
  'metadata.namespace',
  'metadata.name',
]);

export const eventStrategy: Strategy = {
  group: '',
  resource: 'events',
  kind: 'Event',
  storage: 'events',
  storageVersion: 'v1',
  validate: (o, s) => validateEventCreate(o, { group: s.request.group, version: s.request.version }),
  validateUpdate: (o, old, s) => validateEventUpdate(o, old, { group: s.request.group, version: s.request.version }),
  allowCreateOnUpdate: true,
  allowUnconditionalUpdate: true,
  gcPolicy: 'Unsupported',
  fields: eventFields,
  convertFieldLabel(label, value) {
    if (CORE_LABELS.has(label)) return { label, value };
    return { error: `field label not supported: ${label}` };
  },
};
