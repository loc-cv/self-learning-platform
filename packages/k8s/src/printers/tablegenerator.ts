// Table conversion on the API server: a kind's printer when it has one, else the default
// convertor, then the includeObject policy applied to each row.
// upstream: pkg/printers/tablegenerator.go HumanReadableGenerator.GenerateTable;
// pkg/printers/storage/storage.go TableConvertor.ConvertToTable (always Wide);
// staging/src/k8s.io/apiserver/pkg/registry/rest/table.go defaultTableConvertor;
// staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go asTable.

import type { Millis } from '@simlab/kernel';
import { cloneJson, type Json, type JsonObject } from '../apimachinery/json.ts';
import { formatTime } from '../apimachinery/time.ts';
import { doc } from './descriptions.ts';
import { timestampMicros } from './duration.ts';
import { metadata, nameOf, type GenerateOptions } from './helpers.ts';
import { printHandler } from './handlers.ts';
import { TABLE_API_VERSION, type Table, type TableColumnDefinition, type TableRow } from './types.ts';

/** What is converted: one object, or a list's items with its metadata. */
export type TableSource = { object: JsonObject } | { items: JsonObject[]; resourceVersion: string; continue?: string; remainingItemCount?: number };

export type TableConvertOptions = {
  /** Set by the watch encoder after the first event (metav1.TableOptions.NoHeaders). */
  noHeaders: boolean;
  now: Millis;
};

function listMeta(src: TableSource): Table['metadata'] {
  if ('object' in src) {
    const rv = metadata(src.object).resourceVersion;
    return typeof rv === 'string' && rv !== '' ? { resourceVersion: rv } : {};
  }
  return {
    ...(src.resourceVersion !== '' ? { resourceVersion: src.resourceVersion } : {}),
    ...(src.continue ? { continue: src.continue } : {}),
    ...(src.remainingItemCount !== undefined ? { remainingItemCount: src.remainingItemCount } : {}),
  };
}

/**
 * ConvertToTable for objects of `group`/`kind` (the group of the stored type: events.k8s.io
 * Events are printed as core Events). Rows carry the source object in `object`; `asTable` decides
 * what the client gets.
 */
export function convertToTable(group: string, kind: string, src: TableSource, opts: TableConvertOptions): Table {
  const handler = printHandler(group, kind);
  if (!handler) return defaultConvertToTable(src, opts);
  const g: GenerateOptions = { noHeaders: opts.noHeaders, wide: true, now: opts.now };
  const objects = 'object' in src ? [src.object] : src.items;
  // printXList: make([]TableRow, 0, n), so an empty list has `"rows": []`.
  const rows: TableRow[] = objects.flatMap((o) => handler.print(o, g));
  // GenerateTable with Wide: every column, priority ones included; none with NoHeaders.
  const columns: TableColumnDefinition[] | null = opts.noHeaders ? null : handler.columns.map((c) => ({ ...c }));
  return { kind: 'Table', apiVersion: TABLE_API_VERSION, metadata: listMeta(src), columnDefinitions: columns, rows };
}

/** rest.NewDefaultTableConvertor: Name and Created At (RFC 3339, UTC). */
export function defaultConvertToTable(src: TableSource, opts: TableConvertOptions): Table {
  const objects = 'object' in src ? [src.object] : src.items;
  const rows: TableRow[] | null =
    objects.length === 0
      ? null
      : objects.map((o) => {
          const t = timestampMicros(metadata(o).creationTimestamp);
          // metav1.Time{}.UTC().Format(time.RFC3339) of the zero time.
          return { cells: [nameOf(o), t === undefined ? '0001-01-01T00:00:00Z' : formatTime(t)], object: o };
        });
  const columns: TableColumnDefinition[] | null = opts.noHeaders
    ? null
    : [
        { name: 'Name', type: 'string', format: 'name', description: doc('ObjectMeta.name'), priority: 0 },
        { name: 'Created At', type: 'date', format: '', description: doc('ObjectMeta.creationTimestamp'), priority: 0 },
      ];
  return { kind: 'Table', apiVersion: TABLE_API_VERSION, metadata: listMeta(src), columnDefinitions: columns, rows };
}

/**
 * asTable's row loop: `Object` gives the object in the request's version (`toVersioned`),
 * `Metadata` or unset a PartialObjectMetadata, `None` null; anything else is a BadRequest with
 * this message.
 */
export function applyIncludeObject(table: Table, includeObject: string | undefined, toVersioned: (stored: JsonObject) => JsonObject): Table | { badRequest: string } {
  const policy = includeObject ?? '';
  if (!['', 'None', 'Metadata', 'Object'].includes(policy)) return { badRequest: `unrecognized includeObject value: ${JSON.stringify(policy)}` };
  const rows = table.rows?.map((r): TableRow => {
    const source = r.object as JsonObject;
    let object: Json;
    if (policy === 'Object') object = toVersioned(source);
    else if (policy === 'None') object = null;
    else object = { kind: 'PartialObjectMetadata', apiVersion: TABLE_API_VERSION, metadata: cloneJson(metadata(source)) };
    return { cells: r.cells, ...(r.conditions ? { conditions: r.conditions.map((c) => ({ ...c })) } : {}), object };
  });
  return { ...table, rows: rows ?? null };
}
