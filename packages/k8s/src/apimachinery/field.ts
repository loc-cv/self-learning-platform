// Field validation errors: field.Path, field.Error, ErrorList.ToAggregate.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go, path.go;
// staging/src/k8s.io/apimachinery/pkg/util/errors/errors.go (aggregate: "[a, b]", de-duplicated).

import { goJson, type Json } from './json.ts';

export type ErrorType =
  | 'FieldValueNotFound'
  | 'FieldValueRequired'
  | 'FieldValueDuplicate'
  | 'FieldValueInvalid'
  | 'FieldValueNotSupported'
  | 'FieldValueForbidden'
  | 'FieldValueTooLong'
  | 'FieldValueTooMany'
  | 'FieldValueTooFew'
  | 'FieldValueTooShort'
  | 'FieldValueTypeInvalid'
  | 'InternalError';

const TYPE_STRING: Record<ErrorType, string> = {
  FieldValueNotFound: 'Not found',
  FieldValueRequired: 'Required value',
  FieldValueDuplicate: 'Duplicate value',
  FieldValueInvalid: 'Invalid value',
  FieldValueNotSupported: 'Unsupported value',
  FieldValueForbidden: 'Forbidden',
  FieldValueTooLong: 'Too long',
  FieldValueTooMany: 'Too many',
  FieldValueTooFew: 'Too few',
  FieldValueTooShort: 'Too short',
  FieldValueTypeInvalid: 'Invalid value',
  InternalError: 'Internal error',
};

/**
 * A value as validation code holds it. Go renders int/bool/float with %v, strings with %q and
 * everything else with json.Marshal; `{ go: text }` is a value already rendered (an internal Go
 * struct, whose JSON uses Go field names).
 */
export type BadValue = Json | { go: string } | undefined;

export interface FieldError {
  type: ErrorType;
  /** Path.String(): `spec.containers[0].image`; `<nil>` for a nil path. */
  field: string;
  value: BadValue;
  detail: string;
}

/** A field path, built like upstream's: `root('spec').child('containers').index(0)`. */
export interface Path {
  readonly s: string;
  child(name: string, ...more: string[]): Path;
  index(i: number): Path;
  key(k: string): Path;
  toString(): string;
}

function makePath(s: string): Path {
  return {
    s,
    child: (name, ...more) => makePath([s, name, ...more].filter((x) => x !== '').join('.')),
    index: (i) => makePath(`${s}[${i}]`),
    key: (k) => makePath(`${s}[${k}]`),
    toString: () => s,
  };
}

export function newPath(name: string, ...more: string[]): Path {
  return makePath([name, ...more].join('.'));
}

/** The nil *field.Path of label selector errors. */
export const NIL_PATH: Path = { ...makePath(''), s: '<nil>', toString: () => '<nil>' };

/** Go's strconv.Quote. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 7) out += '\\a';
    else if (c === 8) out += '\\b';
    else if (c === 12) out += '\\f';
    else if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 9) out += '\\t';
    else if (c === 11) out += '\\v';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else if (c >= 0x80 && c <= 0x9f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

function renderValue(v: BadValue): string {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'go' in v && typeof v.go === 'string' && Object.keys(v).length === 1) return v.go;
  if (typeof v === 'string') return goQuote(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined) return 'null';
  return goJson(v as Json);
}

/** ErrorBody(): the message without the field. */
export function errorBody(e: FieldError): string {
  let s: string;
  switch (e.type) {
    case 'FieldValueRequired':
    case 'FieldValueForbidden':
    case 'FieldValueTooLong':
    case 'FieldValueTooShort':
    case 'InternalError':
      s = TYPE_STRING[e.type];
      break;
    default:
      s = `${TYPE_STRING[e.type]}: ${renderValue(e.value)}`;
  }
  return e.detail === '' ? s : `${s}: ${e.detail}`;
}

/** Error(): `<field>: <body>`. */
export function errorString(e: FieldError): string {
  return `${e.field}: ${errorBody(e)}`;
}

const mk = (type: ErrorType, path: Path, value: BadValue, detail: string): FieldError => ({ type, field: path.toString(), value, detail });

export const required = (path: Path, detail = ''): FieldError => mk('FieldValueRequired', path, '', detail);
export const invalid = (path: Path, value: BadValue, detail: string): FieldError => mk('FieldValueInvalid', path, value, detail);
export const forbidden = (path: Path, detail: string): FieldError => mk('FieldValueForbidden', path, '', detail);
export const duplicate = (path: Path, value: BadValue): FieldError => mk('FieldValueDuplicate', path, value, '');
export const notFound = (path: Path, value: BadValue): FieldError => mk('FieldValueNotFound', path, value, '');
export const internalError = (path: Path, err: string): FieldError => mk('InternalError', path, null, err);

/** NotSupported: `supported values: "a", "b"` in the order given. */
export function notSupported(path: Path, value: BadValue, valid: readonly string[]): FieldError {
  return mk('FieldValueNotSupported', path, value, valid.length === 0 ? '' : `supported values: ${valid.map(goQuote).join(', ')}`);
}

export function tooLong(path: Path, max: number): FieldError {
  return mk('FieldValueTooLong', path, '', max < 0 ? 'value is too long' : `may not be more than ${max} ${max === 1 ? 'byte' : 'bytes'}`);
}

export function tooMany(path: Path, actual: number, max: number): FieldError {
  return mk('FieldValueTooMany', path, actual, max < 0 ? 'has too many items' : `must have at most ${max} ${max === 1 ? 'item' : 'items'}`);
}

/** ErrorList.ToAggregate().Error(): one message, or `[a, b]`; repeated messages appear once. */
export function aggregate(errs: readonly FieldError[]): string {
  const seen = new Set<string>();
  const msgs: string[] = [];
  for (const e of errs) {
    const s = errorString(e);
    if (seen.has(s)) continue;
    seen.add(s);
    msgs.push(s);
  }
  return msgs.length === 1 ? (msgs[0] as string) : `[${msgs.join(', ')}]`;
}

/** Prefixes every message of a list of plain validation messages into Invalid errors. */
export function invalidAll(path: Path, value: BadValue, msgs: readonly string[]): FieldError[] {
  return msgs.map((m) => invalid(path, value, m));
}
