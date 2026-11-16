// What every server-side printer shares: reading the stored JSON as the Go printers read their
// typed structs (a missing field is the zero value), the options, and the column constructor.
// upstream: pkg/printers/tablegenerator.go GenerateOptions; pkg/printers/internalversion/printers.go
// layoutContainerCells, formatEventSource, firstNonEmpty.

import type { Millis } from '@simlab/kernel';
import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { translateTimestampSince } from './duration.ts';
import type { TableColumnDefinition, TableRow } from './types.ts';

/** printers.GenerateOptions, plus the clock the ages are computed from. */
export type GenerateOptions = {
  noHeaders: boolean;
  /** The API server always generates wide rows (pkg/printers/storage/storage.go ConvertToTable). */
  wide: boolean;
  now: Millis;
};

/** A print function: the rows of one object (a list is printed item by item). */
export type PrintFunc = (obj: JsonObject, o: GenerateOptions) => TableRow[];

export type PrintHandler = {
  columns: TableColumnDefinition[];
  print: PrintFunc;
};

export function column(name: string, type: string, description: string, extra: { format?: string; priority?: number } = {}): TableColumnDefinition {
  return { name, type, format: extra.format ?? '', description, priority: extra.priority ?? 0 };
}

export const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
export const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);
export const bool = (v: Json | undefined): boolean => v === true;
export const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
export const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
export const objs = (v: Json | undefined): JsonObject[] => arr(v).filter(isObject);
export const strs = (v: Json | undefined): string[] => arr(v).map(str);
/** A map[string]string field. */
export const strMap = (v: Json | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(v))) out[k] = str(x);
  return out;
};

export const metadata = (o: JsonObject): JsonObject => obj(o.metadata);
export const nameOf = (o: JsonObject): string => str(metadata(o).name);
export const age = (o: JsonObject, opts: GenerateOptions): string => translateTimestampSince(metadata(o).creationTimestamp, opts.now);

/** layoutContainerCells: names and images joined with commas. */
export function layoutContainerCells(containers: JsonObject[]): [string, string] {
  return [containers.map((c) => str(c.name)).join(','), containers.map((c) => str(c.image)).join(',')];
}

export const firstNonEmpty = (...ss: string[]): string => ss.find((s) => s.length > 0) ?? '';

/** formatEventSource: component, and ", instance" when there is one. */
export function formatEventSource(source: JsonObject, reportingController: string, reportingInstance: string): string {
  const component = firstNonEmpty(str(source.component), reportingController);
  const instance = firstNonEmpty(str(source.host), reportingInstance);
  return instance.length === 0 ? component : `${component}, ${instance}`;
}

/** A row of one object; `object` is replaced per includeObject by the API server (asTable). */
export const row = (o: JsonObject, cells: Json[]): TableRow => ({ cells, object: o });

/** Go's strings.ToLower / ToUpper for the ASCII names these tables hold. */
export const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
