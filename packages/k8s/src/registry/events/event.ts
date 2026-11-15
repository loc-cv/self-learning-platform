// Event (events.k8s.io/v1). upstream: pkg/registry/events/rest/storage_events.go (the
// events.k8s.io group is served by the core event REST storage, eventstore.NewREST: same
// strategy, same etcd resource), pkg/registry/core/event/strategy.go (validation with the
// request's group version: the strict events.k8s.io rules), pkg/apis/events/v1/conversion.go
// (conversion to and from the stored core/v1 form; AddFieldLabelConversionsForEvent maps
// regarding.* to involvedObject.* and reportingController to reportingComponent). The internal
// kind is core's: Invalid errors say `Event "x" is invalid` with no group (checked against the
// v1.37.2 oracle).

import type { JsonObject } from '../../apimachinery/json.ts';
import { validateEventCreate, validateEventUpdate } from '../../apis/core/validation/event.ts';
import { coreV1ToEventsV1, eventsV1ToCoreV1 } from '../../apis/events/v1/conversion.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { eventFields } from '../core/event.ts';

const LABELS: Record<string, string> = {
  reason: 'reason',
  'regarding.kind': 'involvedObject.kind',
  'regarding.namespace': 'involvedObject.namespace',
  'regarding.name': 'involvedObject.name',
  'regarding.uid': 'involvedObject.uid',
  'regarding.apiVersion': 'involvedObject.apiVersion',
  'regarding.resourceVersion': 'involvedObject.resourceVersion',
  'regarding.fieldPath': 'involvedObject.fieldPath',
  reportingController: 'reportingComponent',
  type: 'type',
  'metadata.namespace': 'metadata.namespace',
  'metadata.name': 'metadata.name',
};

const RV = { group: 'events.k8s.io', version: 'v1' };

export const eventsEventStrategy: Strategy = {
  group: 'events.k8s.io',
  resource: 'events',
  kind: 'Event',
  storage: 'events',
  storageGroup: '',
  storageVersion: 'v1',
  internalGroup: '',
  toStorage: (o) => eventsV1ToCoreV1(o),
  fromStorage: (o) => coreV1ToEventsV1(o as JsonObject),
  validate: (o) => validateEventCreate(eventsV1ToCoreV1(o), RV),
  validateUpdate: (o, old) => validateEventUpdate(eventsV1ToCoreV1(o), eventsV1ToCoreV1(old), RV),
  allowCreateOnUpdate: true,
  allowUnconditionalUpdate: true,
  gcPolicy: 'Unsupported',
  fields: eventFields,
  convertFieldLabel(label, value) {
    const mapped = LABELS[label];
    if (mapped !== undefined) return { label: mapped, value };
    return { error: `field label not supported: ${label}` };
  },
};
