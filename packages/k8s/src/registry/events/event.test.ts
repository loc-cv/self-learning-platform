// The two Event APIs over one storage: the conversion between events.k8s.io/v1 and core/v1, an
// Event created through one API read through the other (expected objects captured from the
// v1.37.2 oracle, metadata reduced to name and namespace), and field selectors with the
// events.k8s.io label mapping.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Ctx, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import type { ApiRequest, ApiResponse } from '../../apiserver/types.ts';
import { canonical } from '../../apimachinery/gojson.ts';
import type { JsonObject } from '../../apimachinery/json.ts';
import { schema } from '../../openapi/schema.ts';
import { coreV1ToEventsV1, eventsV1ToCoreV1 } from '../../apis/events/v1/conversion.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

const core = { group: '', version: 'v1', resource: 'events', namespace: 'default' };
const events = { group: 'events.k8s.io', version: 'v1', resource: 'events', namespace: 'default' };

function req(k: Kernel, api: typeof core, r: Partial<ApiRequest> & Pick<ApiRequest, 'verb'>): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { ...api, ...r }));
}

const body = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};

/** The object with metadata reduced to name and namespace, as the oracle captures below are. */
const reduced = (o: JsonObject): JsonObject => {
  const m = o.metadata as JsonObject;
  return { ...o, metadata: { name: m.name as string, namespace: m.namespace as string } };
};

const coreEvent: JsonObject = {
  apiVersion: 'v1',
  kind: 'Event',
  metadata: { name: 'web.1' },
  involvedObject: { kind: 'Pod', name: 'web', namespace: 'default', uid: 'abc', fieldPath: 'spec.containers{app}' },
  reason: 'Started',
  message: 'Started container app',
  type: 'Normal',
  source: { component: 'kubelet', host: 'node01' },
  firstTimestamp: '2026-11-13T09:00:00Z',
  lastTimestamp: '2026-11-13T09:01:00Z',
  count: 3,
};

const eventsEvent: JsonObject = {
  apiVersion: 'events.k8s.io/v1',
  kind: 'Event',
  metadata: { name: 'web.2' },
  eventTime: '2026-11-13T09:00:00.123456Z',
  reportingController: 'example.com/ctl',
  reportingInstance: 'i-1',
  action: 'Scale',
  reason: 'Scaled',
  regarding: { kind: 'Deployment', name: 'web', namespace: 'default', apiVersion: 'apps/v1' },
  related: { kind: 'ReplicaSet', name: 'web-1' },
  note: 'scaled',
  type: 'Warning',
  series: { count: 2, lastObservedTime: '2026-11-13T09:05:00.000001Z' },
};

const canon = (apiVersion: string, o: JsonObject): JsonObject => canonical(o, schema().kind(apiVersion, 'Event')?.id as string) as JsonObject;

describe('conversion between events.k8s.io/v1 and core/v1', () => {
  test('every field survives events.k8s.io → core → events.k8s.io', () => {
    const full = canon('events.k8s.io/v1', { ...eventsEvent, deprecatedSource: { component: 'c', host: 'h' }, deprecatedFirstTimestamp: '2026-11-13T09:00:00Z', deprecatedLastTimestamp: '2026-11-13T09:01:00Z', deprecatedCount: 4 });
    expect(canon('events.k8s.io/v1', coreV1ToEventsV1(canon('v1', eventsV1ToCoreV1(full))))).toEqual(full);
  });

  test('every field survives core → events.k8s.io → core', () => {
    const full = canon('v1', { ...coreEvent, eventTime: '2026-11-13T09:00:00.000001Z', action: 'A', related: { kind: 'Node', name: 'n' }, reportingComponent: 'kubelet', reportingInstance: 'node01', series: { count: 3, lastObservedTime: '2026-11-13T09:02:00.000000Z' } });
    expect(canon('v1', eventsV1ToCoreV1(canon('events.k8s.io/v1', coreV1ToEventsV1(full))))).toEqual(full);
  });

  test('the names map field by field', () => {
    expect(eventsV1ToCoreV1({ regarding: { kind: 'Pod' }, note: 'n', deprecatedSource: { host: 'h' }, deprecatedCount: 2, reportingController: 'c' })).toEqual({
      apiVersion: 'v1',
      kind: 'Event',
      involvedObject: { kind: 'Pod' },
      message: 'n',
      source: { host: 'h' },
      count: 2,
      reportingComponent: 'c',
    });
  });
});

describe('one storage, two APIs', () => {
  test('a core/v1 Event read through events.k8s.io/v1', () => {
    const k = boot();
    expect(req(k, core, { verb: 'create', body: coreEvent }).code).toBe(201);
    // checked against the v1.37.2 oracle: GET /apis/events.k8s.io/v1/namespaces/default/events/<name>
    expect(reduced(body(req(k, events, { verb: 'get', name: 'web.1' })))).toEqual({
      kind: 'Event',
      apiVersion: 'events.k8s.io/v1',
      metadata: { name: 'web.1', namespace: 'default' },
      eventTime: null,
      reason: 'Started',
      regarding: { kind: 'Pod', namespace: 'default', name: 'web', uid: 'abc', fieldPath: 'spec.containers{app}' },
      note: 'Started container app',
      type: 'Normal',
      deprecatedSource: { component: 'kubelet', host: 'node01' },
      deprecatedFirstTimestamp: '2026-11-13T09:00:00Z',
      deprecatedLastTimestamp: '2026-11-13T09:01:00Z',
      deprecatedCount: 3,
    });
  });

  test('an events.k8s.io/v1 Event read through core/v1', () => {
    const k = boot();
    expect(req(k, events, { verb: 'create', body: eventsEvent }).code).toBe(201);
    // checked against the v1.37.2 oracle: GET /api/v1/namespaces/default/events/<name>
    expect(reduced(body(req(k, core, { verb: 'get', name: 'web.2' })))).toEqual({
      kind: 'Event',
      apiVersion: 'v1',
      metadata: { name: 'web.2', namespace: 'default' },
      involvedObject: { kind: 'Deployment', namespace: 'default', name: 'web', apiVersion: 'apps/v1' },
      reason: 'Scaled',
      message: 'scaled',
      source: {},
      firstTimestamp: null,
      lastTimestamp: null,
      type: 'Warning',
      eventTime: '2026-11-13T09:00:00.123456Z',
      series: { count: 2, lastObservedTime: '2026-11-13T09:05:00.000001Z' },
      action: 'Scale',
      related: { kind: 'ReplicaSet', name: 'web-1' },
      reportingComponent: 'example.com/ctl',
      reportingInstance: 'i-1',
    });
  });

  test('field selectors: regarding.* and reportingController map to the stored fields; source falls back to reportingController', () => {
    const k = boot();
    req(k, core, { verb: 'create', body: coreEvent });
    req(k, events, { verb: 'create', body: eventsEvent });
    const names = (api: typeof core, fieldSelector: string): string[] =>
      ((body(req(k, api, { verb: 'list', options: { fieldSelector } })).items as JsonObject[]) ?? []).map((i) => (i.metadata as JsonObject).name as string);
    expect(names(events, 'regarding.kind=Deployment,reportingController=example.com/ctl')).toEqual(['web.2']);
    expect(names(core, 'source=example.com/ctl')).toEqual(['web.2']);
    expect(names(core, 'source=kubelet,involvedObject.uid=abc')).toEqual(['web.1']);
    expect(names(core, 'reportingComponent=example.com/ctl')).toEqual(['web.2']);
    const bad = req(k, events, { verb: 'list', options: { fieldSelector: 'involvedObject.kind=Pod' } });
    expect(!bad.ok && 'status' in bad ? bad.status.message : '').toBe('field label not supported: involvedObject.kind');
    const bad2 = req(k, core, { verb: 'list', options: { fieldSelector: 'regarding.kind=Pod' } });
    expect(!bad2.ok && 'status' in bad2 ? bad2.status.message : '').toBe('field label not supported: regarding.kind');
  });

  test('events.k8s.io updates are strict, core/v1 updates are not', () => {
    const k = boot();
    const created = body(req(k, events, { verb: 'create', body: eventsEvent }));
    const changed = { ...created, note: 'changed', regarding: { kind: 'Deployment', name: 'other', namespace: 'default' } };
    const r = req(k, events, { verb: 'update', name: 'web.2', body: changed });
    // checked against the v1.37.2 oracle (the same message, more fields changed there).
    expect(!r.ok && 'status' in r ? r.status.message : '').toBe(
      'Event "web.2" is invalid: [involvedObject: Invalid value: {"Kind":"Deployment","Namespace":"default","Name":"other","UID":"","APIVersion":"","ResourceVersion":"","FieldPath":""}: field is immutable, message: Invalid value: "changed": field is immutable]',
    );
    const asCore = body(req(k, core, { verb: 'get', name: 'web.2' }));
    expect(req(k, core, { verb: 'update', name: 'web.2', body: { ...asCore, message: 'changed' } }).code).toBe(200);
  });
});
