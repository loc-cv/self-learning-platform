// meta.k8s.io/v1 Table on the wire: what the API server returns for a request with
// `Accept: application/json;as=Table;v=v1;g=meta.k8s.io` and what kubectl's table printer reads.
// upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go Table, TableColumnDefinition,
// TableRow, TableRowCondition, TableOptions, IncludeObjectPolicy.
//
// JSON field order is the Go struct's: kind, apiVersion, metadata, columnDefinitions, rows.
// columnDefinitions and rows have no omitempty: a watch event after the first sends
// `"columnDefinitions": null`, and the default convertor's empty list `"rows": null`.

import type { Json, JsonObject } from '../apimachinery/json.ts';

export type TableColumnDefinition = {
  name: string;
  /** An OpenAPI type: string, integer, number, boolean, date. */
  type: string;
  /** An OpenAPI format; `name` marks the column holding the object's name. */
  format: string;
  description: string;
  /** 0 is shown by default; higher only with -o wide. */
  priority: number;
};

export type TableRowCondition = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
};

export type TableRow = {
  /** Strings, integers, numbers, booleans or null; one per column definition. */
  cells: Json[];
  conditions?: TableRowCondition[];
  /** The object per includeObject: PartialObjectMetadata (default), the full object, or null. */
  object?: Json;
};

export type Table = {
  kind: 'Table';
  apiVersion: 'meta.k8s.io/v1';
  metadata: { resourceVersion?: string; continue?: string; remainingItemCount?: number };
  columnDefinitions: TableColumnDefinition[] | null;
  rows: TableRow[] | null;
};

/** metav1.IncludeObjectPolicy; absent (`""`) means Metadata. */
export type IncludeObjectPolicy = 'None' | 'Metadata' | 'Object';

export const TABLE_API_VERSION = 'meta.k8s.io/v1';

export function isTable(v: Json | undefined): v is Table & JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && v.kind === 'Table' && (v.apiVersion === 'meta.k8s.io/v1' || v.apiVersion === 'meta.k8s.io/v1beta1');
}
