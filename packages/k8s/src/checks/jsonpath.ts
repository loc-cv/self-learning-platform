// The JSONPath subset the checks evaluate (`k8s.object` `where`, `k8s.unchanged` `paths`), in
// `kubectl -o jsonpath` syntax: one `{…}` action holding a chain of `.field`, `.*`, `[n]`, `[*]`
// and `['key']`, with `\` escaping the next character of a field (`app\.kubernetes\.io/name`).
// Everything else (recursive descent, filters, slices, unions, functions, several actions,
// literal text) is reported as unsupported syntax instead of being guessed at.
//
// Phase 15 ports client-go's jsonpath (parser and evaluator) and replaces this module.
//   upstream: staging/src/k8s.io/client-go/util/jsonpath/parser.go parseInsideAction, parseField
//             (a field runs to a terminator; a backslash takes the next character), parseArray
//             (`'key'` in brackets is a field), isTerminator
//   upstream: staging/src/k8s.io/client-go/util/jsonpath/jsonpath.go evalField, evalArray,
//             evalWildcard (kubectl sets AllowMissingKeys: a missing field yields nothing)
// The fields part of the parser follows kubectl/cmd/explain/fieldpath.ts, the partial port that
// kubectl explain uses.

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';

export type Step = { type: 'field'; name: string } | { type: 'index'; index: number } | { type: 'wildcard' };

export type ParsedPath = { steps: Step[] } | { error: string };

const TERMINATORS = new Set([' ', '\t', '\r', '\n', '.', ',', '[', ']', '$', '@', '{', '}']);

/** Parses `{.a.b[0]['x.y'][*].c}`. */
export function parsePath(path: string): ParsedPath {
  const unsupported = (what: string): ParsedPath => ({ error: `unsupported JSONPath syntax in ${JSON.stringify(path)}: ${what}` });
  if (!path.startsWith('{') || !path.endsWith('}') || path.length < 2) return unsupported('the path must be one {…} expression, such as {.spec.replicas}');
  const chars = [...path.slice(1, -1)];
  const steps: Step[] = [];
  let pos = 0;
  if (chars[pos] === '$') pos++;
  if (pos >= chars.length) return unsupported('an empty expression');
  while (pos < chars.length) {
    const ch = chars[pos] as string;
    if (ch === '.') {
      if (chars[pos + 1] === '.') return unsupported('recursive descent (..)');
      pos++;
      let raw = '';
      let escaped = false;
      while (pos < chars.length) {
        const c = chars[pos] as string;
        if (c === '\\') {
          // A trailing backslash escapes the action's closing brace in kubectl: an unclosed action.
          if (pos + 1 >= chars.length) return unsupported('a trailing backslash');
          raw += chars[pos + 1] as string;
          escaped = true;
          pos += 2;
          continue;
        }
        if (TERMINATORS.has(c)) break;
        raw += c;
        pos++;
      }
      if (raw === '*' && !escaped) steps.push({ type: 'wildcard' });
      // `{.}` and `{.a.}`: an empty field is the current node.
      else if (raw !== '') steps.push({ type: 'field', name: raw });
      continue;
    }
    if (ch === '[') {
      const close = chars.indexOf(']', pos);
      if (close < 0) return unsupported('an unclosed [');
      const inner = chars.slice(pos + 1, close).join('');
      pos = close + 1;
      if (inner === '*') steps.push({ type: 'wildcard' });
      else if (/^-?\d+$/.test(inner)) steps.push({ type: 'index', index: Number(inner) });
      else if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'") && !inner.slice(1, -1).includes("'")) steps.push({ type: 'field', name: inner.slice(1, -1) });
      else if (inner.startsWith('?')) return unsupported(`a filter [${inner}]`);
      else if (inner.includes(':')) return unsupported(`a slice [${inner}]`);
      else if (inner.includes(',')) return unsupported(`a union [${inner}]`);
      else return unsupported(`[${inner}]`);
      continue;
    }
    if (ch === '}' || ch === '{') return unsupported('more than one {…} expression, or literal text around it');
    return unsupported(`${JSON.stringify(ch)} at position ${pos + 1} of the expression`);
  }
  return { steps };
}

/** The values a parsed path yields on `root`, in order; missing fields and nulls yield nothing. */
export function evaluate(root: Json, steps: readonly Step[]): Json[] {
  let cur: Json[] = [root];
  for (const step of steps) {
    const next: Json[] = [];
    for (const v of cur) {
      if (step.type === 'field') {
        if (isObject(v) && Object.hasOwn(v, step.name)) next.push(v[step.name] as Json);
      } else if (step.type === 'index') {
        if (Array.isArray(v)) {
          const i = step.index < 0 ? v.length + step.index : step.index;
          if (i >= 0 && i < v.length) next.push(v[i] as Json);
        }
      } else if (Array.isArray(v)) next.push(...v);
      else if (isObject(v)) for (const k of Object.keys(v).sort()) next.push((v as JsonObject)[k] as Json);
    }
    cur = next.filter((x) => x !== null);
  }
  return cur.filter((x) => x !== null);
}

/** JSON with object keys sorted, the way Go's encoding/json prints a decoded map. */
export function canonicalJson(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The text kubectl's jsonpath prints for a value: a string as is, anything else as JSON (numbers
 * and booleans in JSON form, objects and lists as JSON with sorted keys).
 */
export function textOf(v: Json): string {
  return typeof v === 'string' ? v : canonicalJson(v);
}
