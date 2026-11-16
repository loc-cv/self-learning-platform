// kubectl's human-readable table printer and tab writer against upstream's own expectations.
// upstream: staging/src/k8s.io/cli-runtime/pkg/printers/tableprinter_test.go (v1.37.2);
//   staging/src/k8s.io/kubectl/pkg/cmd/get/get_test.go (the printing part of the get tests).
//
// How upstream drives the printer: every tableprinter_test.go case makes a fresh printer
// (NewTablePrinter) and calls PrintObj once with a bytes.Buffer, so PrintObj wraps the buffer in
// its own GetNewTabWriter and flushes it when it returns: here createTablePrinter + add + flush.
// get.go Run keeps one tab writer, flushes it and resets its remembered widths when the mapping
// changes and makes a new printer per mapping; get.go watch keeps one printer and one writer and
// flushes after the list and after every event.
//
// Upstream builds typed objects (metav1.Table without TypeMeta, *corev1.Pod in a row); here they
// are the JSON kubectl decodes them from (table_printer.go decodeIntoTable), so every Table
// carries kind and apiVersion and a row's object is the object's JSON.

import { describe, expect, test } from 'vitest';
import type { Json } from '../../apimachinery/json.ts';
import { createTablePrinter, newHumanReadablePrinter, printObj, type PrintExtra, type PrintOptions } from './tableprinter.ts';
import { GET_TABWRITER, newTabWriter, tabFlush } from './tabwriter.ts';

// ---- helpers ----

type Col = { name: string; type: string; format?: string; description?: string; priority?: number };
type Row = { cells: Json[]; object?: Json };

/** metav1.TableColumnDefinition with Go's zero values for the fields a case leaves out. */
const col = (c: Col): Json => ({ name: c.name, type: c.type, format: c.format ?? '', description: c.description ?? '', priority: c.priority ?? 0 });

function table(columns: Col[] | null, rows: Row[] | null, apiVersion = 'meta.k8s.io/v1'): Json {
  return {
    kind: 'Table',
    apiVersion,
    metadata: {},
    columnDefinitions: columns === null ? null : columns.map(col),
    rows: rows === null ? null : rows.map((r) => (r.object === undefined ? { cells: r.cells } : { cells: r.cells, object: r.object })),
  };
}

function opts(o: Partial<PrintOptions> = {}): PrintOptions {
  return { noHeaders: false, withNamespace: false, withKind: false, wide: false, showLabels: false, kind: { group: '', kind: '' }, columnLabels: [], ...o };
}

/** A fresh printer, one PrintObj into a bytes.Buffer (PrintObj's own tab writer, flushed at its end). */
function printOnce(options: Partial<PrintOptions>, obj: Json, extra?: PrintExtra): string {
  const p = createTablePrinter(opts(options));
  p.add(obj, extra);
  return p.flush();
}

// upstream: tableprinter_test.go testPod (typed; here its JSON).
const testPod: Json = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'test-pod-name', namespace: 'test-namespace', labels: { 'first-label': '12', 'second-label': 'label-value' } },
};

const fiveColumns: Col[] = [
  { name: 'Name', type: 'string' },
  { name: 'Ready', type: 'string' },
  { name: 'Status', type: 'string' },
  { name: 'Retries', type: 'integer' },
  { name: 'Age', type: 'string' },
];
const fiveColumnsLowPriority: Col[] = [
  { name: 'Name', type: 'string' },
  { name: 'Ready', type: 'string' },
  { name: 'Status', type: 'string' },
  { name: 'Retries', type: 'integer', priority: 1 },
  { name: 'Age', type: 'string', priority: 1 },
];
const row1: Row = { cells: ['test1', '1/1', 'podPhase', 5, '20h'] };
const threeRows: Row[] = [row1, { cells: ['test2', '1/2', 'podPhase', 30, '21h'] }, { cells: ['test3', '4/4', 'podPhase', 1, '22h'] }];

// ---- tableprinter_test.go ----

// upstream: tableprinter_test.go TestPrintTable_MissingColumnsRows
describe('TestPrintTable_MissingColumnsRows', () => {
  test('no columns and no rows prints nothing', () => {
    expect(printOnce({}, table([], []))).toBe('');
  });
  test('no rows prints nothing (columns are not printed)', () => {
    expect(printOnce({}, table(fiveColumns, []))).toBe('');
  });
});

// upstream: tableprinter_test.go TestPrintTable_ColumnPriority
describe('TestPrintTable_ColumnPriority', () => {
  test('single row: priority > 0 columns are not printed', () => {
    expect(printOnce({}, table(fiveColumnsLowPriority, [row1]))).toBe('NAME    READY   STATUS\ntest1   1/1     podPhase\n');
  });
  test('multi row: priority > 0 columns are not printed', () => {
    expect(printOnce({}, table(fiveColumnsLowPriority, threeRows))).toBe(`NAME    READY   STATUS
test1   1/1     podPhase
test2   1/2     podPhase
test3   4/4     podPhase
`);
  });
  test('single row, wide: priority > 0 columns are printed', () => {
    expect(printOnce({ wide: true }, table(fiveColumnsLowPriority, [row1]))).toBe('NAME    READY   STATUS     RETRIES   AGE\ntest1   1/1     podPhase   5         20h\n');
  });
  test('multi row, wide: priority > 0 columns are printed', () => {
    expect(printOnce({ wide: true }, table(fiveColumnsLowPriority, threeRows))).toBe(`NAME    READY   STATUS     RETRIES   AGE
test1   1/1     podPhase   5         20h
test2   1/2     podPhase   30        21h
test3   4/4     podPhase   1         22h
`);
  });
});

// upstream: tableprinter_test.go TestPrintTable_ColumnHeaders
describe('TestPrintTable_ColumnHeaders', () => {
  test('single row shows the headers', () => {
    expect(printOnce({}, table(fiveColumns, [row1]))).toBe('NAME    READY   STATUS     RETRIES   AGE\ntest1   1/1     podPhase   5         20h\n');
  });
  test('multi row shows the headers', () => {
    expect(printOnce({}, table(fiveColumns, threeRows))).toBe(`NAME    READY   STATUS     RETRIES   AGE
test1   1/1     podPhase   5         20h
test2   1/2     podPhase   30        21h
test3   4/4     podPhase   1         22h
`);
  });
  test('single row, NoHeaders', () => {
    expect(printOnce({ noHeaders: true }, table(fiveColumns, [row1]))).toBe('test1   1/1   podPhase   5     20h\n');
  });
  test('multi row, NoHeaders', () => {
    expect(printOnce({ noHeaders: true }, table(fiveColumns, threeRows))).toBe(`test1   1/1   podPhase   5     20h
test2   1/2   podPhase   30    21h
test3   4/4   podPhase   1     22h
`);
  });
});

// upstream: tableprinter_test.go TestPrintTable_WithNamespace
describe('TestPrintTable_WithNamespace', () => {
  test('WithNamespace prepends a NAMESPACE column', () => {
    expect(printOnce({ withNamespace: true }, table(fiveColumns, [{ ...row1, object: testPod }]))).toBe(`NAMESPACE        NAME    READY   STATUS     RETRIES   AGE
test-namespace   test1   1/1     podPhase   5         20h
`);
  });
});

// upstream: tableprinter_test.go TestPrintTable_WithKind
describe('TestPrintTable_WithKind', () => {
  test('WithKind prepends "pod/" to the name', () => {
    const cols: Col[] = [{ name: 'Name', type: 'string', format: 'name' }, ...fiveColumns.slice(1)];
    expect(printOnce({ withKind: true, kind: { group: '', kind: 'Pod' } }, table(cols, [row1]))).toBe(`NAME        READY   STATUS     RETRIES   AGE
pod/test1   1/1     podPhase   5         20h
`);
  });
});

// upstream: tableprinter_test.go TestPrintTable_WithLabels
describe('TestPrintTable_WithLabels', () => {
  const t = () => table(fiveColumns, [{ ...row1, object: testPod }]);
  test('ShowLabels appends a LABELS column', () => {
    expect(printOnce({ showLabels: true }, t())).toBe(`NAME    READY   STATUS     RETRIES   AGE   LABELS
test1   1/1     podPhase   5         20h   first-label=12,second-label=label-value
`);
  });
  test('ColumnLabels appends one label column', () => {
    expect(printOnce({ columnLabels: ['second-label'] }, t())).toBe(`NAME    READY   STATUS     RETRIES   AGE   SECOND-LABEL
test1   1/1     podPhase   5         20h   label-value
`);
  });
  test('ColumnLabels appends several label columns', () => {
    expect(printOnce({ columnLabels: ['first-label', 'second-label'] }, t())).toBe(`NAME    READY   STATUS     RETRIES   AGE   FIRST-LABEL   SECOND-LABEL
test1   1/1     podPhase   5         20h   12            label-value
`);
  });
});

// upstream: tableprinter_test.go TestPrintTable_NonTable. The two Status cases are skipped: they
// pass a typed *metav1.Status, which PrintObj's type switch sends to the status handler (STATUS,
// REASON, MESSAGE); kubectl get decodes responses as unstructured, so that handler is never
// reached from the objects this printer receives.
describe('TestPrintTable_NonTable', () => {
  test('default printing of a pod', () => {
    expect(printOnce({}, testPod)).toBe('NAME            AGE\ntest-pod-name   <unknown>\n');
  });
  test('default printing of a pod, NoHeaders', () => {
    expect(printOnce({ noHeaders: true }, testPod)).toBe('test-pod-name   <unknown>\n');
  });
  test('default printing of a pod, WithNamespace', () => {
    expect(printOnce({ withNamespace: true }, testPod)).toBe('NAMESPACE        NAME            AGE\ntest-namespace   test-pod-name   <unknown>\n');
  });
  test('default printing of a pod, ShowLabels', () => {
    expect(printOnce({ showLabels: true }, testPod)).toBe(`NAME            AGE         LABELS
test-pod-name   <unknown>   first-label=12,second-label=label-value
`);
  });
});

// upstream: tableprinter_test.go TestPrintTable_WatchEvents (a *metav1.WatchEvent of Type "Added"
// wrapping the table: add with eventType; "Added" is not in formattedEventType and prints as is).
describe('TestPrintTable_WatchEvents', () => {
  const t = () => table(fiveColumns, [{ ...row1, object: testPod }]);
  test('a WatchEvent with a Table', () => {
    expect(printOnce({}, t(), { eventType: 'Added' })).toBe(`EVENT   NAME    READY   STATUS     RETRIES   AGE
Added   test1   1/1     podPhase   5         20h
`);
  });
  test('a WatchEvent with a Table, NoHeaders, WithNamespace and ShowLabels', () => {
    expect(printOnce({ noHeaders: true, withNamespace: true, showLabels: true }, t(), { eventType: 'Added' })).toBe(
      'Added   test-namespace   test1   1/1   podPhase   5     20h   first-label=12,second-label=label-value\n',
    );
  });
});

// upstream: tableprinter_test.go TestPrintUnstructuredObject. Upstream matches regular expressions
// (the age is time.Now() minus 2017-04-01); here the clock is fixed at 2017-04-11T00:00:00Z, so the
// age is "10d" (duration.HumanDuration) and the exact output is checked too.
describe('TestPrintUnstructuredObject', () => {
  const now = 1491868800000; // 2017-04-11T00:00:00Z
  const metadata = (name: string, labels: Json): Json => ({
    name,
    namespace: 'MyNamespace',
    creationTimestamp: '2017-04-01T00:00:00Z',
    resourceVersion: 123,
    uid: '00000000-0000-0000-0000-000000000001',
    dummy3: 'present',
    labels,
  });
  const obj: Json = { apiVersion: 'v1', kind: 'Test', dummy1: 'present', dummy2: 'present', metadata: metadata('MyName', { test: 'other' }), url: 'http://localhost', status: 'ok' };
  const list: Json = {
    apiVersion: 'v1',
    kind: 'Test',
    dummy1: 'present',
    dummy2: 'present',
    items: [{ metadata: metadata('MyName', { test: 'other' }) }, { metadata: metadata('MyName2', 'badlabel') }],
    url: 'http://localhost',
    status: 'ok',
  };
  const cases: { name: string; options: Partial<PrintOptions>; object: Json; regexp: string; exact: string }[] = [
    { name: 'default', options: {}, object: obj, regexp: 'NAME\\s+AGE\nMyName\\s+\\d+', exact: 'NAME     AGE\nMyName   10d\n' },
    {
      name: 'WithNamespace',
      options: { withNamespace: true },
      object: obj,
      regexp: 'NAMESPACE\\s+NAME\\s+AGE\nMyNamespace\\s+MyName\\s+\\d+',
      exact: 'NAMESPACE     NAME     AGE\nMyNamespace   MyName   10d\n',
    },
    {
      name: 'ShowLabels and WithNamespace',
      options: { showLabels: true, withNamespace: true },
      object: obj,
      regexp: 'NAMESPACE\\s+NAME\\s+AGE\\s+LABELS\nMyNamespace\\s+MyName\\s+\\d+\\w+\\s+test\\=other',
      exact: 'NAMESPACE     NAME     AGE   LABELS\nMyNamespace   MyName   10d   test=other\n',
    },
    { name: 'a list', options: {}, object: list, regexp: 'NAME\\s+AGE\nMyName\\s+\\d+\\w+\nMyName2\\s+\\d+', exact: 'NAME      AGE\nMyName    10d\nMyName2   10d\n' },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const out = printOnce(c.options, c.object, { now });
      expect(out).toMatch(new RegExp(c.regexp));
      expect(out).toBe(c.exact);
    });
  }
});

// upstream: tableprinter_test.go columnStartOffsets: the byte offset of every non-first column
// (the first non-space after a run of at least two spaces).
function columnStartOffsets(line: string): number[] {
  const offsets: number[] = [];
  for (let i = 2; i < line.length; i++) if (line[i] !== ' ' && line[i - 1] === ' ' && line[i - 2] === ' ') offsets.push(i);
  return offsets;
}

// upstream: tableprinter_test.go TestPrintTable_ConsistentAlignmentAcrossFlushes
describe('TestPrintTable_ConsistentAlignmentAcrossFlushes', () => {
  const flushInterval = 100; // upstream: tableprinter.go flushInterval
  const rowCount = flushInterval * 2 + flushInterval / 2;
  const shortName = 'a';
  const longName = 'a-name-that-is-significantly-wider';
  const buildTable = () =>
    table(
      [
        { name: 'Name', type: 'string' },
        { name: 'Status', type: 'string' },
        { name: 'Age', type: 'string' },
      ],
      Array.from({ length: rowCount }, (_, i) => ({ cells: [i === rowCount - 1 ? longName : shortName, 'Running', '5d'] })),
    );
  const assertAligned = (output: string, expectedLines: number) => {
    const lines = output.replace(/\n+$/, '').split('\n');
    expect(lines.length).toBe(expectedLines);
    const wantStarts = columnStartOffsets(lines[0] as string);
    const misaligned = lines.map((l, i) => ({ i, line: l, starts: columnStartOffsets(l) })).filter((l) => JSON.stringify(l.starts) !== JSON.stringify(wantStarts));
    expect(misaligned).toEqual([]);
  };
  test('WithHeaders', () => {
    assertAligned(printOnce({}, buildTable()), rowCount + 1);
  });
  test('NoHeaders', () => {
    assertAligned(printOnce({ noHeaders: true }, buildTable()), rowCount);
  });
});

// upstream: tableprinter_test.go TestPrintTable_LargeRowCount
describe('TestPrintTable_LargeRowCount', () => {
  test('500 rows', () => {
    const rowCount = 500;
    const t = table(
      [
        { name: 'Name', type: 'string' },
        { name: 'Status', type: 'string' },
        { name: 'Age', type: 'string' },
      ],
      Array.from({ length: rowCount }, (_, i) => ({ cells: [`pod-${i}`, 'Running', '5d'] })),
    );
    const out = printOnce({}, t);
    expect(out.split('\n').length - 1).toBe(rowCount + 1);
    expect(out).toContain('pod-0');
    expect(out).toContain(`pod-${rowCount - 1}`);
  });
});

// upstream: tableprinter_test.go TestStringPrinting (appendCellValue: cut at a break character
// with "...", terminal escapes made visible by WriteEscaped).
describe('TestStringPrinting', () => {
  const cols: Col[] = [
    { name: 'Name', type: 'string' },
    { name: 'Age', type: 'string' },
    { name: 'Description', type: 'string' },
  ];
  test('multiline string', () => {
    expect(printOnce({}, table(cols, [{ cells: ['test1', '20h', 'This is first line\nThis is second line\nThis is third line\nand another one\n'] }]))).toBe(`NAME    AGE   DESCRIPTION
test1   20h   This is first line...
`);
  });
  test('lengthy string', () => {
    const long = 'This is first line which is long and goes for on and on and on an on and on and on and on and on and on and on and on and on and on and on';
    expect(printOnce({}, table(cols, [{ cells: ['test1', '20h', long] }]))).toBe(`NAME    AGE   DESCRIPTION
test1   20h   ${long}
`);
  });
  test('lengthy string + newline', () => {
    const v = 'This is first\n line which is long and goes for on and on and on an on and on and on and on and on and on and on and on and on and on and on';
    expect(printOnce({}, table(cols, [{ cells: ['test1', '20h', v] }]))).toBe(`NAME    AGE   DESCRIPTION
test1   20h   This is first...
`);
  });
  test('terminal special character, escaped', () => {
    expect(printOnce({}, table([{ name: 'Name', type: 'string' }], [{ cells: ['test1\x1b'] }]))).toBe('NAME\ntest1^[\n');
  });
});

// upstream: tableprinter_test.go TestUnknownTypePrinting is skipped: it prints a Go type that is
// neither a Table nor has object metadata; every object here is JSON, so there is no such input.

// ---- get_test.go: the printing of kubectl get ----

// upstream: get_test.go podColumns, podTableObjBody (a meta.k8s.io/v1beta1 Table, one row per pod
// with the cells below and the encoded pod as the row's object), cmdtesting.TestData.
const podColumns: Col[] = [
  { name: 'Name', type: 'string', format: 'name' },
  { name: 'Ready', type: 'string' },
  { name: 'Status', type: 'string' },
  { name: 'Restarts', type: 'integer' },
  { name: 'Age', type: 'string' },
  { name: 'IP', type: 'string', priority: 1 },
  { name: 'Node', type: 'string', priority: 1 },
  { name: 'Nominated Node', type: 'string', priority: 1 },
  { name: 'Readiness Gates', type: 'string', priority: 1 },
];
const podJson = (name: string, rv: string): Json => ({
  kind: 'Pod',
  apiVersion: 'v1',
  metadata: { name, namespace: 'test', resourceVersion: rv, creationTimestamp: null },
  spec: { restartPolicy: 'Always', terminationGracePeriodSeconds: 30, dnsPolicy: 'ClusterFirst', securityContext: {}, enableServiceLinks: true },
  status: {},
});
const podTableObjBody = (...pods: [string, string][]): Json =>
  table(
    podColumns,
    pods.map(([name, rv]) => ({ cells: [name, '0/0', '', 0, '<unknown>', '<none>', '<none>', '<none>', '<none>'], object: podJson(name, rv) })),
    'meta.k8s.io/v1beta1',
  );
// upstream: get_test.go serviceTableObjBody
const serviceTableObjBody = (...names: string[]): Json =>
  table(
    [
      { name: 'Name', type: 'string', format: 'name' },
      { name: 'Type', type: 'string' },
      { name: 'Cluster-IP', type: 'string' },
      { name: 'External-IP', type: 'string' },
      { name: 'Port(s)', type: 'string' },
      { name: 'Age', type: 'string' },
    ],
    names.map((name) => ({
      cells: [name, 'ClusterIP', '<none>', '<none>', '<none>', '<unknown>'],
      object: { kind: 'Service', apiVersion: 'v1', metadata: { name, namespace: 'test', resourceVersion: '12', creationTimestamp: null }, spec: { type: 'ClusterIP', sessionAffinity: 'None' }, status: { loadBalancer: {} } },
    })),
  );

type Mapping = { kind: { group: string; kind: string }; objects: Json[] };

/**
 * get.go Run's printing loop: a new printer per mapping (resource), the writer flushed and its
 * remembered widths reset when the mapping changes (a fresh writer here), and an empty line
 * before the next output (separatorWriterWrapper) when it is not the first mapping, headers are
 * on and something was written. A mapping whose list was empty has no infos and is not visited.
 */
function getRun(mappings: Mapping[], options: Partial<PrintOptions>): string {
  const noHeaders = options.noHeaders ?? false;
  let out = '';
  let lastMapping = false;
  let ready = false;
  for (const m of mappings) {
    if (m.objects.length === 0) continue;
    if (lastMapping && !noHeaders && out.length > 0) ready = true;
    const p = createTablePrinter(opts({ ...options, kind: m.kind }));
    lastMapping = true;
    for (const o of m.objects) p.add(o);
    const text = p.flush();
    if (text !== '' && ready) {
      out += '\n';
      ready = false;
    }
    out += text;
  }
  return out;
}

// upstream: get_test.go TestGetTableObjectsShowKind (`kubectl get pods foo --show-kind`)
describe('TestGetTableObjectsShowKind', () => {
  test('pod/foo', () => {
    expect(getRun([{ kind: { group: '', kind: 'Pod' }, objects: [podTableObjBody(['foo', '10'])] }], { withKind: true })).toBe(`NAME      READY   STATUS   RESTARTS   AGE
pod/foo   0/0              0          <unknown>
`);
  });
});

// upstream: get_test.go TestGetMultipleTableResourceTypesShowKinds (`kubectl get all`: several
// kinds, so printWithKind; only pods and services have items).
describe('TestGetMultipleTableResourceTypesShowKinds', () => {
  test('pods, then services after an empty line', () => {
    const empty = (group: string, kind: string): Mapping => ({ kind: { group, kind }, objects: [] });
    const mappings: Mapping[] = [
      { kind: { group: '', kind: 'Pod' }, objects: [podTableObjBody(['foo', '10'], ['bar', '11'])] },
      empty('', 'ReplicationController'),
      { kind: { group: '', kind: 'Service' }, objects: [serviceTableObjBody('baz')] },
      empty('apps', 'StatefulSet'),
      empty('autoscaling', 'HorizontalPodAutoscaler'),
      empty('batch', 'Job'),
      empty('batch', 'CronJob'),
      empty('apps', 'DaemonSet'),
      empty('apps', 'Deployment'),
      empty('apps', 'ReplicaSet'),
    ];
    expect(getRun(mappings, { withKind: true })).toBe(`NAME      READY   STATUS   RESTARTS   AGE
pod/foo   0/0              0          <unknown>
pod/bar   0/0              0          <unknown>

NAME          TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
service/baz   ClusterIP   <none>       <none>        <none>    <unknown>
`);
  });
});

// upstream: get_test.go TestGetTableObjectsShowLabels (`kubectl get pods foo --show-labels`)
describe('TestGetTableObjectsShowLabels', () => {
  test('a pod without labels', () => {
    expect(getRun([{ kind: { group: '', kind: 'Pod' }, objects: [podTableObjBody(['foo', '10'])] }], { showLabels: true })).toBe(`NAME   READY   STATUS   RESTARTS   AGE         LABELS
foo    0/0              0          <unknown>   <none>
`);
  });
});

// upstream: get_test.go TestWatchResourceTable (`kubectl get pods -w`). get.go watch: one printer
// and one writer; the list (a Table, wrapped in a v1.List by Result.Object, so isList) is printed
// and flushed, then each event's Table is printed and flushed. The first event repeats the column
// definitions (no new header, they are DeepEqual), the second has none (the last ones are used).
describe('TestWatchResourceTable', () => {
  test('the list, then two events', () => {
    const columns: Col[] = [
      { name: 'Name', type: 'string', format: 'name', description: 'the name' },
      { name: 'Active', type: 'boolean', description: 'active' },
    ];
    const pod = (name: string, rv: string): Json => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'test', resourceVersion: rv, creationTimestamp: null } });
    const listTable = table(columns, [{ cells: ['a', true], object: pod('a', '10') }, { cells: ['b', true], object: pod('b', '20') }], 'meta.k8s.io/v1beta1');
    const events = [table(columns, [{ cells: ['a', false], object: pod('a', '30') }], 'meta.k8s.io/v1beta1'), table([], [{ cells: ['b', false], object: pod('b', '40') }])];
    const p = createTablePrinter(opts());
    p.add(listTable);
    let out = p.flush();
    for (const e of events) {
      p.add(e);
      out += p.flush();
    }
    expect(out).toBe(`NAME   ACTIVE
a      true
b      true
a      false
b      false
`);
  });
});

// ---- own cases, from upstream behavior ----

describe('own cases', () => {
  const twoColumns: Col[] = [
    { name: 'Name', type: 'string', format: 'name' },
    { name: 'Ready', type: 'string' },
  ];
  const labelled = (labels: Record<string, string>): Json => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'x', namespace: 'ns', labels } });

  // upstream: tableprinter.go formatLabelHeaders (the last "/" segment, upper-cased),
  // appendLabelCells (itemLabels[key]: a missing label is "").
  test('-L: header is the upper-cased last path segment, a missing label is an empty cell', () => {
    const t = table(twoColumns, [
      { cells: ['a', '1/1'], object: labelled({ 'example.com/tier': 'web' }) },
      { cells: ['bb', '0/1'], object: labelled({}) },
    ]);
    expect(JSON.stringify(printOnce({ columnLabels: ['example.com/tier'] }, t))).toBe(JSON.stringify('NAME   READY   TIER\na      1/1     web\nbb     0/1     \n'));
  });

  // upstream: tableprinter.go decorateTable: a row without an object gets a nil NAMESPACE cell and
  // nil cells appended by `for j := 0; j < width-len(row.Cells); j++`, which re-reads the growing
  // length: with two -L columns only one cell is appended.
  test('-L: a row without an object gets empty cells (as many as upstream loop appends)', () => {
    const t = table(twoColumns, [{ cells: ['a', '1/1'], object: labelled({ 'example.com/tier': 'web', 'topology.kubernetes.io/zone': 'z1' }) }, { cells: ['c', '0/1'], object: null }]);
    expect(JSON.stringify(printOnce({ columnLabels: ['example.com/tier', 'topology.kubernetes.io/zone'] }, t))).toBe(
      JSON.stringify('NAME   READY   TIER   ZONE\na      1/1     web    z1\nc      0/1     \n'),
    );
  });

  test('WithNamespace: a row without an object has an empty NAMESPACE cell', () => {
    const t = table(twoColumns, [{ cells: ['a', '1/1'] }]);
    expect(JSON.stringify(printOnce({ withNamespace: true }, t))).toBe(JSON.stringify('NAMESPACE   NAME   READY\n            a      1/1\n'));
  });

  // upstream: tableprinter.go cellBreakChars ("\f\n\r"), appendCellValue.
  test('a cell is cut at "\\n", "\\r" or "\\f" with "..."', () => {
    const t = table([{ name: 'Name', type: 'string' }, { name: 'Note', type: 'string' }], [{ cells: ['a', 'one\ntwo'] }, { cells: ['b', 'cr\rlf'] }, { cells: ['c', 'ff\fx'] }]);
    expect(printOnce({}, t)).toBe('NAME   NOTE\na      one...\nb      cr...\nc      ff...\n');
  });

  // upstream: terminal.go terminalEscaper (ESC as "^[").
  test('ESC in a cell is shown as ^[', () => {
    const t = table([{ name: 'Name', type: 'string' }, { name: 'Note', type: 'string' }], [{ cells: ['a', 'x\x1b[31mred'] }]);
    expect(printOnce({}, t)).toBe('NAME   NOTE\na      x^[[31mred\n');
  });

  // upstream: tableprinter.go printTable (no rows: no header, nothing written).
  test('an empty table prints nothing, with and without headers', () => {
    expect(printOnce({}, table(podColumns, []))).toBe('');
    expect(printOnce({ noHeaders: true }, table(podColumns, []))).toBe('');
    expect(printOnce({}, table(podColumns, null))).toBe('');
  });

  // upstream: tableprinter.go printTable padFirstRow: with --no-headers the first row is padded to
  // the widest cell of each column, so the first 100-row flush already has the final widths.
  test('--no-headers pads the first row to the widest cells across a 100-row flush', () => {
    const longName = 'a-much-longer-name-after-the-flush';
    const t = table(
      [
        { name: 'Name', type: 'string' },
        { name: 'Status', type: 'string' },
        { name: 'Age', type: 'string' },
      ],
      Array.from({ length: 101 }, (_, i) => ({ cells: [i === 100 ? longName : 'a', 'Running', '5d'] })),
    );
    const out = printOnce({ noHeaders: true }, t);
    const want = Array.from({ length: 101 }, (_, i) => `${(i === 100 ? longName : 'a').padEnd(longName.length + 3)}${'Running'.padEnd(10)}5d\n`).join('');
    expect(out).toBe(want);
  });

  // upstream: vendor/github.com/liggitt/tabwriter RememberWidths: a column widens for later
  // flushes and never narrows; earlier flushed lines keep their widths.
  test('watch: widths grow across flushes and never shrink', () => {
    const columns: Col[] = [
      { name: 'Name', type: 'string', format: 'name' },
      { name: 'Active', type: 'boolean' },
    ];
    const p = createTablePrinter(opts());
    p.add(table(columns, [{ cells: ['a', true] }]));
    let out = p.flush();
    p.add(table(null, [{ cells: ['a-longer-name', false] }]));
    out += p.flush();
    p.add(table(null, [{ cells: ['b', true] }]));
    out += p.flush();
    expect(out).toBe('NAME   ACTIVE\na      true\na-longer-name   false\nb               true\n');
  });

  // upstream: tableprinter.go PrintObj with an eventType (--output-watch-events) and
  // formattedEventType (ADDED padded to the width of MODIFIED).
  test('watch events: the EVENT column with the padded event types', () => {
    const p = createTablePrinter(opts());
    p.add(table(twoColumns, [{ cells: ['a', '1/1'] }]), { eventType: 'ADDED' });
    let out = p.flush();
    p.add(table(null, [{ cells: ['a', '0/1'] }]), { eventType: 'MODIFIED' });
    out += p.flush();
    p.add(table(null, [{ cells: ['a', '0/1'] }]), { eventType: 'DELETED' });
    out += p.flush();
    expect(JSON.stringify(out)).toBe(JSON.stringify('EVENT      NAME   READY\nADDED      a      1/1\nMODIFIED   a      0/1\nDELETED    a      0/1\n'));
  });

  // Several PrintObj calls into bytes.Buffers (upstream's PrintObj wraps each in its own tab writer
  // and flushes it): one printer, a fresh writer per call. The header prints once; widths are not
  // remembered between calls.
  test('one printer, a fresh tab writer per PrintObj (bytes.Buffer)', () => {
    const p = newHumanReadablePrinter(opts());
    const columns: Col[] = [
      { name: 'Name', type: 'string', format: 'name' },
      { name: 'Ready', type: 'string' },
    ];
    let out = '';
    for (const t of [table(columns, [{ cells: ['a-long-name', '1/1'] }]), table(columns, [{ cells: ['b', '1/1'] }])]) {
      const w = newTabWriter(GET_TABWRITER);
      out += printObj(p, t, w);
      out += tabFlush(w);
    }
    expect(out).toBe('NAME          READY\na-long-name   1/1\nb     1/1\n');
  });
});
