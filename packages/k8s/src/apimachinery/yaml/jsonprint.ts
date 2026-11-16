// kubectl's JSONPrinter: json.MarshalIndent(obj, "", "    ") and a newline. Go's encoding/json
// escapes <, > and & (<, >, &), U+2028 and U+2029, control characters (\b, \f,
// \n, \r, \t, else \u00XX), and writes invalid UTF-8 as U+FFFD; Indent puts every element on its
// own line, leaves empty objects and arrays as {} and [], and writes the prefix at the start of
// every line but the first.
//
// Key order: an unstructured object (what `kubectl get` prints) is a map[string]interface{},
// marshalled with sorted keys (`sortKeys`). A typed object (a client-side generator's output,
// `create --dry-run=client -o json`) keeps its struct field order, which the caller's value
// carries in insertion order; maps inside it are sorted by encoding/json and arrive sorted.
//
// upstream: staging/src/k8s.io/cli-runtime/pkg/printers/json.go (JSONPrinter.PrintObj), Go
// src/encoding/json/encode.go (appendString with escapeHTML, float64 'f'/'e' choice at 1e-6 and
// 1e21, map keys sorted by string), indent.go (appendIndent).

import type { Json } from '../json.ts';
import { compareGoStrings } from './gofmt.ts';
import { toGoString } from './encode.ts';

/** appendString with escapeHTML: JSON.stringify's escapes plus Go's. */
function goString(s: string): string {
  return JSON.stringify(toGoString(s)).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A key JavaScript stores before the others (an array index): only a Go map can have one. */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function keysOf(o: { [k: string]: Json }, sortKeys: boolean): string[] {
  const keys = Object.keys(o);
  // JavaScript moves integer-like keys to the front, so their insertion order is lost; a struct
  // has no such field names, so an object holding one is a map and Go sorts it.
  if (sortKeys || keys.some((k) => ARRAY_INDEX.test(k) && Number(k) < 2 ** 32 - 1)) return keys.sort(compareGoStrings);
  return keys;
}

function write(v: Json, prefix: string, indent: string, depth: number, sortKeys: boolean, out: string[]): void {
  if (v === null) out.push('null');
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`json: unsupported value: ${v}`);
    out.push(String(v));
  } else if (typeof v === 'string') out.push(goString(v));
  else {
    const isArray = Array.isArray(v);
    const items: [string | undefined, Json][] = isArray
      ? v.map((x): [undefined, Json] => [undefined, x])
      : keysOf(v, sortKeys).map((k): [string, Json] => [k, v[k] as Json]);
    if (items.length === 0) {
      out.push(isArray ? '[]' : '{}');
      return;
    }
    out.push(isArray ? '[' : '{');
    const inner = `\n${prefix}${indent.repeat(depth + 1)}`;
    items.forEach(([k, x], i) => {
      if (i > 0) out.push(',');
      out.push(inner);
      if (k !== undefined) out.push(`${goString(k)}: `);
      write(x, prefix, indent, depth + 1, sortKeys, out);
    });
    out.push(`\n${prefix}${indent.repeat(depth)}`, isArray ? ']' : '}');
  }
}

/** json.MarshalIndent(v, prefix, indent), without a trailing newline. */
export function marshalIndentJson(v: Json, prefix: string, indent: string, opts: { sortKeys?: boolean } = {}): string {
  const out: string[] = [];
  write(v, prefix, indent, 0, opts.sortKeys ?? false, out);
  return out.join('');
}

/** What `kubectl … -o json` prints for one object. */
export function printJson(v: Json, opts: { sortKeys?: boolean } = {}): string {
  return `${marshalIndentJson(v, '', '    ', opts)}\n`;
}
