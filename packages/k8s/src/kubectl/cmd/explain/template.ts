// kubectl explain's plaintext template, ported define by define: the output Go's text/template
// produces from templates/plaintext.tmpl over an OpenAPI v3 document. Each function below is one
// `define` (or the main template); whitespace follows the template's trim markers, and each Go
// template construct it relies on is reproduced:
//   - truth (`if`, `with`, `and`, `or`, `not`): false, 0, nil, and empty strings, slices and maps
//     are false (text/template exec.go isTrue); `and`/`or` short-circuit;
//   - `range` over a map visits keys in sorted order (fields are listed alphabetically);
//   - `break` inside `with` inside `range` leaves the innermost range only;
//   - assignment in `with $gvk = …` keeps the value even when it is empty;
//   - `include` renders into a buffer, so output before a failing `include` stays written (the
//     GROUP/KIND/VERSION header of an unknown field);
//   - `printf "%T"` of additionalProperties tells a bool from a schema.
//   upstream: staging/src/k8s.io/kubectl/pkg/explain/v2/templates/plaintext.tmpl
//   upstream: staging/src/k8s.io/kubectl/pkg/explain/v2/funcs.go (throw, wrap, indent, set, dict,
//             contains, first, last, resolveRef); generator.go Render (`unrecognized format`);
//             explain.go printModelDescriptionWithGenerator (the explainError is returned bare)
//   upstream: staging/src/k8s.io/kubectl/pkg/util/term/term_writer.go wordWrapWriter.Write
//             (go-wordwrap WrapString; a limit of 0 writes the text unchanged)

import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { wrapString } from '../../help/wordwrap.ts';

/** The template's `throw`: explainError, which kubectl prints as its message. */
export class ExplainError extends Error {}

/** Any other template execution error (`fail`): never expected with the served documents. */
export class TemplateError extends Error {}

export interface Gvr {
  group: string;
  version: string;
  resource: string;
}

export interface RenderInput {
  document: JsonObject;
  gvr: Gvr;
  fieldPath: readonly string[];
  recursive: boolean;
  maxDepth: number;
}

/** What Execute wrote to the writer, and the error it returned, if any. */
export interface Rendered {
  text: string;
  error?: ExplainError | TemplateError;
}

// ---- text/template semantics ----

/** text/template isTrue for values decoded from JSON. */
export function truth(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** `.key` on a map value: the missing key is the zero value. */
function field(v: unknown, key: string): Json | undefined {
  return isObject(v as Json) ? (v as JsonObject)[key] : undefined;
}

/** A map's values in Go's range order: keys sorted. */
function sortedEntries(v: unknown): [string, Json][] {
  if (!isObject(v as Json)) return [];
  const o = v as JsonObject;
  return Object.keys(o)
    .sort()
    .map((k) => [k, o[k] as Json]);
}

/** reflect.DeepEqual of decoded JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a as Json) && isObject(b as Json)) {
    const ka = Object.keys(a as JsonObject);
    const kb = Object.keys(b as JsonObject);
    return ka.length === kb.length && ka.every((k) => k in (b as JsonObject) && deepEqual((a as JsonObject)[k], (b as JsonObject)[k]));
  }
  return false;
}

/** funcs.go contains: a slice holding a deeply equal value. */
function contains(list: unknown, value: unknown): boolean {
  return Array.isArray(list) && list.some((x) => deepEqual(x, value));
}

/** funcs.go indent */
export function indent(amount: number, s: string): string {
  const pad = ' '.repeat(amount);
  return pad + s.split('\n').join('\n' + pad);
}

/** funcs.go wrap: a word-wrap writer of limit `l` (0: unchanged). */
export function wrap(l: number, s: string): string {
  return l === 0 ? s : wrapString(s, l);
}

/** fmt's %v of a decoded JSON value, as text/template prints a value. */
export function goValue(v: unknown): string {
  if (v === undefined || v === null) return '<no value>';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  // The served documents print no numbers (enums are strings); Go's %v of a float64 is not ported.
  if (typeof v === 'number') throw new TemplateError('printing a number');
  if (Array.isArray(v)) return `[${v.map(goInner).join(' ')}]`;
  return `map[${Object.keys(v as JsonObject)
    .sort()
    .map((k) => `${k}:${goInner((v as JsonObject)[k])}`)
    .join(' ')}]`;
}

/** %v of a value inside a map or slice: nil is <nil>. */
function goInner(v: unknown): string {
  return v === null || v === undefined ? '<nil>' : goValue(v);
}

/** funcs.go resolveRef: a fragment-only reference walked through the document, else nil. */
export function resolveRef(ref: unknown, document: JsonObject): JsonObject | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#') || ref.length === 1) return undefined;
  let cur: JsonObject = document;
  for (const k of decodeURIComponent(ref.slice(1)).split('/')) {
    if (k.length === 0) continue;
    const next = cur[k];
    if (!isObject(next as Json)) return undefined;
    cur = next as JsonObject;
  }
  return cur;
}

/** `and .additionalProperties (not (eq "bool" (printf "%T" .additionalProperties)))` */
function mapSchema(s: unknown): Json | undefined {
  const ap = field(s, 'additionalProperties');
  return truth(ap) && typeof ap !== 'boolean' ? ap : undefined;
}

const or = <T>(a: T | undefined, b: T): T => (truth(a) ? (a as T) : b);

// ---- the defines ----

type History = Record<string, number>;

interface Ctx {
  document: JsonObject;
  recursive: boolean;
  maxDepth: number;
}

/** define "typeGuess" */
export function typeGuess(schema: unknown, document: JsonObject): string {
  if (!truth(schema)) throw new TemplateError("expected schema argument to subtemplate 'typeguess'");
  const items = field(schema, 'items');
  if (truth(items)) return `[]${typeGuess(items, document)}`;
  const ap = mapSchema(schema);
  if (ap !== undefined) return `map[string]${typeGuess(ap, document)}`;
  const allOf = field(schema, 'allOf');
  if (truth(allOf) && !truth(field(schema, 'properties')) && Array.isArray(allOf) && allOf.length === 1) return typeGuess(allOf[0], document);
  const ref = field(schema, '$ref');
  if (truth(ref)) {
    const refSchema = resolveRef(ref, document);
    const refType = field(refSchema, 'type');
    if (!truth(refSchema) || !truth(refType) || refType === 'object') {
      const name = String(ref).split('/').at(-1) as string;
      return or(name.split('.').at(-1), 'Object');
    }
    return goValue(refType);
  }
  const t = field(schema, 'type');
  if (t === 'object') return 'Object';
  return truth(t) ? goValue(t) : 'Object';
}

/** define "extractEnum" */
export function extractEnum(schema: unknown, isLongView: boolean, limitArg: number, indentAmount = 0): string {
  const en = field(schema, 'enum');
  if (!truth(schema) || !truth(en) || !Array.isArray(en)) return '';
  const limit = truth(limitArg) ? limitArg : -1;
  let out = isLongView ? 'ENUM:' : '\n' + indent(indentAmount, '') + 'enum: ';
  for (let i = 0; i < en.length; i++) {
    if (limit > -1 && i >= limit) {
      out += ', ....';
      break;
    }
    if (i > 0 && !isLongView) out += ', ';
    else if (isLongView) out += '\n' + indent(4, '');
    const el = en[i];
    out += el === '' ? '""' : goValue(el);
  }
  return out;
}

/** define "description" */
function description(schema: unknown, document: JsonObject): string {
  const s = or(resolveRef(field(schema, '$ref'), document), schema as JsonObject);
  if (!truth(s)) return '';
  let out = '';
  const d = field(s, 'description');
  if (truth(d)) out += goValue(d) + '\n';
  const allOf = field(s, 'allOf');
  if (Array.isArray(allOf)) for (const a of allOf) out += description(a, document);
  const items = field(s, 'items');
  if (truth(items)) out += description(items, document);
  const ap = mapSchema(s);
  if (ap !== undefined) out += description(ap, document);
  return out;
}

/** define "externalDocs" */
function externalDocs(schema: unknown): string {
  const ed = field(schema, 'externalDocs');
  if (!truth(ed)) return '';
  let out = 'EXTERNAL DOCS:\n';
  const d = field(ed, 'description');
  if (truth(d)) out += indent(4, wrap(76, goValue(d))) + '\n';
  const url = field(ed, 'url');
  if (truth(url)) out += indent(4, `URL: ${goValue(url)}`) + '\n';
  return out;
}

/** define "fieldDetail" */
function fieldDetail(name: string, schema: unknown, short: boolean, level: number, document: JsonObject): string {
  const indentAmount = level * 2;
  const fieldSchema = field(field(schema, 'properties'), name);
  let out = indent(indentAmount, name) + '\t<' + typeGuess(fieldSchema, document) + '>';
  if (contains(field(schema, 'required'), name)) out += ' -required-';
  out += extractEnum(fieldSchema, false, 4, indentAmount);
  out += '\n';
  if (!short) {
    out += indent(indentAmount + 2, wrap(78 - indentAmount, goValue(or(field(fieldSchema, 'description'), '<no description>' as Json)))) + '\n';
    const ed = field(fieldSchema, 'externalDocs');
    if (truth(ed)) {
      out += '\n' + indent(indentAmount + 2, 'EXTERNAL DOCS:') + '\n';
      const d = field(ed, 'description');
      if (truth(d)) out += indent(indentAmount + 4, wrap(76 - indentAmount, goValue(d))) + '\n';
      const url = field(ed, 'url');
      if (truth(url)) out += indent(indentAmount + 4, `URL: ${goValue(url)}`) + '\n';
    }
    out += '\n';
  }
  return out;
}

/** define "fieldList" */
function fieldList(c: Ctx, schema: unknown, level: number, history: History | undefined): string {
  const refString = or(field(schema, '$ref'), '' as Json);
  if (truth(refString) && truth((history ?? {})[refString as string])) return '';
  const next: History = { ...history, [goValue(refString)]: 1 };
  const resolved = or(resolveRef(refString, c.document), schema as JsonObject);
  let out = '';
  for (const [k, v] of sortedEntries(field(resolved, 'properties'))) {
    out += fieldDetail(k, resolved, c.recursive, level, c.document);
    if (c.recursive && (c.maxDepth === 0 || level < c.maxDepth)) out += fieldList(c, v, level + 1, next);
  }
  const allOf = field(resolved, 'allOf');
  if (Array.isArray(allOf)) for (const a of allOf) out += fieldList(c, a, level, next);
  const items = field(resolved, 'items');
  if (truth(items)) out += fieldList(c, items, level, next);
  const ap = mapSchema(resolved);
  if (ap !== undefined) out += fieldList(c, ap, level, next);
  return out;
}

/** define "output" */
function output(c: Ctx, schema: unknown, fieldPath: readonly string[], history: History | undefined): string {
  const refString = or(field(schema, '$ref'), '' as Json);
  const next: History = { ...history, [goValue(refString)]: 1 };
  const resolved = or(resolveRef(refString, c.document), schema as JsonObject);
  if (fieldPath.length === 0) {
    let out = 'DESCRIPTION:\n' + indent(4, wrap(76, or(description(resolved, c.document), '<empty>'))) + '\n';
    const ed = externalDocs(resolved);
    if (ed !== '') out += '\n' + ed;
    const fl = fieldList(c, resolved, 1, undefined);
    if (fl !== '') out += 'FIELDS:\n' + fl;
    return out;
  }
  if (truth(refString) && truth(history?.[refString as string])) return '';
  const first = fieldPath[0] as string;
  const props = field(resolved, 'properties');
  if (truth(props) && truth(field(props, first))) {
    const sub = field(props, first);
    let out = '';
    if (fieldPath.length === 1) {
      out += `FIELD: ${first} <${typeGuess(sub, c.document)}>\n`;
      out += extractEnum(sub, true, -1) + '\n';
      out += '\n';
    }
    return out + output(c, sub, fieldPath.slice(1), {});
  }
  const items = field(resolved, 'items');
  if (truth(items)) return output(c, items, fieldPath, next);
  const ap = mapSchema(resolved);
  if (ap !== undefined) return output(c, ap, fieldPath, next);
  const allOf = field(resolved, 'allOf');
  if (Array.isArray(allOf)) {
    for (const a of allOf) {
      const r = output(c, a, fieldPath, next);
      if (r !== '') return r;
    }
  }
  return '';
}

/** define "schema": the first component schema (in key order) with the GVK, rendered. */
function schemaFor(c: Ctx, gvk: Json | undefined, fieldPath: readonly string[]): string {
  for (const [, s] of sortedEntries(field(field(c.document, 'components'), 'schemas'))) {
    if (!contains(field(s, 'x-kubernetes-group-version-kind'), gvk)) continue;
    const r = output(c, s, fieldPath, undefined);
    if (r === '') throw new ExplainError(`error: field "${fieldPath[fieldPath.length - 1] as string}" does not exist`);
    return r;
  }
  return '';
}

/** schema.GroupVersionResource.String */
export function gvrString(g: Gvr): string {
  return `${g.group}/${g.version}, Resource=${g.resource}`;
}

/** The main template. */
export function renderPlaintext(input: RenderInput): Rendered {
  const { document, gvr } = input;
  const c: Ctx = { document, recursive: input.recursive, maxDepth: input.maxDepth };
  const prefix = gvr.group === '' ? '/api' : `/apis/${gvr.group}`;
  const searchPaths = [
    [prefix, gvr.version, gvr.resource],
    [prefix, gvr.version, gvr.resource, '{name}'],
    [prefix, gvr.version, 'namespaces', '{namespace}', gvr.resource],
    [prefix, gvr.version, 'namespaces', '{namespace}', gvr.resource, '{name}'],
  ].map((parts) => parts.join('/'));
  let gvk: Json | undefined = '';
  for (const sp of searchPaths) {
    const element = field(field(document, 'paths'), sp);
    if (!truth(element)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const m = field(element, method);
      if (!truth(m)) continue;
      gvk = field(m, 'x-kubernetes-group-version-kind');
      if (truth(gvk)) break;
    }
  }
  if (!truth(gvk)) return { text: '', error: new ExplainError(`error: GVR (${gvrString(gvr)}) not found in OpenAPI schema`) };
  let text = '';
  const group = field(gvk, 'group');
  if (truth(group)) text += `GROUP:      ${goValue(group)}\n`;
  text += `KIND:       ${goValue(field(gvk, 'kind'))}\n`;
  text += `VERSION:    ${goValue(field(gvk, 'version'))}\n`;
  text += '\n';
  try {
    const r = schemaFor(c, gvk, input.fieldPath);
    if (r === '') return { text, error: new ExplainError(`error: GVK ${goValue(gvk)} not found in OpenAPI schema`) };
    text += r;
  } catch (e) {
    if (e instanceof ExplainError || e instanceof TemplateError) return { text, error: e };
    throw e;
  }
  return { text: text + '\n' };
}
