// runtime.DefaultUnstructuredConverter.FromUnstructuredWithValidation: a decoded map converted
// into the Go type, as the API server does with a strategically patched object (handlers/patch.go
// applyPatchToObject) instead of encoding it to JSON and decoding that. Its errors are its own,
// not encoding/json's, and its unknown fields are sorted.
// upstream: staging/src/k8s.io/apimachinery/pkg/runtime/converter.go (fromUnstructured,
// mapFromUnstructured, sliceFromUnstructured, pointerFromUnstructured, structFromUnstructured,
// the matched-key tracking and recordUnknownField's path: `.` between keys, `[i]` for indices,
// nothing for map keys); types with their own UnmarshalJSON go through it
// (structured-merge-diff value.TypeReflectCacheEntry.FromUnstructured), whose errors gojson.ts
// already gives.
//
// The result is the converted value as JSON, for the same canonical encoding a decoded body gets.

import { encodeBase64 } from './base64.ts';
import { base64Error, decode } from './gojson.ts';
import type { Json, JsonObject } from './json.ts';
import { compareGoStrings } from './labels.ts';
import { displayType, schema, type TypeExpr } from '../openapi/schema.ts';

export interface FromUnstructuredResult {
  value?: Json;
  /** The conversion error; the first one aborts. */
  error?: string;
  /** With returnUnknownFields: `unknown field "spec.foo"` texts, sorted. */
  unknown: string[];
}

class ConvertError extends Error {}

interface Ctx {
  path: string[];
  unknown: string[];
  returnUnknownFields: boolean;
}

/** reflect.Type.String() of a decoded value's dynamic type. */
function sourceType(v: Json): string {
  if (Array.isArray(v)) return '[]interface {}';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(v) ? 'int64' : 'float64';
    default:
      return 'map[string]interface {}';
  }
}

/** reflect.Kind of a decoded value. */
function sourceKind(v: Json): string {
  const t = sourceType(v);
  return t === '[]interface {}' ? 'slice' : t === 'map[string]interface {}' ? 'map' : t;
}

const INT_BITS: Record<string, [number, boolean]> = {
  int8: [8, true],
  int16: [16, true],
  int32: [32, true],
  int64: [64, true],
  int: [64, true],
  uint8: [8, false],
  uint16: [16, false],
  uint32: [32, false],
  uint64: [64, false],
  uint: [64, false],
};

/** reflect.Value.Convert of an int64 to a sized integer: the bits wrap. */
function wrapInt(v: number, name: string): number {
  const [bits, signed] = INT_BITS[name] as [number, boolean];
  if (bits === 64) return v;
  const m = 2 ** bits;
  let r = ((v % m) + m) % m;
  if (signed && r >= m / 2) r -= m;
  return r;
}

/** fromUnstructured's simple types: `name` is the destination's kind, `shown` its type for errors. */
function basicFrom(v: Json, name: string, shown: TypeExpr): Json {
  const st = sourceKind(v);
  const dt = displayType(shown);
  if (name === 'string') {
    if (st === 'string') return v;
    // int64 is convertible to a string type (as a rune); JSON does not allow it.
    if (st === 'int64') throw new ConvertError(`cannot convert int64 to ${dt}`);
    throw new ConvertError(`unrecognized type: ${name}`);
  }
  if (name === 'bool') {
    if (st === 'bool') return v;
    throw new ConvertError(`unrecognized type: ${name}`);
  }
  if (name === 'float32' || name === 'float64') {
    if (st === 'int64' || st === 'float64') return v;
    throw new ConvertError(`unrecognized type: ${name}`);
  }
  if (INT_BITS[name]) {
    if (st === 'int64') return wrapInt(v as number, name);
    if (st === 'float64') {
      // A float with no fraction converts; JS numbers without one read as int64 already.
      throw new ConvertError(`cannot convert float64 to ${dt}`);
    }
    throw new ConvertError(`unrecognized type: ${name}`);
  }
  throw new ConvertError(`unrecognized type: ${name}`);
}

function pushKey(c: Ctx, key: string): void {
  if (c.path.length > 0) c.path.push('.');
  c.path.push(key);
}

/** sv is never null here: a nil source sets the zero value (the caller keeps the null). */
function from(v: Json, t: TypeExpr, c: Ctx, shown: TypeExpr = t): Json {
  if (v === null) return null;
  switch (t.k) {
    case 'basic':
      return basicFrom(v, t.name, shown);
    case 'any':
      return v;
    case 'ptr':
      return from(v, t.elem, c);
    case 'bytes': {
      // We store original []byte representation as string.
      if (typeof v === 'string') {
        const err = v.length > 0 ? base64Error(v) : undefined;
        if (err !== undefined) throw new ConvertError(`error decoding from json: ${err}`);
        return v;
      }
      if (!Array.isArray(v)) throw new ConvertError(`cannot restore slice from ${sourceKind(v)}`);
      // A list of numbers into []byte: each element converts as a uint8; the bytes are kept as
      // their JSON form, base64.
      const bytes = v.map((x) => (x === null ? 0 : (from(x, { k: 'basic', name: 'uint8' }, c) as number)));
      return encodeBase64(String.fromCharCode(...bytes));
    }
    case 'slice': {
      if (!Array.isArray(v)) throw new ConvertError(`cannot restore slice from ${sourceKind(v)}`);
      return v.map((x, i) => {
        const base = c.path.length;
        if (c.returnUnknownFields) c.path.push('[', String(i), ']');
        const r = from(x, t.elem, c);
        c.path.length = base;
        return r;
      });
    }
    case 'map': {
      if (sourceKind(v) !== 'map') throw new ConvertError(`cannot restore map from ${sourceKind(v)}`);
      const out: JsonObject = {};
      for (const key of Object.keys(v as JsonObject)) out[key] = from((v as JsonObject)[key] as Json, t.elem, c);
      return out;
    }
    case 'named': {
      const nt = schema().type(t.id);
      if (nt.underlying) {
        // A defined type: its kind decides, errors name the type itself.
        if (nt.underlying.k === 'basic') return basicFrom(v, nt.underlying.name, t);
        return from(v, nt.underlying, c, t);
      }
      if (nt.custom) {
        // The type's UnmarshalJSON on the value's JSON.
        const r = decode(v, nt.id);
        if (r.error !== undefined) throw new ConvertError(r.error);
        return r.value as Json;
      }
      if (sourceKind(v) !== 'map') throw new ConvertError(`cannot restore struct from: ${sourceKind(v)}`);
      const obj = v as JsonObject;
      const fields = nt.struct?.fields ?? [];
      const out: JsonObject = {};
      const base = c.path.length;
      for (const f of fields) {
        if (!Object.hasOwn(obj, f.json)) continue;
        if (c.returnUnknownFields) pushKey(c, f.json);
        out[f.json] = from(obj[f.json] as Json, f.type, c);
        c.path.length = base;
      }
      if (c.returnUnknownFields) {
        const byJson = nt.struct?.byJson ?? {};
        for (const key of Object.keys(obj)) {
          if (Object.hasOwn(byJson, key)) continue;
          pushKey(c, key);
          c.unknown.push(`unknown field "${c.path.join('')}"`);
          c.path.length = base;
        }
      }
      return out;
    }
  }
}

/** FromUnstructuredWithValidation(u, new(typeId), returnUnknownFields). */
export function fromUnstructured(u: JsonObject, typeId: string, returnUnknownFields: boolean): FromUnstructuredResult {
  const c: Ctx = { path: [], unknown: [], returnUnknownFields };
  try {
    const value = from(u, { k: 'named', id: typeId }, c);
    return { value, unknown: c.unknown.sort(compareGoStrings) };
  } catch (e) {
    if (e instanceof ConvertError) return { error: e.message, unknown: [] };
    throw e;
  }
}
