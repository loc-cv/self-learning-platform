// Event validation, on the core/v1 form of an Event (the storage form of both Event APIs).
// upstream: pkg/apis/core/validation/events.go ValidateEventCreate, ValidateEventUpdate,
// validateV1EventSeries, legacyValidateEvent. The request's group version decides: core/v1
// requests get only the legacy checks (whose reportingController field is then named
// `reportingComponent`), events.k8s.io/v1 requests the strict ones too. Field paths are those
// of the internal type even for events.k8s.io requests (`involvedObject.namespace`, `count`,
// `source`), as upstream reports them. Checked against the v1.37.2 oracle: an events.k8s.io POST
// with regarding.namespace "other", series.count 1, no eventTime, type "Bogus",
// deprecatedCount 3 and deprecatedSource.component set gives, in this order,
// involvedObject.namespace, series.count, series.lastObservedTime, eventTime, type, count, source.

import { invalid, newPath, required, type BadValue, type FieldError } from '../../../apimachinery/field.ts';
import { goJson, isObject, jsonEqual, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { byteLength, isQualifiedName, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { FIELD_IMMUTABLE } from '../../../apimachinery/validation/objectmeta.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';

export const REPORTING_INSTANCE_LENGTH_LIMIT = 128;
export const ACTION_LENGTH_LIMIT = 128;
export const REASON_LENGTH_LIMIT = 128;
export const NOTE_LENGTH_LIMIT = 1024;

/** The group version of the request: '' + 'v1' is core/v1. */
export interface RequestVersion {
  group: string;
  version: string;
}

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
/** A metav1.Time or MicroTime is zero when absent or null in the canonical encoding. */
const isZeroTime = (v: Json | undefined): boolean => typeof v !== 'string' || v === '';
const isLegacy = (rv: RequestVersion): boolean => (rv.group === '' && rv.version === 'v1') || (rv.group === 'events.k8s.io' && rv.version === 'v1beta1');

/** legacyValidateEvent. */
function legacyValidateEvent(ev: JsonObject, rv: RequestVersion): FieldError[] {
  const errs: FieldError[] = [];
  const reportingControllerField = rv.group === '' && rv.version === 'v1' ? 'reportingComponent' : 'reportingController';
  const namespace = str(obj(ev.metadata).namespace);
  const involvedNs = str(obj(ev.involvedObject).namespace);
  const involvedNsPath = newPath('involvedObject', 'namespace');
  if (isZeroTime(ev.eventTime)) {
    if (involvedNs === '') {
      // event.Namespace must also be empty (or "default", for compatibility with old clients).
      if (namespace !== '' && namespace !== 'default') errs.push(invalid(involvedNsPath, involvedNs, 'does not match event.namespace'));
    } else if (namespace !== involvedNs) {
      errs.push(invalid(involvedNsPath, involvedNs, 'does not match event.namespace'));
    }
    return errs;
  }
  if (involvedNs === '' && namespace !== 'default' && namespace !== 'kube-system') errs.push(invalid(involvedNsPath, involvedNs, 'does not match event.namespace'));
  const reportingController = str(ev.reportingComponent);
  if (reportingController === '') errs.push(required(newPath(reportingControllerField), ''));
  // core validation ValidateQualifiedName.
  for (const m of isQualifiedName(reportingController)) errs.push(invalid(newPath(reportingControllerField), reportingController, m));
  const reportingInstance = str(ev.reportingInstance);
  if (reportingInstance === '') errs.push(required(newPath('reportingInstance'), ''));
  if (byteLength(reportingInstance) > REPORTING_INSTANCE_LENGTH_LIMIT) errs.push(invalid(newPath('reportingInstance'), '', `can have at most ${REPORTING_INSTANCE_LENGTH_LIMIT} characters`));
  const action = str(ev.action);
  if (action === '') errs.push(required(newPath('action'), ''));
  if (byteLength(action) > ACTION_LENGTH_LIMIT) errs.push(invalid(newPath('action'), '', `can have at most ${ACTION_LENGTH_LIMIT} characters`));
  const reason = str(ev.reason);
  if (reason === '') errs.push(required(newPath('reason'), ''));
  if (byteLength(reason) > REASON_LENGTH_LIMIT) errs.push(invalid(newPath('reason'), '', `can have at most ${REASON_LENGTH_LIMIT} characters`));
  if (byteLength(str(ev.message)) > NOTE_LENGTH_LIMIT) errs.push(invalid(newPath('message'), '', `can have at most ${NOTE_LENGTH_LIMIT} characters`));
  return errs;
}

/** validateV1EventSeries. */
function validateV1EventSeries(ev: JsonObject): FieldError[] {
  const errs: FieldError[] = [];
  if (!isObject(ev.series)) return errs;
  const count = typeof ev.series.count === 'number' ? ev.series.count : 0;
  if (count < 2) errs.push(invalid(newPath('series.count'), '', 'should be at least 2'));
  if (isZeroTime(ev.series.lastObservedTime)) errs.push(required(newPath('series.lastObservedTime'), ''));
  return errs;
}

export function validateEventCreate(ev: JsonObject, rv: RequestVersion): FieldError[] {
  const errs = legacyValidateEvent(ev, rv);
  if (isLegacy(rv)) return errs;
  // Strict validation of creation through events.k8s.io/v1.
  errs.push(...validateObjectMeta(obj(ev.metadata), true, nameIsDNSSubdomain, newPath('metadata')));
  errs.push(...validateV1EventSeries(ev));
  if (isZeroTime(ev.eventTime)) errs.push(required(newPath('eventTime'), ''));
  const type = str(ev.type);
  if (type !== 'Normal' && type !== 'Warning') errs.push(invalid(newPath('type'), '', `has invalid value: ${type}`));
  if (!isZeroTime(ev.firstTimestamp)) errs.push(invalid(newPath('firstTimestamp'), '', 'needs to be unset'));
  if (!isZeroTime(ev.lastTimestamp)) errs.push(invalid(newPath('lastTimestamp'), '', 'needs to be unset'));
  if (typeof ev.count === 'number' && ev.count !== 0) errs.push(invalid(newPath('count'), '', 'needs to be unset'));
  const source = obj(ev.source);
  if (str(source.component) !== '' || str(source.host) !== '') errs.push(invalid(newPath('source'), '', 'needs to be unset'));
  return errs;
}

// The internal types' Go field names, as json.Marshal renders a bad value of a struct type that
// has no json tags (core.ObjectReference, core.EventSource).
const goObjectReference = (v: Json | undefined): string => {
  const r = obj(v);
  return goJson({
    Kind: str(r.kind),
    Namespace: str(r.namespace),
    Name: str(r.name),
    UID: str(r.uid),
    APIVersion: str(r.apiVersion),
    ResourceVersion: str(r.resourceVersion),
    FieldPath: str(r.fieldPath),
  });
};
const goEventSource = (v: Json | undefined): string => goJson({ Component: str(obj(v).component), Host: str(obj(v).host) });

/** ValidateImmutableField with a pre-rendered bad value. */
function immutable(newVal: Json | undefined, oldVal: Json | undefined, path: string, rendered: BadValue): FieldError[] {
  return jsonEqual(newVal ?? null, oldVal ?? null) ? [] : [invalid(newPath(path), rendered, FIELD_IMMUTABLE)];
}

export function validateEventUpdate(ev: JsonObject, old: JsonObject, rv: RequestVersion): FieldError[] {
  const errs = legacyValidateEvent(ev, rv);
  if (isLegacy(rv)) return errs;
  // Strict validation of updates through events.k8s.io/v1.
  errs.push(...validateObjectMetaUpdate(obj(ev.metadata), obj(old.metadata), newPath('metadata')));
  if (!jsonEqual(ev.series ?? null, old.series ?? null)) errs.push(...validateV1EventSeries(ev));
  const time = (v: Json | undefined): BadValue => (typeof v === 'string' ? v : null);
  const int = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);
  errs.push(...immutable(ev.involvedObject ?? {}, old.involvedObject ?? {}, 'involvedObject', { go: goObjectReference(ev.involvedObject) }));
  errs.push(...immutable(str(ev.reason), str(old.reason), 'reason', str(ev.reason)));
  errs.push(...immutable(str(ev.message), str(old.message), 'message', str(ev.message)));
  errs.push(...immutable(ev.source ?? {}, old.source ?? {}, 'source', { go: goEventSource(ev.source) }));
  errs.push(...immutable(time(ev.firstTimestamp), time(old.firstTimestamp), 'firstTimestamp', time(ev.firstTimestamp)));
  errs.push(...immutable(time(ev.lastTimestamp), time(old.lastTimestamp), 'lastTimestamp', time(ev.lastTimestamp)));
  errs.push(...immutable(int(ev.count), int(old.count), 'count', int(ev.count)));
  errs.push(...immutable(str(ev.reason), str(old.reason), 'reason', str(ev.reason)));
  errs.push(...immutable(str(ev.type), str(old.type), 'type', str(ev.type)));
  // Changes below microsecond precision are tolerated; the stored form has microseconds only.
  errs.push(...immutable(time(ev.eventTime), time(old.eventTime), 'eventTime', time(ev.eventTime)));
  errs.push(...immutable(str(ev.action), str(old.action), 'action', str(ev.action)));
  errs.push(...immutable(ev.related ?? null, old.related ?? null, 'related', isObject(ev.related) ? { go: goObjectReference(ev.related) } : null));
  errs.push(...immutable(str(ev.reportingComponent), str(old.reportingComponent), 'reportingController', str(ev.reportingComponent)));
  errs.push(...immutable(str(ev.reportingInstance), str(old.reportingInstance), 'reportingInstance', str(ev.reportingInstance)));
  return errs;
}
