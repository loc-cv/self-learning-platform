// What several describers print the same way: labels, annotations, taints, tolerations, resource
// lists and the events table.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go printLabelsMultiline,
//             printLabelsMultilineWithIndent, printAnnotationsMultiline (maxAnnotationLen 140,
//             shorten, skipAnnotations = kubectl.kubernetes.io/last-applied-configuration),
//             printNodeTaintsMultiline, printTaintsMultilineWithIndent, printPodTolerationsMultiline,
//             printTolerationsMultilineWithIndent, SortedResourceNames, DescribeEvents,
//             translateTimestampSince, translateMicroTimestampSince
//   upstream: staging/src/k8s.io/api/core/v1/taint.go Taint.ToString
//   upstream: staging/src/k8s.io/kubectl/pkg/util/event/sorted_event_list.go SortableEvents (by
//             lastTimestamp)
//
// Sorting: the describers call sort.Sort and sort.Slice, Go's pdqsort, which is an insertion sort
// (stable) up to 12 elements; `sortBy` is stable at every length, so beyond 12 equal keys (events
// recorded in the same second, tolerations with the same key) Go's order is an implementation
// detail the simulator does not reproduce.

import type { Millis } from '@simlab/kernel';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { compareGoStrings } from '../../apimachinery/labels.ts';
import { sortBy } from '../../controllers/controller_utils.ts';
import { since, timestampMicros } from '../../printers/duration.ts';
import { byteLength, byteSlice, LEVEL_0, LEVEL_1, s, type PrefixWriter } from './writer.ts';

export const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
export const objs = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
export const strMap = (v: Json | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' ? x : '';
  return out;
};
export const meta = (o: JsonObject): JsonObject => obj(o.metadata);

/** sort.Strings */
export const goSorted = (keys: string[]): string[] => [...keys].sort(compareGoStrings);

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
const MAX_ANNOTATION_LEN = 140;

/** printLabelsMultilineWithIndent */
export function printLabelsMultiline(w: PrefixWriter, title: string, labels: Json | undefined, initialIndent = '', innerIndent = '\t'): void {
  w.write(LEVEL_0, `${initialIndent}${title}:${innerIndent}`);
  const m = strMap(labels);
  const keys = goSorted(Object.keys(m));
  if (keys.length === 0) {
    w.writeLine('<none>');
    return;
  }
  keys.forEach((key, i) => {
    if (i !== 0) {
      w.write(LEVEL_0, initialIndent);
      w.write(LEVEL_0, innerIndent);
    }
    w.write(LEVEL_0, `${key}=${m[key] as string}\n`);
  });
}

/** len(s) > maxLength cuts at a byte offset: Go strings are bytes. */
function shorten(str: string, maxLength: number): string {
  return byteLength(str) > maxLength ? `${byteSlice(str, maxLength)}...` : str;
}

const byteLen = byteLength;

/** printAnnotationsMultiline */
export function printAnnotationsMultiline(w: PrefixWriter, title: string, annotations: Json | undefined): void {
  w.write(LEVEL_0, `${title}:\t`);
  const m = strMap(annotations);
  const keys = goSorted(Object.keys(m).filter((k) => k !== LAST_APPLIED));
  if (keys.length === 0) {
    w.writeLine('<none>');
    return;
  }
  const indent = '\t';
  keys.forEach((key, i) => {
    if (i !== 0) w.write(LEVEL_0, indent);
    const value = (m[key] as string).replace(/\n$/, '');
    if (byteLen(value) + byteLen(key) + 2 > MAX_ANNOTATION_LEN || value.includes('\n')) {
      w.write(LEVEL_0, `${key}:\n`);
      for (const line of value.split('\n')) w.write(LEVEL_0, `${indent}  ${shorten(line, MAX_ANNOTATION_LEN - 2)}\n`);
    } else {
      w.write(LEVEL_0, `${key}: ${value}\n`);
    }
  });
}

/** Taint.ToString */
export function taintString(t: JsonObject): string {
  const key = s(t.key);
  const value = s(t.value);
  const effect = s(t.effect);
  if (effect === '') return value === '' ? key : `${key}=${value}:`;
  return value === '' ? `${key}:${effect}` : `${key}=${value}:${effect}`;
}

/** printNodeTaintsMultiline */
export function printNodeTaintsMultiline(w: PrefixWriter, title: string, taints: Json | undefined): void {
  w.write(LEVEL_0, `${title}:\t`);
  const list = objs(taints);
  if (list.length === 0) {
    w.writeLine('<none>');
    return;
  }
  const key = (t: JsonObject) => `${s(t.effect)},${s(t.key)}`;
  sortBy(list, (a, c) => compareGoStrings(key(a), key(c)) < 0).forEach((t, i) => {
    if (i !== 0) {
      w.write(LEVEL_0, '');
      w.write(LEVEL_0, '\t');
    }
    w.write(LEVEL_0, `${taintString(t)}\n`);
  });
}

/** printPodTolerationsMultiline */
export function printPodTolerationsMultiline(w: PrefixWriter, title: string, tolerations: Json | undefined, initialIndent = '', innerIndent = '\t'): void {
  w.write(LEVEL_0, `${initialIndent}${title}:${innerIndent}`);
  const list = objs(tolerations);
  if (list.length === 0) {
    w.writeLine('<none>');
    return;
  }
  sortBy(list, (a, c) => compareGoStrings(s(a.key), s(c.key)) < 0).forEach((t, i) => {
    if (i !== 0) {
      w.write(LEVEL_0, initialIndent);
      w.write(LEVEL_0, innerIndent);
    }
    const key = s(t.key);
    const value = s(t.value);
    const effect = s(t.effect);
    w.write(LEVEL_0, key);
    if (value !== '') w.write(LEVEL_0, `=${value}`);
    if (effect !== '') w.write(LEVEL_0, `:${effect}`);
    // operator Exists with no value tolerates everything of its key (or everything at all)
    if (t.operator === 'Exists' && value === '') w.write(LEVEL_0, key !== '' || effect !== '' ? ' op=Exists' : 'op=Exists');
    if (typeof t.tolerationSeconds === 'number') w.write(LEVEL_0, ` for ${t.tolerationSeconds}s`);
    w.write(LEVEL_0, '\n');
  });
}

// strings.TrimSpace: unicode.IsSpace, which differs from String.prototype.trim (U+0085 is a space to
// Go, U+FEFF is not).
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'gu');
const goTrimSpace = (str: string): string => str.replace(GO_TRIM, '');

/** SortedResourceNames: the keys of a ResourceList in byte order. */
export const sortedResourceNames = (list: Json | undefined): string[] => goSorted(Object.keys(obj(list)));

/** translateTimestampSince and translateMicroTimestampSince: `<unknown>` for the zero time. */
export const translateSince = (v: Json | undefined, now: Millis): string => since(timestampMicros(v), now);

/** DescribeEvents: the events table, after a flush, oldest lastTimestamp first. */
export function describeEvents(events: JsonObject[], w: PrefixWriter, now: Millis): void {
  if (events.length === 0) {
    w.write(LEVEL_0, 'Events:\t<none>\n');
    return;
  }
  w.flush();
  const last = (e: JsonObject) => timestampMicros(e.lastTimestamp) ?? -Infinity;
  const sorted = sortBy([...events], (a, c) => last(a) < last(c));
  w.write(LEVEL_0, 'Events:\n  Type\tReason\tAge\tFrom\tMessage\n');
  w.write(LEVEL_1, '----\t------\t----\t----\t-------\n');
  for (const e of sorted) {
    const eventTimeZero = timestampMicros(e.eventTime) === undefined;
    const first = eventTimeZero ? translateSince(e.firstTimestamp, now) : translateSince(e.eventTime, now);
    const series = isObject(e.series) ? e.series : undefined;
    const count = typeof e.count === 'number' ? e.count : 0;
    let interval: string;
    if (series) interval = `${translateSince(series.lastObservedTime, now)} (x${typeof series.count === 'number' ? series.count : 0} over ${first})`;
    else if (count > 1) interval = `${translateSince(e.lastTimestamp, now)} (x${count} over ${first})`;
    else interval = first;
    // ReportingController is `reportingComponent` in core/v1 JSON
    const source = s(obj(e.source).component) || s(e.reportingComponent);
    let message = goTrimSpace(s(e.message));
    const fieldPath = s(obj(e.involvedObject).fieldPath);
    if (fieldPath !== '') message = `${fieldPath}: ${message}`;
    w.write(LEVEL_1, `${s(e.type)}\t${s(e.reason)}\t${interval}\t${source}\t${message}\n`);
  }
}
