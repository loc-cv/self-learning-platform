// events.k8s.io/v1 Event ↔ core/v1 Event, the storage form of both Event APIs.
// upstream: pkg/apis/events/v1/conversion.go Convert_v1_Event_To_core_Event,
// Convert_core_Event_To_v1_Event (regarding ↔ involvedObject, note ↔ message, deprecatedSource ↔
// source, deprecatedFirstTimestamp/LastTimestamp/Count ↔ firstTimestamp/lastTimestamp/count) and
// zz_generated.conversion.go (the fields copied as they are: metadata, eventTime, series,
// reportingController (core/v1 JSON: reportingComponent), reportingInstance, action, reason,
// related, type). Both directions go through the internal type, which has every field of both,
// so nothing is lost. Values stay in their JSON form; the pipeline re-encodes the result
// canonically for the target version.

import type { Json, JsonObject } from '../../../apimachinery/json.ts';

/** [events.k8s.io/v1 field, core/v1 field] for every field of the two versions. */
const FIELDS: readonly (readonly [string, string])[] = [
  ['metadata', 'metadata'],
  ['eventTime', 'eventTime'],
  ['series', 'series'],
  ['reportingController', 'reportingComponent'],
  ['reportingInstance', 'reportingInstance'],
  ['action', 'action'],
  ['reason', 'reason'],
  ['regarding', 'involvedObject'],
  ['related', 'related'],
  ['note', 'message'],
  ['type', 'type'],
  ['deprecatedSource', 'source'],
  ['deprecatedFirstTimestamp', 'firstTimestamp'],
  ['deprecatedLastTimestamp', 'lastTimestamp'],
  ['deprecatedCount', 'count'],
];

function copy(from: JsonObject, to: JsonObject, fromField: string, toField: string): void {
  const v: Json | undefined = from[fromField];
  if (v !== undefined) to[toField] = v;
}

/** Convert_v1_Event_To_core_Event, written out as core/v1. */
export function eventsV1ToCoreV1(ev: JsonObject): JsonObject {
  const out: JsonObject = { apiVersion: 'v1', kind: 'Event' };
  for (const [e, c] of FIELDS) copy(ev, out, e, c);
  return out;
}

/** Convert_core_Event_To_v1_Event, from the core/v1 form. */
export function coreV1ToEventsV1(ev: JsonObject): JsonObject {
  const out: JsonObject = { apiVersion: 'events.k8s.io/v1', kind: 'Event' };
  for (const [e, c] of FIELDS) copy(ev, out, c, e);
  return out;
}
