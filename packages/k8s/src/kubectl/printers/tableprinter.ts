// kubectl's human-readable printer over the API server's Tables: the decorations (NAMESPACE
// column, kind/name prefixes, -L label columns, LABELS), which columns show (priority 0, or all
// with -o wide), headers once per column set, and the cell text written into the tab writer.
// upstream: staging/src/k8s.io/cli-runtime/pkg/printers/tableprinter.go HumanReadablePrinter.PrintObj,
//   printTable, appendCellValue, addColumns, decorateTable, printRowsForHandlerEntry, printRows,
//   formatLabelHeaders, formatShowLabelsHeader, labelValues, appendLabelCells, printObjectMeta,
//   formatEventType; terminal.go cellSpecialChars, WriteEscaped (terminalEscaper);
//   interface.go PrintOptions; staging/src/k8s.io/kubectl/pkg/cmd/get/table_printer.go
//   decodeIntoTable (row objects decode as unstructured; null stays nil);
//   staging/src/k8s.io/apimachinery/pkg/labels/labels.go FormatLabels.
//
// The printer's state is plain data, so a `kubectl get -w` process can keep it in its record.

import type { Millis } from '@simlab/kernel';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { formatLabels } from '../../apimachinery/labels.ts';
import { translateTimestampSince } from '../../printers/duration.ts';
import { isTable, type Table, type TableColumnDefinition, type TableRow } from '../../printers/types.ts';
import { goLower, goSprint, goSprintS, goUpper, utf8Length } from './gofmt.ts';
import { newTabWriter, tabFlush, tabWrite, GET_TABWRITER, type TabWriterState } from './tabwriter.ts';

export type GroupKind = { group: string; kind: string };

/** printers.PrintOptions as `kubectl get` fills them (humanreadable_flags.go ToPrinter). */
export type PrintOptions = {
  noHeaders: boolean;
  /** A NAMESPACE column first: -A on a namespaced resource. */
  withNamespace: boolean;
  /** `kind/name` in the name column: --show-kind, or several kinds in one get. */
  withKind: boolean;
  /** -o wide: columns of every priority. */
  wide: boolean;
  /** --show-labels: a LABELS column last. */
  showLabels: boolean;
  /** The mapping's GroupKind (`{group: 'apps', kind: 'Deployment'}` prints `deployment.apps/`). */
  kind: GroupKind;
  /** -L: one column per label key. */
  columnLabels: string[];
};

export type HumanReadablePrinterState = {
  options: PrintOptions;
  /** The column definitions last received; tables in later watch events may come without them. */
  lastColumns: TableColumnDefinition[] | null;
  printedHeaders: boolean;
  /** The handler last used for a non-Table object (client-side printing): only the default one. */
  lastType: 'default' | null;
};

// upstream: tableprinter.go cellBreakChars, flushInterval; terminal.go cellSpecialChars.
const CELL_BREAK = ['\f', '\n', '\r'];
const ESC = String.fromCharCode(0x1b);
const CELL_SPECIAL = [...CELL_BREAK, ESC];
const FLUSH_INTERVAL = 100;

const FORMATTED_EVENT_TYPE: Readonly<Record<string, string>> = {
  ADDED: 'ADDED   ',
  MODIFIED: 'MODIFIED',
  DELETED: 'DELETED ',
  ERROR: 'ERROR   ',
};
const formatEventType = (t: string): string => (Object.hasOwn(FORMATTED_EVENT_TYPE, t) ? (FORMATTED_EVENT_TYPE[t] as string) : t);

const kindEmpty = (gk: GroupKind): boolean => gk.group === '' && gk.kind === '';
/** schema.GroupKind.String(). */
const kindString = (gk: GroupKind): string => (gk.group === '' ? gk.kind : `${gk.kind}.${gk.group}`);

export function newHumanReadablePrinter(options: PrintOptions): HumanReadablePrinterState {
  return { options: { ...options, kind: { ...options.kind }, columnLabels: [...options.columnLabels] }, lastColumns: null, printedHeaders: false, lastType: null };
}

/** terminalEscaper: ESC as ^[, CR as \r. */
const escapeTerminal = (s: string): string => s.split(ESC).join('^[').split('\r').join('\\r');

/** appendCellValue: cut at a line break (with "..."), terminal escapes made visible. */
function cellText(val: string): string {
  if (!CELL_SPECIAL.some((c) => val.includes(c))) return val;
  const at = Math.min(...CELL_BREAK.map((c) => val.indexOf(c)).filter((i) => i >= 0));
  return Number.isFinite(at) ? `${escapeTerminal(val.slice(0, at))}...` : escapeTerminal(val);
}

/** meta.Accessor of a row's object: any decoded object (PartialObjectMetadata or full); null is nil. */
function accessor(o: Json | undefined): { namespace: string; labels: Record<string, string> } | undefined {
  if (!isObject(o)) return undefined;
  const m = isObject(o.metadata) ? o.metadata : {};
  const labels: Record<string, string> = {};
  if (isObject(m.labels)) for (const [k, v] of Object.entries(m.labels)) if (typeof v === 'string') labels[k] = v;
  return { namespace: typeof m.namespace === 'string' ? m.namespace : '', labels };
}

/** formatLabelHeaders: the last path segment of each -L key, upper-cased. */
export function formatLabelHeaders(columnLabels: readonly string[]): string[] {
  return columnLabels.map((l) => goUpper(l.split('/').pop() as string));
}

/** appendLabelCells / labelValues: a missing -L label is an empty cell; LABELS is FormatLabels. */
function labelCells(labels: Record<string, string>, o: PrintOptions): string[] {
  const out = o.columnLabels.map((k) => (Object.hasOwn(labels, k) ? (labels[k] as string) : ''));
  if (o.showLabels) out.push(formatLabels(labels));
  return out;
}

/** decorateTable: NAMESPACE first, -L columns and LABELS last, `kind/` before names. */
function decorateTable(table: { columnDefinitions: TableColumnDefinition[]; rows: TableRow[] }, o: PrintOptions): void {
  const width = table.columnDefinitions.length + o.columnLabels.length + (o.withNamespace ? 1 : 0) + (o.showLabels ? 1 : 0);
  let columns = table.columnDefinitions;
  let nameColumn = -1;
  if (o.withKind && !kindEmpty(o.kind)) nameColumn = columns.findIndex((c) => c.format === 'name' && c.type === 'string');
  if (width !== table.columnDefinitions.length) {
    const plain = (name: string): TableColumnDefinition => ({ name, type: 'string', format: '', description: '', priority: 0 });
    columns = [...(o.withNamespace ? [plain('Namespace')] : []), ...table.columnDefinitions, ...formatLabelHeaders(o.columnLabels).map(plain), ...(o.showLabels ? [plain('Labels')] : [])];
  }
  const includeLabels = o.columnLabels.length > 0 || o.showLabels;
  if (includeLabels || o.withNamespace || nameColumn !== -1) {
    for (const row of table.rows) {
      if (nameColumn !== -1 && nameColumn < row.cells.length) row.cells[nameColumn] = `${goLower(kindString(o.kind))}/${goSprintS(row.cells[nameColumn])}`;
      const m = accessor(row.object);
      if (m === undefined) {
        // No accessor: empty cells. The loop re-reads the length as it grows, as upstream's does.
        if (o.withNamespace) row.cells = [null, ...row.cells];
        for (let j = 0; j < width - row.cells.length; j++) row.cells.push(null);
        continue;
      }
      if (o.withNamespace) row.cells = [m.namespace, ...row.cells];
      if (includeLabels) row.cells.push(...labelCells(m.labels, o));
    }
  }
  table.columnDefinitions = columns;
}

const cellString = (cell: Json): string => (typeof cell === 'string' ? cell : goSprint(cell));

/** printTable: the header (unless no rows or --no-headers) and the visible cells of each row. */
function printTable(table: { columnDefinitions: TableColumnDefinition[]; rows: TableRow[] }, w: TabWriterState, o: PrintOptions): string {
  const cols = table.columnDefinitions;
  const visible = (i: number) => o.wide || (cols[i] as TableColumnDefinition).priority === 0;
  let out = '';
  // Pre-scan: the widest cell of each column in bytes, to pad the header (or the first row with
  // --no-headers) so the first flush already has the final widths.
  let maxCellWidths: number[] = [];
  if (table.rows.length > 0) {
    maxCellWidths = cols.map(() => 0);
    for (const row of table.rows) {
      for (let i = 0; i < row.cells.length && i < cols.length; i++) {
        const cell = row.cells[i] as Json;
        if (!visible(i) || cell === null) continue;
        const l = utf8Length(cellString(cell));
        if (l > (maxCellWidths[i] as number)) maxCellWidths[i] = l;
      }
    }
  }
  let lastVisibleCol = -1;
  cols.forEach((_, i) => {
    if (visible(i)) lastVisibleCol = i;
  });

  if (!o.noHeaders) {
    if (table.rows.length === 0) return '';
    const parts: string[] = [];
    cols.forEach((c, i) => {
      if (!visible(i)) return;
      let name = goUpper(c.name);
      if (i !== lastVisibleCol && i < maxCellWidths.length) name += ' '.repeat(Math.max(0, (maxCellWidths[i] as number) - utf8Length(name)));
      parts.push(name);
    });
    out += tabWrite(w, `${parts.join('\t')}\n`);
  }

  const padFirstRow = o.noHeaders && maxCellWidths.length > 0;
  table.rows.forEach((row, ri) => {
    const parts: string[] = [];
    for (let i = 0; i < row.cells.length; i++) {
      // More cells than column definitions: the rest is not printed (issue 66379).
      if (i >= cols.length) break;
      if (!visible(i)) continue;
      const cell = row.cells[i] as Json;
      let text = '';
      let cellLen = 0;
      if (cell !== null) {
        const s = cellString(cell);
        cellLen = utf8Length(s);
        text = cellText(s);
      }
      if (padFirstRow && ri === 0 && i !== lastVisibleCol && i < maxCellWidths.length) text += ' '.repeat(Math.max(0, (maxCellWidths[i] as number) - cellLen));
      parts.push(text);
    }
    out += tabWrite(w, `${parts.join('\t')}\n`);
    if ((ri + 1) % FLUSH_INTERVAL === 0) out += tabFlush(w);
  });
  return out;
}

export type PrintExtra = {
  /** --output-watch-events: an EVENT column first (the object came in a WatchEvent). */
  eventType?: string;
  /** The client's clock, for ages of objects that are not Tables (client-side printing). */
  now?: Millis;
};

/**
 * HumanReadablePrinter.PrintObj into a tab writer: returns what the writer emitted meanwhile
 * (only at a 100-row flush or a one-column line; the rest comes out when the caller flushes).
 */
export function printObj(p: HumanReadablePrinterState, obj: Json, w: TabWriterState, extra: PrintExtra = {}): string {
  if (isTable(obj)) return printTableObject(p, obj as unknown as Table, w, extra.eventType);
  return printDefault(p, obj, w, extra);
}

function printTableObject(p: HumanReadablePrinterState, input: Table, w: TabWriterState, eventType: string | undefined): string {
  const given = input.columnDefinitions ?? [];
  const local: PrintOptions = { ...p.options };
  // No headers if the table has no column definitions or the same as the last ones printed.
  if (p.printedHeaders && (given.length === 0 || jsonEqual(given, p.lastColumns))) local.noHeaders = true;
  let columns: TableColumnDefinition[];
  if (given.length === 0) {
    // Watch events after the first come without column definitions: use the last ones.
    columns = p.lastColumns ?? [];
  } else {
    columns = given;
    if (!jsonEqual(given, p.lastColumns)) {
      p.lastColumns = cloneJson(given);
      p.printedHeaders = false;
    }
  }
  const rows = (input.rows ?? []).map((r) => ({ ...r, cells: [...r.cells] }));
  if (rows.length > 0) p.printedHeaders = true;
  const table = { columnDefinitions: columns.map((c) => ({ ...c })), rows };
  decorateTable(table, local);
  if (eventType !== undefined && eventType !== '') {
    // addColumns(beginning, …): the EVENT column and its cell before everything else.
    table.columnDefinitions = [{ name: 'Event', type: 'string', format: '', description: '', priority: 0 }, ...table.columnDefinitions];
    for (const r of table.rows) r.cells = [formatEventType(eventType), ...r.cells];
  }
  return printTable(table, w, local);
}

/**
 * An object that is not a Table (the server printed nothing): the default handler's NAME and AGE
 * columns, computed on the client (printObjectMeta, printRowsForHandlerEntry, printRows). Objects
 * arrive unstructured, so a Status is printed like any object, as upstream's type switch does.
 */
function printDefault(p: HumanReadablePrinterState, obj: Json, w: TabWriterState, extra: PrintExtra): string {
  const o = p.options;
  let out = '';
  const includeHeaders = p.lastType !== 'default' && !o.noHeaders;
  if (p.lastType !== null && p.lastType !== 'default' && !o.noHeaders) out += tabWrite(w, '\n');
  const items: JsonObject[] = isObject(obj) && Array.isArray(obj.items) ? obj.items.filter(isObject) : isObject(obj) ? [obj] : [];
  if (includeHeaders) {
    let headers = ['NAME', 'AGE', ...formatLabelHeaders(o.columnLabels), ...(o.showLabels ? ['LABELS'] : [])];
    if (o.withNamespace) headers = ['NAMESPACE', ...headers];
    if (extra.eventType) headers = ['EVENT', ...headers];
    out += tabWrite(w, `${headers.join('\t')}\n`);
  }
  for (const item of items) {
    const m = isObject(item.metadata) ? item.metadata : {};
    const name = typeof m.name === 'string' ? m.name : '';
    let line = '';
    if (extra.eventType) line += `${formatEventType(extra.eventType)}\t`;
    if (o.withNamespace) line += `${accessor(item)?.namespace ?? ''}\t`;
    line += o.withKind && !kindEmpty(o.kind) ? `${goLower(kindString(o.kind))}/${name}` : name;
    line += `\t${translateTimestampSince(m.creationTimestamp, extra.now ?? 0)}`;
    if (o.columnLabels.length > 0 || o.showLabels) for (const v of labelCells(accessor(item)?.labels ?? {}, o)) line += `\t${v}`;
    out += tabWrite(w, `${line}\n`);
  }
  p.lastType = 'default';
  return out;
}

// ---- the printer `kubectl get` uses ----

export type TablePrinterState = {
  printer: HumanReadablePrinterState;
  writer: TabWriterState;
  /** Output the writer emitted since the last flush (a 100-row flush, a one-column line). */
  pending: string;
};

export interface TablePrinter {
  /** Plain data: keep it in a process record and continue with `restoreTablePrinter`. */
  readonly state: TablePrinterState;
  /** PrintObj into the printer's writer; nothing is returned until `flush`. */
  add(obj: Json, extra?: PrintExtra): void;
  /** Flushes the writer: the aligned text since the last flush ('' when nothing was printed). */
  flush(): string;
}

/**
 * One printer and one tab writer (RememberWidths) for a resource, as `kubectl get` keeps for one
 * mapping: tables added between flushes align together under one header; headers print again
 * only when the column definitions change; widths never shrink across flushes (`get -w`).
 */
export function createTablePrinter(options: PrintOptions): TablePrinter {
  return restoreTablePrinter({ printer: newHumanReadablePrinter(options), writer: newTabWriter(GET_TABWRITER), pending: '' });
}

export function restoreTablePrinter(state: TablePrinterState): TablePrinter {
  return {
    state,
    add(obj, extra) {
      state.pending += printObj(state.printer, obj, state.writer, extra);
    },
    flush() {
      const out = state.pending + tabFlush(state.writer);
      state.pending = '';
      return out;
    },
  };
}
