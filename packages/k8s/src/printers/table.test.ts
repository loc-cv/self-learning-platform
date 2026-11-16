// The API server's Table responses (as=Table): the shape of a list and of a single object, every
// served kind having a printer, includeObject, events.k8s.io printed as core Events, the scale
// subresource, and watches that send one-row Tables with column definitions on the first event only.
// upstream: apiserver/pkg/endpoints/handlers/response.go asTable, watchEmbeddedEncoder.doEncode;
// pkg/printers/tablegenerator.go GenerateTable; registry/rest/table.go defaultTableConvertor.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Ctx, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from '../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { handle, openWatch, watchEvents } from '../apiserver/pipeline.ts';
import type { ApiRequest, ApiResponse } from '../apiserver/types.ts';
import { STRATEGIES } from '../registry/index.ts';
import type { JsonObject } from '../apimachinery/json.ts';
import { printHandler } from './handlers.ts';
import { defaultConvertToTable } from './tablegenerator.ts';
import type { Table } from './types.ts';

const plugins = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(plugins, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

function req(k: Kernel, r: Partial<ApiRequest> & Pick<ApiRequest, 'verb'>): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { group: '', version: 'v1', resource: 'configmaps', namespace: 'default', ...r }));
}
const ok = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.object as JsonObject;
};
const table = (r: ApiResponse): Table => ok(r) as unknown as Table;

const cm = (name: string, data: Record<string, string>) => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, labels: { app: name } }, data });

describe('Table responses', () => {
  test('a list: Table kind, the list resourceVersion, every column with its priority, rows with PartialObjectMetadata', () => {
    const k = boot();
    ok(req(k, { verb: 'create', body: cm('a', { x: '1', y: '2' }) }));
    k.advance(65_000);
    const t = table(req(k, { verb: 'list', options: { as: 'Table' } }));
    expect(Object.keys(t)).toEqual(['kind', 'apiVersion', 'metadata', 'columnDefinitions', 'rows']);
    expect(t.kind).toBe('Table');
    expect(t.apiVersion).toBe('meta.k8s.io/v1');
    const list = ok(req(k, { verb: 'list' }));
    expect(t.metadata).toEqual({ resourceVersion: (list.metadata as JsonObject).resourceVersion });
    expect(t.columnDefinitions?.map((c) => [c.name, c.type, c.format, c.priority])).toEqual([
      ['Name', 'string', 'name', 0],
      ['Data', 'string', '', 0],
      ['Age', 'string', '', 0],
    ]);
    expect(t.columnDefinitions?.[0]?.description).toMatch(/^Name must be unique within a namespace\./);
    const row = t.rows?.[0];
    expect(row?.cells).toEqual(['a', 2, '65s']);
    const o = row?.object as JsonObject;
    expect(Object.keys(o)).toEqual(['kind', 'apiVersion', 'metadata']);
    expect(o.kind).toBe('PartialObjectMetadata');
    expect(o.apiVersion).toBe('meta.k8s.io/v1');
    expect((o.metadata as JsonObject).labels).toEqual({ app: 'a' });
    expect((o.metadata as JsonObject).namespace).toBe('default');
  });

  test('a single object: one row, the object resourceVersion; NotFound stays a Status', () => {
    const k = boot();
    const created = ok(req(k, { verb: 'create', body: cm('a', {}) }));
    const t = table(req(k, { verb: 'get', name: 'a', options: { as: 'Table' } }));
    expect(t.metadata).toEqual({ resourceVersion: (created.metadata as JsonObject).resourceVersion });
    expect(t.rows?.map((r) => r.cells)).toEqual([['a', 0, '0s']]);
    const missing = req(k, { verb: 'get', name: 'nope', options: { as: 'Table' } });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && 'status' in missing ? missing.status.reason : '').toBe('NotFound');
  });

  test('an empty list has rows [], not null', () => {
    const k = boot();
    const t = table(req(k, { verb: 'list', options: { as: 'Table', labelSelector: 'app=none' } }));
    expect(t.rows).toEqual([]);
    expect(t.columnDefinitions).not.toBeNull();
  });

  test('includeObject: None gives null, Object the object in the request version, anything else is a BadRequest', () => {
    const k = boot();
    ok(req(k, { verb: 'create', body: cm('a', { x: '1' }) }));
    const none = table(req(k, { verb: 'list', options: { as: 'Table', includeObject: 'None' } }));
    expect(none.rows?.[0]?.object).toBeNull();
    const full = table(req(k, { verb: 'list', options: { as: 'Table', includeObject: 'Object' } }));
    const o = full.rows?.[0]?.object as JsonObject;
    expect(o.apiVersion).toBe('v1');
    expect(o.kind).toBe('ConfigMap');
    expect(o.data).toEqual({ x: '1' });
    const bad = req(k, { verb: 'list', options: { as: 'Table', includeObject: 'All' } });
    expect(!bad.ok && 'status' in bad ? [bad.status.code, bad.status.reason, bad.status.message] : []).toEqual([400, 'BadRequest', 'unrecognized includeObject value: "All"']);
  });

  test('events.k8s.io Events are printed by the core Event printer', () => {
    const k = boot();
    ok(
      req(k, {
        verb: 'create',
        group: 'events.k8s.io',
        resource: 'events',
        body: {
          apiVersion: 'events.k8s.io/v1',
          kind: 'Event',
          metadata: { name: 'e1' },
          eventTime: '2026-01-01T00:00:00.000000Z',
          reportingController: 'default-scheduler',
          reportingInstance: 'default-scheduler-controlplane',
          action: 'Scheduling',
          reason: 'Scheduled',
          type: 'Normal',
          note: 'Successfully assigned default/p to node01',
          regarding: { kind: 'Pod', namespace: 'default', name: 'p' },
        },
      }),
    );
    const t = table(req(k, { verb: 'list', group: 'events.k8s.io', resource: 'events', options: { as: 'Table' } }));
    expect(t.columnDefinitions?.map((c) => c.name)).toEqual(['Last Seen', 'Type', 'Reason', 'Object', 'Subobject', 'Source', 'Message', 'First Seen', 'Count', 'Name']);
    expect(t.rows?.[0]?.cells.slice(1)).toEqual(['Normal', 'Scheduled', 'pod/p', '', 'default-scheduler, default-scheduler-controlplane', 'Successfully assigned default/p to node01', expect.any(String), 1, 'e1']);
  });

  test('the scale subresource is printed by printScale', () => {
    const k = boot();
    const dep = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web' },
      spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'c', image: 'nginx' }] } } },
    };
    ok(req(k, { verb: 'create', group: 'apps', resource: 'deployments', body: dep }));
    const t = table(req(k, { verb: 'get', group: 'apps', resource: 'deployments', subresource: 'scale', name: 'web', options: { as: 'Table' } }));
    expect(t.columnDefinitions?.map((c) => c.name)).toEqual(['Name', 'Desired', 'Available', 'Age']);
    expect(t.rows?.[0]?.cells).toEqual(['web', 2, 0, '0s']);
  });

  test('every served kind has a printer', () => {
    const missing: string[] = [];
    for (const st of STRATEGIES) if (!printHandler(st.storageGroup ?? st.group, st.kind)) missing.push(`${st.group}/${st.resource}`);
    expect(STRATEGIES.length).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });

  test('the default convertor: Name and Created At, null rows for an empty list', () => {
    const t = defaultConvertToTable({ items: [{ metadata: { name: 'x', creationTimestamp: '2026-01-02T03:04:05Z' } }], resourceVersion: '7' }, { noHeaders: false, now: 0 });
    expect(t.columnDefinitions?.map((c) => [c.name, c.type, c.format])).toEqual([
      ['Name', 'string', 'name'],
      ['Created At', 'date', ''],
    ]);
    expect(t.rows?.map((r) => r.cells)).toEqual([['x', '2026-01-02T03:04:05Z']]);
    expect(t.metadata).toEqual({ resourceVersion: '7' });
    expect(defaultConvertToTable({ items: [], resourceVersion: '7' }, { noHeaders: true, now: 0 })).toMatchObject({ rows: null, columnDefinitions: null });
  });
});

describe('watching Tables', () => {
  test('each event is a one-row Table; only the first carries column definitions', () => {
    const k = boot();
    ok(req(k, { verb: 'create', body: cm('a', {}) }));
    const opened = k.act('watch', (ctx) => openWatch(ctx, DEFAULT_APISERVER, { verb: 'watch', group: '', version: 'v1', resource: 'configmaps', namespace: 'default', options: { as: 'Table' } }, 'test'));
    if (!('ok' in opened)) throw new Error(JSON.stringify(opened));
    const first = k.act('read', (ctx) => watchEvents(ctx, DEFAULT_APISERVER, opened.ok.id));
    ok(req(k, { verb: 'create', body: cm('b', { k: 'v' }) }));
    ok(req(k, { verb: 'delete', name: 'a' }));
    const later = k.act('read', (ctx) => watchEvents(ctx, DEFAULT_APISERVER, opened.ok.id));
    const events = [...first, ...later];
    // kube-root-ca.crt is not published in this bare API server; 'a' is the only initial object.
    expect(events.map((e) => [e.type, (e.object as unknown as Table).rows?.[0]?.cells[0]])).toEqual([
      ['ADDED', 'a'],
      ['ADDED', 'b'],
      ['DELETED', 'a'],
    ]);
    const tables = events.map((e) => e.object as unknown as Table);
    expect(tables[0]?.columnDefinitions?.map((c) => c.name)).toEqual(['Name', 'Data', 'Age']);
    expect(tables[1]?.columnDefinitions).toBeNull();
    expect(tables[2]?.columnDefinitions).toBeNull();
    expect(tables.every((t) => t.kind === 'Table' && t.rows?.length === 1)).toBe(true);
    expect((tables[1]?.rows?.[0]?.object as JsonObject).kind).toBe('PartialObjectMetadata');
  });

  test('a watch without as=Table still sends objects', () => {
    const k = boot();
    const opened = k.act('watch', (ctx) => openWatch(ctx, DEFAULT_APISERVER, { verb: 'watch', group: '', version: 'v1', resource: 'configmaps', namespace: 'default' }, 'test'));
    if (!('ok' in opened)) throw new Error(JSON.stringify(opened));
    ok(req(k, { verb: 'create', body: cm('b', {}) }));
    const events = k.act('read', (ctx) => watchEvents(ctx, DEFAULT_APISERVER, opened.ok.id));
    expect(events.map((e) => e.object.kind)).toEqual(['ConfigMap']);
  });
});
