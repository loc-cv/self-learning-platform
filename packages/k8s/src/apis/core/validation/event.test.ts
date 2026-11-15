// Event validation through core/v1 (legacy rules only) and events.k8s.io/v1 (strict rules).
// Messages checked against the v1.37.2 oracle.

import { describe, expect, test } from 'vitest';
import { aggregate, type FieldError } from '../../../apimachinery/field.ts';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { validateEventCreate } from './event.ts';

const all = (errs: FieldError[]): string => (errs.length === 0 ? '' : aggregate(errs));
const CORE = { group: '', version: 'v1' };
const EVENTS = { group: 'events.k8s.io', version: 'v1' };
const ev = (ns: string, extra: JsonObject): JsonObject => ({ metadata: { name: 'e', namespace: ns }, involvedObject: { kind: 'Pod' }, source: {}, ...extra });

describe('core/v1', () => {
  test('without eventTime only the namespaces must agree; "default" accepts an empty involvedObject.namespace', () => {
    expect(all(validateEventCreate(ev('default', {}), CORE))).toBe('');
    expect(all(validateEventCreate(ev('kube-public', {}), CORE))).toBe('involvedObject.namespace: Invalid value: "": does not match event.namespace');
    expect(all(validateEventCreate(ev('default', { involvedObject: { namespace: 'other' } }), CORE))).toBe('involvedObject.namespace: Invalid value: "other": does not match event.namespace');
  });

  test('with eventTime the reporting fields are required; the field is named reportingComponent', () => {
    expect(all(validateEventCreate(ev('default', { eventTime: '2026-11-13T09:00:00.000000Z', message: 'm' }), CORE))).toBe(
      "[reportingComponent: Required value, reportingComponent: Invalid value: \"\": name part must be non-empty, reportingComponent: Invalid value: \"\": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]'), reportingInstance: Required value, action: Required value, reason: Required value]",
    );
  });

  test('length limits', () => {
    const e = ev('default', { eventTime: '2026-11-13T09:00:00.000000Z', reportingComponent: 'c', reportingInstance: 'x'.repeat(129), action: 'a'.repeat(129), reason: 'r'.repeat(129), message: 'm'.repeat(1025) });
    expect(all(validateEventCreate(e, CORE))).toBe(
      '[reportingInstance: Invalid value: "": can have at most 128 characters, action: Invalid value: "": can have at most 128 characters, reason: Invalid value: "": can have at most 128 characters, message: Invalid value: "": can have at most 1024 characters]',
    );
  });
});

describe('events.k8s.io/v1', () => {
  test('strict rules, reported with the internal field names', () => {
    const e = ev('default', { involvedObject: { kind: 'Pod', namespace: 'other' }, type: 'Bogus', count: 3, source: { component: 'c' }, series: { count: 1 } });
    expect(all(validateEventCreate(e, EVENTS))).toBe(
      '[involvedObject.namespace: Invalid value: "other": does not match event.namespace, series.count: Invalid value: "": should be at least 2, series.lastObservedTime: Required value, eventTime: Required value, type: Invalid value: "": has invalid value: Bogus, count: Invalid value: "": needs to be unset, source: Invalid value: "": needs to be unset]',
    );
  });

  test('the reporting controller is named reportingController', () => {
    const e = ev('default', { eventTime: '2026-11-13T09:00:00.000000Z', reportingInstance: 'i', action: 'a', reason: 'r', type: 'Normal' });
    expect(all(validateEventCreate(e, EVENTS))).toMatch(/^\[reportingController: Required value, reportingController: Invalid value: "": name part must be non-empty/);
  });
});
