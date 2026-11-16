// Typed objects (a builder WithScheme, a printer WithTypeSetter): what kubectl decodes manifests and
// answers into when a command works on Go types, and how it prints them. encoding/json writes the
// struct: fields in struct order, omitempty applied, unknown fields gone (`canonical` over the
// vendored Go types); YAML sorts the keys anyway.
//   upstream: staging/src/k8s.io/cli-runtime/pkg/printers/json.go, yaml.go (typed objects);
//             staging/src/k8s.io/cli-runtime/pkg/genericclioptions/print_flags.go ToPrinter

import { canonical, decode } from '../../apimachinery/gojson.ts';
import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { printJson } from '../../apimachinery/yaml/jsonprint.ts';
import { schema } from '../../openapi/schema.ts';
import type { KubectlError } from '../cli/errors.ts';
import { toPrinter, type DryRun } from './helpers.ts';
import { toYaml } from './printing.ts';

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

/** The Go type of an object, from its apiVersion and kind. */
export function typeIdOf(obj: JsonObject): string | undefined {
  return schema().kind(str(obj.apiVersion), str(obj.kind))?.id;
}

/**
 * The object as encoding/json writes its Go type. With `typeId` (a generator built the struct) the
 * object is only canonicalized; without it the object is decoded into the type its apiVersion and
 * kind name and encoded again, apiVersion and kind kept (objects that came from the server or a file).
 */
export function typed(obj: JsonObject, typeId?: string): JsonObject {
  if (typeId !== undefined) return canonical(obj, typeId) as JsonObject;
  const id = typeIdOf(obj);
  if (!id) return obj;
  const r = decode(obj, id);
  const value = (r.error === undefined ? r.value : obj) as JsonObject;
  return canonical({ ...value, apiVersion: obj.apiVersion as Json, kind: obj.kind as Json }, id) as JsonObject;
}

export interface TypedPrinter {
  /** Prints a typed object; `typeId` (e.g. `apps/v1.Deployment`) when the caller knows it, else found from apiVersion and kind. */
  print(obj: JsonObject, typeId?: string): string;
}

/** ToPrinter for typed objects: JSON in struct order; YAML, name and the operation line as for any object. */
export function typedPrinter(output: string, operation: string, dryRun: DryRun, template: string): TypedPrinter | KubectlError {
  const p = toPrinter(output, operation, dryRun, template);
  if ('type' in p) return p;
  const lower = (output === '' && template !== '' ? 'go-template' : output).toLowerCase();
  if (lower === 'json') return { print: (o, id) => printJson(typed(o, id), { sortKeys: false }) };
  if (lower === 'yaml') {
    let count = 0;
    return { print: (o, id) => `${count++ > 0 ? '---\n' : ''}${toYaml(typed(o, id))}` };
  }
  return p;
}
