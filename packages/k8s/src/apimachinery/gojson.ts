// What the API server's JSON decoding and encoding do to a request body, against the vendored Go
// types (openapi/schema.ts):
//   decode: sigs.k8s.io/json's case-sensitive decoding into the versioned Go type, with strict
//     field checking (unknown fields collected, not fatal) and encoding/json's type errors;
//   encode: encoding/json's marshalling of the result: struct fields in declaration order, map
//     keys sorted, `omitempty`/`omitzero` applied, nil pointers, slices and maps as null.
// A decode followed by an encode is the canonical form the API server stores and returns.
//
// upstream: staging/src/k8s.io/apimachinery/pkg/runtime/serializer/json/json.go (Decode, strict
// errors), sigs.k8s.io/json internal/golang/encoding/json decode.go (UnmarshalTypeError: "json:
// cannot unmarshal <value> into Go struct field <Struct>.<path> of type <type>", the first such
// error is kept and decoding goes on; an UnmarshalJSON error aborts), encode.go (isEmptyValue,
// map key sorting), Go 1.24 encoding/json omitzero.

import { formatMicroTime, formatTime, parseTime } from './time.ts';
import { canonicalQuantity } from './quantity.ts';
import { displayType, schema, type NamedType, type TypeExpr } from '../openapi/schema.ts';
import type { Json, JsonObject } from './json.ts';

export interface DecodeResult {
  /** The decoded value; set unless `error`. */
  value?: Json;
  /** A decoding error: the text after `<Kind> in version "<v>" cannot be handled as a <Kind>: `. */
  error?: string;
  /** Unknown fields, as strict decoding names them: `spec.containers[0].imagePullPolice`. */
  unknown: string[];
}

interface DecodeCtx {
  /** Path with indices, for strict errors. */
  path: string;
  /** Path of JSON field names without indices, for type errors (Go's Field). */
  field: string;
  /** Innermost struct being decoded (Go's Struct). */
  struct: string;
  unknown: string[];
  typeError?: string;
  fatal?: string;
}

function jsonKind(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    default:
      return 'object';
  }
}

function typeError(c: DecodeCtx, value: string, t: TypeExpr): void {
  if (c.typeError !== undefined) return;
  c.typeError =
    c.struct !== '' || c.field !== ''
      ? `json: cannot unmarshal ${value} into Go struct field ${c.struct}.${c.field} of type ${displayType(t)}`
      : `json: cannot unmarshal ${value} into Go value of type ${displayType(t)}`;
}

const INT_RANGE: Record<string, [number, number]> = {
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
  uint: [0, Number.MAX_SAFE_INTEGER],
};

/** Go's number literal as encoding/json reports it: the JSON text. */
function numberText(n: number): string {
  return String(n);
}

function decodeBasic(v: Json, name: string, t: TypeExpr, c: DecodeCtx): Json {
  switch (name) {
    case 'string':
      if (typeof v === 'string') return v;
      typeError(c, jsonKind(v), t);
      return '';
    case 'bool':
      if (typeof v === 'boolean') return v;
      typeError(c, jsonKind(v), t);
      return false;
    case 'float32':
    case 'float64':
      if (typeof v === 'number') return v;
      typeError(c, jsonKind(v), t);
      return 0;
    default: {
      const range = INT_RANGE[name];
      if (!range) throw new Error(`unsupported basic type ${name}`);
      if (typeof v !== 'number') {
        typeError(c, jsonKind(v), t);
        return 0;
      }
      if (!Number.isInteger(v) || v < range[0] || v > range[1]) {
        typeError(c, `number ${numberText(v)}`, t);
        return 0;
      }
      return v;
    }
  }
}

// Go's base64.StdEncoding.Decode, for its error only: the offset of the first bad input byte.
// upstream: Go src/encoding/base64/base64.go decodeQuantum (newlines are skipped).
// A non-ASCII character is illegal where it starts, after only ASCII, so indices are byte offsets.
const B64_CHAR = /[A-Za-z0-9+/]/;
export function base64Error(s: string): string | undefined {
  const bad = (i: number) => `illegal base64 data at input byte ${i}`;
  let si = 0;
  for (;;) {
    for (let j = 0; j < 4; j++) {
      if (si === s.length) {
        if (j === 0) return undefined;
        return bad(si - j);
      }
      const ch = s[si] as string;
      si++;
      if (B64_CHAR.test(ch)) continue;
      if (ch === '\n' || ch === '\r') {
        j--;
        continue;
      }
      if (ch !== '=') return bad(si - 1);
      if (j === 0 || j === 1) return bad(si - 1);
      if (j === 2) {
        while (si < s.length && (s[si] === '\n' || s[si] === '\r')) si++;
        if (si === s.length) return bad(s.length);
        if (s[si] !== '=') return bad(si - 1);
        si++;
      }
      while (si < s.length && (s[si] === '\n' || s[si] === '\r')) si++;
      if (si < s.length) return bad(si);
      return undefined;
    }
  }
}

function decodeNamed(v: Json, nt: NamedType, t: TypeExpr, c: DecodeCtx): Json {
  if (nt.custom) return decodeCustom(v, nt, c);
  if (nt.underlying) {
    if (v === null) return null;
    // Errors name the defined type (v1.RestartPolicy), not its underlying one.
    if (nt.underlying.k === 'basic') return decodeBasic(v, nt.underlying.name, t, c);
    return decodeWith(v, nt.underlying, c, t);
  }
  if (v === null) return null;
  if (jsonKind(v) !== 'object') {
    typeError(c, jsonKind(v), t);
    return null;
  }
  const struct = nt.struct as NonNullable<NamedType['struct']>;
  const out: JsonObject = {};
  const obj = v as JsonObject;
  for (const key of Object.keys(obj)) {
    const f = struct.byJson[key];
    const childPath = c.path === '' ? key : `${c.path}.${key}`;
    if (!f) {
      c.unknown.push(childPath);
      continue;
    }
    const saved = { path: c.path, field: c.field, struct: c.struct };
    c.path = childPath;
    c.field = c.field === '' ? key : `${c.field}.${key}`;
    c.struct = nt.name;
    out[key] = decodeWith(obj[key] as Json, f.type, c);
    Object.assign(c, saved);
    if (c.fatal !== undefined) return out;
  }
  return out;
}

function decodeCustom(v: Json, nt: NamedType, c: DecodeCtx): Json {
  // Errors from a type's own UnmarshalJSON abort decoding and are returned as they are.
  const int32: TypeExpr = { k: 'basic', name: 'int32' };
  const str: TypeExpr = { k: 'basic', name: 'string' };
  const nested = (value: Json, t: TypeExpr): string => `json: cannot unmarshal ${jsonKind(value) === 'number' && t === int32 ? `number ${numberText(value as number)}` : jsonKind(value)} into Go value of type ${displayType(t)}`;
  switch (nt.custom) {
    case 'json':
      return v;
    case 'string':
    case 'duration':
      if (v === null || typeof v === 'string') return v;
      c.fatal = nested(v, str);
      return null;
    case 'time':
    case 'microtime': {
      if (v === null) return null;
      if (typeof v !== 'string') {
        c.fatal = nested(v, str);
        return null;
      }
      const parsed = parseTime(v, nt.custom === 'microtime');
      if ('error' in parsed) {
        c.fatal = parsed.error;
        return null;
      }
      return nt.custom === 'microtime' ? formatMicroTime(parsed.micros) : formatTime(parsed.micros);
    }
    case 'intstr':
      // upstream: apimachinery/pkg/util/intstr/intstr.go UnmarshalJSON
      if (v === null || typeof v === 'string') return v;
      if (typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) return v;
      c.fatal = typeof v === 'number' ? nested(v, int32) : nested(v, int32);
      return null;
    case 'quantity': {
      // upstream: apimachinery/pkg/api/resource/quantity.go UnmarshalJSON: a JSON string or number.
      if (v === null) return null;
      if (typeof v !== 'string' && typeof v !== 'number') {
        c.fatal = 'quantities must match the regular expression \'^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$\'';
        return null;
      }
      const q = canonicalQuantity(typeof v === 'number' ? numberText(v) : v);
      if (typeof q !== 'string') {
        c.fatal = q.error;
        return null;
      }
      return q;
    }
    default:
      throw new Error(`unknown custom type ${String(nt.custom)}`);
  }
}

/** `t` is the type to decode into; `shown` the type errors name (a defined type's own name). */
function decodeWith(v: Json, t: TypeExpr, c: DecodeCtx, shown: TypeExpr = t): Json {
  switch (t.k) {
    case 'ptr':
      // encoding/json allocates through pointers; errors name the element type.
      if (v === null) return null;
      return decodeWith(v, t.elem, c, t.elem);
    case 'basic':
      if (v === null) return null;
      return decodeBasic(v, t.name, shown, c);
    case 'any':
      return v;
    case 'bytes': {
      if (v === null) return null;
      if (typeof v !== 'string') {
        typeError(c, jsonKind(v), shown);
        return null;
      }
      const err = base64Error(v);
      if (err !== undefined && c.typeError === undefined) c.typeError = err;
      return v;
    }
    case 'slice': {
      if (v === null) return null;
      if (!Array.isArray(v)) {
        typeError(c, jsonKind(v), shown);
        return null;
      }
      const base = c.path;
      return v.map((item, i) => {
        c.path = `${base}[${i}]`;
        const r = decodeWith(item, t.elem, c);
        c.path = base;
        return r;
      });
    }
    case 'map': {
      if (v === null) return null;
      if (jsonKind(v) !== 'object') {
        typeError(c, jsonKind(v), shown);
        return null;
      }
      const out: JsonObject = {};
      const base = c.path;
      for (const key of Object.keys(v as JsonObject)) {
        c.path = `${base}[${key}]`;
        out[key] = decodeWith((v as JsonObject)[key] as Json, t.elem, c);
        c.path = base;
      }
      return out;
    }
    case 'named':
      return decodeNamed(v, schema().type(t.id), t, c);
  }
}

/**
 * Decodes a request body into the Go type `typeId` (`core/v1.Pod`). Unknown fields are reported
 * in document order, as strict decoding finds them.
 */
export function decode(body: Json, typeId: string): DecodeResult {
  const c: DecodeCtx = { path: '', field: '', struct: '', unknown: [] };
  const value = decodeWith(body, { k: 'named', id: typeId }, c);
  if (c.fatal !== undefined) return { error: c.fatal, unknown: [] };
  if (c.typeError !== undefined) return { error: c.typeError, unknown: [] };
  return { value, unknown: c.unknown };
}

// ---- encoding ----

function isEmpty(v: Json | undefined, t: TypeExpr): boolean {
  if (v === undefined || v === null) return t.k !== 'named' || !isStructLike(t);
  switch (t.k) {
    case 'basic':
      return v === '' || v === 0 || v === false;
    case 'bytes':
      return v === '';
    case 'slice':
      return (v as Json[]).length === 0;
    case 'map':
      return Object.keys(v as JsonObject).length === 0;
    case 'ptr':
    case 'any':
      return false;
    case 'named': {
      const nt = schema().type(t.id);
      if (nt.underlying) return isEmpty(v, nt.underlying);
      return false; // structs and custom struct types are never empty for omitempty
    }
  }
}

function isStructLike(t: TypeExpr): boolean {
  if (t.k !== 'named') return false;
  const nt = schema().type(t.id);
  if (nt.underlying) return isStructLike(nt.underlying);
  return nt.struct !== undefined || nt.custom === 'time' || nt.custom === 'microtime' || nt.custom === 'quantity' || nt.custom === 'intstr' || nt.custom === 'duration';
}

/** Go's IsZero, for omitzero: the type's zero value. */
function isZero(v: Json | undefined, t: TypeExpr): boolean {
  if (v === undefined || v === null) return true;
  switch (t.k) {
    case 'basic':
      return v === '' || v === 0 || v === false;
    case 'bytes':
    case 'slice':
    case 'map':
    case 'ptr':
    case 'any':
      return false; // non-nil
    case 'named': {
      const nt = schema().type(t.id);
      if (nt.underlying) return isZero(v, nt.underlying);
      if (nt.custom) return nt.custom === 'intstr' ? v === 0 : nt.custom === 'quantity' ? false : v === '';
      const struct = nt.struct as NonNullable<NamedType['struct']>;
      return struct.fields.every((f) => isZero((v as JsonObject)[f.json], f.type));
    }
  }
}

function sortedKeys(o: JsonObject): string[] {
  return Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** encoding/json's output for a decoded value `v` (undefined or null: the zero value). */
export function encodeValue(v: Json | undefined, t: TypeExpr): Json {
  switch (t.k) {
    case 'basic':
      if (v === undefined || v === null) return t.name === 'string' ? '' : t.name === 'bool' ? false : 0;
      return v;
    case 'bytes':
      return v === undefined ? null : v;
    case 'any':
      return v === undefined ? null : sortDeep(v);
    case 'ptr':
      return v === undefined || v === null ? null : encodeValue(v, t.elem);
    case 'slice':
      return v === undefined || v === null ? null : (v as Json[]).map((x) => encodeValue(x, t.elem));
    case 'map': {
      if (v === undefined || v === null) return null;
      const o = v as JsonObject;
      const out: JsonObject = {};
      for (const k of sortedKeys(o)) out[k] = encodeValue(o[k], t.elem);
      return out;
    }
    case 'named': {
      const nt = schema().type(t.id);
      if (nt.underlying) return encodeValue(v, nt.underlying);
      if (nt.custom) {
        if (v !== undefined && v !== null) return nt.custom === 'json' ? v : v;
        switch (nt.custom) {
          case 'time':
          case 'microtime':
          case 'json':
            return null;
          case 'intstr':
            return 0;
          case 'quantity':
            return '0';
          default:
            return '';
        }
      }
      const struct = nt.struct as NonNullable<NamedType['struct']>;
      const o = (v ?? {}) as JsonObject;
      const out: JsonObject = {};
      for (const f of struct.fields) {
        const fv = o[f.json];
        if (f.omitzero && isZero(fv, f.type)) continue;
        if (f.omitempty && isEmpty(fv, f.type)) continue;
        out[f.json] = encodeValue(fv, f.type);
      }
      return out;
    }
  }
}

/** Interface values decode to Go maps, which encode with sorted keys. */
function sortDeep(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === 'object') {
    const out: JsonObject = {};
    for (const k of sortedKeys(v)) out[k] = sortDeep(v[k] as Json);
    return out;
  }
  return v;
}

/** The canonical form of an object of Go type `typeId`: what the API server would store. */
export function canonical(value: Json, typeId: string): Json {
  return encodeValue(value, { k: 'named', id: typeId });
}
