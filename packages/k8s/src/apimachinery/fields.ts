// Field selectors: the `fieldSelector` query parameter.
// upstream: staging/src/k8s.io/apimachinery/pkg/fields/selector.go (ParseSelector, splitTerms,
// splitTerm, UnescapeValue, EscapeValue, hasTerm, notHasTerm, andTerm, Transform,
// RequiresExactMatch, SelectorFromSet), fields/fields.go (Set), runtime/conversion.go
// (DefaultMetaV1FieldSelectorConversion), pkg/apis/core/v1/conversion.go and
// pkg/apis/batch/v1/conversion.go (the unsupported-label messages).
//
// A selector is plain data: its terms, ANDed. upstream's shapes (a lone term, or an andTerm) behave
// the same for Matches, String, Empty and RequiresExactMatch, so one flat list stands for both.

import { goQuote } from './field.ts';
import { compareGoStrings } from './labels.ts';

export interface FieldTerm {
  field: string;
  /** hasTerm (`=` and `==` both parse to it) or notHasTerm. */
  operator: '=' | '!=';
  /** Unescaped. */
  value: string;
}

/** A field selector; `nothing` is fields.Nothing(), otherwise the terms are ANDed. */
export interface FieldSelector {
  terms: FieldTerm[];
  nothing?: true;
}

export type Fields = Readonly<Record<string, string>>;
export type FieldSelectorResult = FieldSelector | { error: string };

/** fields.Everything(). */
export function everythingFields(): FieldSelector {
  return { terms: [] };
}

/** fields.Nothing(). */
export function nothingFields(): FieldSelector {
  return { terms: [], nothing: true };
}

/** Selector.Empty(). */
export function fieldSelectorEmpty(sel: FieldSelector): boolean {
  return sel.nothing !== true && sel.terms.length === 0;
}

/** Selector.Matches: a field missing from the set reads as "" (Set.Get). */
export function fieldSelectorMatches(sel: FieldSelector, fields: Fields): boolean {
  if (sel.nothing === true) return false;
  return sel.terms.every((t) => {
    const v = Object.hasOwn(fields, t.field) ? (fields[t.field] as string) : '';
    return t.operator === '=' ? v === t.value : v !== t.value;
  });
}

/** EscapeValue: `\`, `,` and `=` are backslash-escaped. */
export function escapeValue(s: string): string {
  return s.replace(/[\\,=]/g, (c) => `\\${c}`);
}

/** UnescapeValue; the unescaped-rune error prints the rune with %v, as a number. */
export function unescapeValue(s: string): { value: string } | { error: string } {
  if (!/[\\,=]/.test(s)) return { value: s };
  let v = '';
  let inSlash = false;
  for (const c of s) {
    if (inSlash) {
      if (c === '\\' || c === ',' || c === '=') v += c;
      else return { error: `invalid field selector: invalid escape sequence: \\${c}` };
      inSlash = false;
      continue;
    }
    if (c === '\\') inSlash = true;
    else if (c === ',' || c === '=') return { error: `invalid field selector: unescaped character in value: ${c.codePointAt(0) as number}` };
    else v += c;
  }
  if (inSlash) return { error: 'invalid field selector: invalid escape sequence: \\' };
  return { value: v };
}

/** Selector.String(): terms joined with ","; `==` comes back as `=`. */
export function fieldSelectorString(sel: FieldSelector): string {
  return sel.terms.map((t) => `${t.field}${t.operator}${escapeValue(t.value)}`).join(',');
}

/** Selector.RequiresExactMatch: the first `=` term on the field. */
export function fieldRequiresExactMatch(sel: FieldSelector, field: string): { value: string } | null {
  const t = sel.terms.find((x) => x.operator === '=' && x.field === field);
  return t === undefined ? null : { value: t.value };
}

/** splitTerms: on commas not escaped by a backslash. */
export function splitTerms(s: string): string[] {
  if (s.length === 0) return [];
  const terms: string[] = [];
  let start = 0;
  let inSlash = false;
  let i = 0;
  for (const c of s) {
    if (inSlash) inSlash = false;
    else if (c === '\\') inSlash = true;
    else if (c === ',') {
      terms.push(s.slice(start, i));
      start = i + 1;
    }
    i += c.length;
  }
  terms.push(s.slice(start));
  return terms;
}

const TERM_OPERATORS = ['!=', '==', '='] as const;

/** splitTerm: at the first position where `!=`, `==` or `=` (tried in that order) begins. */
export function splitTerm(term: string): { lhs: string; op: (typeof TERM_OPERATORS)[number]; rhs: string } | null {
  for (let i = 0; i < term.length; i++) {
    for (const op of TERM_OPERATORS) {
      if (term.startsWith(op, i)) return { lhs: term.slice(0, i), op, rhs: term.slice(i + op.length) };
    }
  }
  return null;
}

/** TransformFunc: a new field and value, or an error. */
export type FieldTransform = (field: string, value: string) => { field: string; value: string } | { error: string };

/**
 * Selector.Transform: each term mapped through `fn`; a term mapped to an empty field and value
 * becomes Everything and drops out. The first error wins.
 */
export function transformFieldSelector(sel: FieldSelector, fn: FieldTransform): FieldSelectorResult {
  if (sel.nothing === true) return sel;
  const terms: FieldTerm[] = [];
  for (const t of sel.terms) {
    const r = fn(t.field, t.value);
    if ('error' in r) return r;
    if (r.field.length === 0 && r.value.length === 0) continue;
    terms.push({ field: r.field, operator: t.operator, value: r.value });
  }
  return { terms };
}

/**
 * fields.ParseSelector (ParseAndTransformSelector with `fn`). Terms are sorted as raw strings
 * before parsing; empty terms are skipped. Field names are not checked here: the API server
 * converts them per kind afterwards (ConvertFieldLabel), which is where unknown ones fail.
 */
export function parseFieldSelector(selector: string, fn: FieldTransform = (field, value) => ({ field, value })): FieldSelectorResult {
  const parts = splitTerms(selector).sort(compareGoStrings);
  const terms: FieldTerm[] = [];
  for (const part of parts) {
    if (part === '') continue;
    const t = splitTerm(part);
    if (t === null) return { error: `invalid selector: '${selector}'; can't understand '${part}'` };
    const rhs = unescapeValue(t.rhs);
    if ('error' in rhs) return rhs;
    terms.push({ field: t.lhs, operator: t.op === '!=' ? '!=' : '=', value: rhs.value });
  }
  return transformFieldSelector({ terms }, fn);
}

/**
 * fields.SelectorFromSet: one `=` term per field. Upstream keeps Go's random map order; we sort
 * by field so String() is deterministic.
 */
export function fieldSelectorFromSet(set: Fields | null | undefined): FieldSelector {
  if (set === null || set === undefined) return everythingFields();
  return { terms: Object.keys(set).sort(compareGoStrings).map((field) => ({ field, operator: '=' as const, value: set[field] as string })) };
}

/** fields.Set.String(): `k=v` pairs (not escaped), sorted as whole strings. */
export function fieldsString(set: Fields): string {
  return Object.keys(set)
    .map((k) => `${k}=${set[k] as string}`)
    .sort(compareGoStrings)
    .join(',');
}

/**
 * The error of a field label conversion func for a label it does not know.
 *   null:  runtime.DefaultMetaV1FieldSelectorConversion, for kinds without their own func;
 *   'Job': batch/v1's func;
 *   any other kind: the core/v1, events and certificates funcs' `field label not supported: %s`.
 * (ResourceSlice and the old StatefulSet/CronJob versions have their own wording and are not
 * covered.)
 */
export function unsupportedFieldError(kind: string | null, label: string): string {
  if (kind === null) return `${goQuote(label)} is not a known field selector: only ${goQuote('metadata.name')}, ${goQuote('metadata.namespace')}`;
  if (kind === 'Job') return `field label ${goQuote(label)} not supported for Job`;
  return `field label not supported: ${label}`;
}

/** runtime.DefaultMetaV1FieldSelectorConversion as a FieldTransform. */
export const defaultMetaV1FieldSelectorConversion: FieldTransform = (field, value) =>
  field === 'metadata.name' || field === 'metadata.namespace' ? { field, value } : { error: unsupportedFieldError(null, field) };
