// JSON patch (RFC 6902, `application/json-patch+json`) as the API server applies it.
// upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go jsonPatcher.applyJSPatch,
// which calls gopkg.in/evanphx/json-patch.v4 v4.13.0 (vendor/gopkg.in/evanphx/json-patch.v4/patch.go)
// DecodePatch and Patch.Apply. A DecodePatch error becomes a 400 BadRequest, an Apply error a 422
// with the error text as the message.
//
// This is a port of v4's patch.go, not of RFC 6902, and v4 differs from the RFC in places:
//
// - pointers: the path is split on "/" and its first segment dropped without a check, so "" and
//   "a" (one segment) name nothing and "x/b" means "/b"; each segment is unescaped ~1 then ~0 in
//   one pass (strings.NewReplacer);
// - indices go through strconv.Atoi ("+1" and "007" are indices) and negative indices count from
//   the end (SupportNegativeIndices); "-" appends, for add only;
// - replace of a missing object key adds it (partialDoc.get never fails); only an array index out
//   of range fails;
// - copy from a missing object key, or move from a key holding null, inserts null;
// - test of a missing key passes when the operation's value is null or absent;
// - a missing "value" member reads as null for add and replace.
//
// lazyNode. v4 decodes the document into partialDoc (map[string]*lazyNode) or partialArray
// ([]*lazyNode). A lazyNode keeps its raw bytes until something parses it into a partialDoc or
// partialArray. A JSON null inside a parsed container decodes to a nil *lazyNode, while an
// operation's `"value": null` is a lazyNode with nil raw bytes, and a deep copy of either holds
// the bytes `null`. The three behave differently in `test`, in pointer traversal and under `copy`,
// so Node models all three (see Node and Slot).
//
// Key order. Apply returns json.Marshal of the root container, and json.Marshal writes Go maps
// with sorted keys, while a raw lazyNode marshals as its bytes. So these objects come out with
// sorted keys: the root object; every object a pointer passed through (findObject parses each
// intermediate container, also on the `from` side of move and copy); a whole-document replace
// value's top level; and every object in the document-side subtree a passing `test` compared
// (lazyNode.equal parses as it goes). Everything else keeps its bytes: untouched subtrees of the
// document, the values add and replace insert (the patch's own key order), and copies (copy
// serializes the source as it stands, sorted where it was parsed). Arrays are never reordered.
// JS objects put integer-like keys first whatever the insertion order, so a raw subtree with such
// keys cannot keep Go's byte order.
//
// Panics. A few inputs make v4 dereference a nil pointer or assign into a nil map: a `test`
// whose compared arrays hold null elements, a `test` or whole-document `replace` with no
// "value", and an add or replace under a copied null. applyJsonPatch returns those as
// `{ panic }` with Go's runtime error text. What the client then sees comes from the API server's
// panic recovery filters (staging/src/k8s.io/apiserver/pkg/server/filters), which are not in the
// checkout; this module does not invent it.
//
// Numbers and strings. v4 compares scalars in `test` by their compacted bytes, so 1 and 1.0, or
// "a" and "a", differ in Go. The body reaches us parsed, so those spellings are gone and
// scalars compare by value here. Raw subtrees keep Go's exact number text through Apply; Json
// numbers are JS doubles, so integers beyond 2^53 lose precision, as everywhere in this package.

import { cloneJson, type Json, type JsonObject } from './json.ts';
import { goQuote } from './field.ts';
import { compareGoStrings } from './labels.ts';

/** One decoded operation (jsonpatch.Operation, map[string]*json.RawMessage); a null member is a nil RawMessage. */
export type JsonPatchOperation = JsonObject;

/** jsonpatch.DecodePatch over an already-parsed body: the operations, or the Go error text (the server returns it as 400 BadRequest). */
export function decodeJsonPatch(body: Json): { ops: JsonPatchOperation[] } | { error: string } {
  // A null body decodes to a nil Patch without error.
  if (body === null) return { ops: [] };
  if (!Array.isArray(body)) return { error: unmarshalTypeError(body, 'jsonpatch.Patch') };
  const ops: JsonPatchOperation[] = [];
  for (const el of body) {
    // encoding/json keeps decoding after a type error and returns the first one. Go 1.26 (the
    // pin's toolchain, encoding/json v1) names no index for an element of a slice.
    if (el === null) ops.push({}); // a nil Operation reads like an empty one: Kind() is "unknown"
    else if (typeof el === 'object' && !Array.isArray(el)) ops.push(el);
    else return { error: unmarshalTypeError(el, 'jsonpatch.Operation') };
  }
  return { ops };
}

/**
 * Patch.Apply: the patched document, or the error text (the server returns it as 422 with that
 * message), or the text of the Go runtime panic the input triggers (see Panics in the header).
 * The inputs are not modified.
 */
export function applyJsonPatch(doc: Json, ops: readonly JsonPatchOperation[]): { ok: Json } | { error: string } | { panic: string } {
  // ApplyIndent: a document starting with '[' decodes into a partialArray, anything else into a
  // partialDoc; null sets that map to nil.
  let root: Node;
  if (Array.isArray(doc)) root = { raw: undefined, which: 'ary', doc: null, ary: doc.map(slotOf) };
  else if (doc === null) root = { raw: undefined, which: 'doc', doc: null, ary: null };
  else if (typeof doc === 'object') root = { raw: undefined, which: 'doc', doc: docOf(doc), ary: null };
  else return { error: unmarshalTypeError(doc, 'jsonpatch.partialDoc') };
  try {
    for (const op of ops) {
      const err = applyOp(root, op);
      if (err !== null) return { error: err };
    }
  } catch (e) {
    if (e instanceof GoPanic) return { panic: e.message };
    throw e;
  }
  return { ok: marshal(root) };
}

/**
 * A *lazyNode. `raw` stands for the bytes: undefined is a nil RawMessage, null the bytes `null`.
 * `doc` and `ary` are set once `which` says the node was parsed; null there is a nil map or slice.
 * The root container is a Node too, never raw.
 */
interface Node {
  raw: Json | undefined;
  which: 'raw' | 'doc' | 'ary';
  doc: Map<string, Slot> | null;
  ary: Slot[] | null;
}
/** A *lazyNode as a container holds it: null is a nil pointer (a JSON null in the parsed bytes). */
type Slot = Node | null;

/** A Go runtime panic, unwound to applyJsonPatch. */
class GoPanic extends Error {}
const NIL_DEREFERENCE = 'runtime error: invalid memory address or nil pointer dereference';
const NIL_MAP_ASSIGNMENT = 'assignment to entry in nil map';

// patch.go's sentinel errors.
const ERR_TEST_FAILED = 'test failed';
const ERR_MISSING = 'missing value';
const ERR_INVALID_INDEX = 'invalid index referenced';

const rawNode = (raw: Json | undefined): Node => ({ raw, which: 'raw', doc: null, ary: null });
const slotOf = (v: Json): Slot => (v === null ? null : rawNode(v));

function docOf(o: JsonObject): Map<string, Slot> {
  const m = new Map<string, Slot>();
  for (const k of Object.keys(o)) m.set(k, slotOf(o[k] as Json));
  return m;
}

function deref(n: Slot): Node {
  if (n === null) throw new GoPanic(NIL_DEREFERENCE);
  return n;
}

function goJsonKind(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'bool';
  return typeof v === 'object' ? 'object' : typeof v;
}

/** encoding/json UnmarshalTypeError.Error() at the top level of the decoded value. */
function unmarshalTypeError(v: Json, goType: string): string {
  return `json: cannot unmarshal ${goJsonKind(v)} into Go value of type ${goType}`;
}

// --- lazyNode ---

/** lazyNode.intoDoc, and tryDoc (which callers only reach on raw nodes). */
function intoDoc(n: Node): boolean {
  if (n.which === 'doc') return true;
  if (n.raw === undefined) return false; // ErrInvalid
  if (n.raw === null) n.doc = null; // json.Unmarshal of null into a map sets it to nil
  else if (typeof n.raw === 'object' && !Array.isArray(n.raw)) n.doc = docOf(n.raw);
  else return false;
  n.which = 'doc';
  return true;
}

/** lazyNode.intoAry, and tryAry. */
function intoAry(n: Node): boolean {
  if (n.which === 'ary') return true;
  if (n.raw === undefined) return false;
  if (n.raw === null) n.ary = null;
  else if (Array.isArray(n.raw)) n.ary = n.raw.map(slotOf);
  else return false;
  n.which = 'ary';
  return true;
}

/** bytes.Equal(n.compact(), o.compact()) for a raw node that is neither object nor array; see Numbers in the header. */
function rawEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (b !== null && typeof b === 'object') return false;
  return a === b;
}

/**
 * lazyNode.equal. It parses both sides as it goes. Go walks a partialDoc in map order, which is
 * random; that only decides between false and a panic when one member differs and another holds
 * an array with a null, and both abort the patch. This walks in sorted key order.
 */
function equal(n: Node, o: Slot): boolean {
  if (n.which === 'raw' && !intoDoc(n) && !intoAry(n)) {
    const oo = deref(o);
    if (oo.which !== 'raw') return false;
    return rawEqual(n.raw, oo.raw);
  }
  if (n.which === 'doc') {
    const oo = deref(o);
    if (oo.which === 'raw' && !intoDoc(oo)) return false;
    if (oo.which !== 'doc') return false;
    const nd = n.doc ?? new Map<string, Slot>();
    const od = oo.doc ?? new Map<string, Slot>();
    if (nd.size !== od.size) return false;
    for (const k of [...nd.keys()].sort(compareGoStrings)) {
      if (!od.has(k)) return false;
      const v = nd.get(k) ?? null;
      const ov = od.get(k) ?? null;
      if ((v === null) !== (ov === null)) return false;
      if (v === null || ov === null) continue;
      if (!equal(v, ov)) return false;
    }
    return true;
  }
  const oo = deref(o);
  if (oo.which !== 'ary' && !intoAry(oo)) return false;
  const na = n.ary ?? [];
  const oa = oo.ary ?? [];
  if (na.length !== oa.length) return false;
  for (let i = 0; i < na.length; i++) {
    // val.equal(o.ary[idx]) on a nil val dereferences it; a nil o.ary[idx] panics inside.
    if (!equal(deref(na[i] ?? null), oa[i] ?? null)) return false;
  }
  return true;
}

/** json.Marshal of a lazyNode (MarshalJSON) or container: maps with sorted keys, raw bytes as they are. */
function marshal(n: Slot): Json {
  if (n === null) return null;
  switch (n.which) {
    case 'raw':
      return n.raw === undefined ? null : cloneJson(n.raw);
    case 'doc': {
      if (n.doc === null) return null;
      const out: JsonObject = {};
      for (const k of [...n.doc.keys()].sort(compareGoStrings)) out[k] = marshal(n.doc.get(k) ?? null);
      return out;
    }
    case 'ary':
      return n.ary === null ? null : n.ary.map(marshal);
  }
}

/** deepCopy: a raw node holding the source's marshaled bytes; a nil source stays nil. */
function deepCopy(src: Slot): Slot {
  return src === null ? null : rawNode(marshal(src));
}

// --- strconv.Atoi ---

const MAX_UINT64 = (1n << 64n) - 1n;
const CUTOFF_10 = MAX_UINT64 / 10n + 1n;
const INT64_CUTOFF = 1n << 63n;

/**
 * strconv.Atoi on a 64-bit platform: the value, or the *NumError text. Its fast path (under 19
 * bytes) cannot overflow, so ParseInt's rules below give the same answer for every input.
 */
function atoi(s: string): bigint | { error: string } {
  const syntax = { error: `strconv.Atoi: parsing ${goQuote(s)}: invalid syntax` };
  const range = { error: `strconv.Atoi: parsing ${goQuote(s)}: value out of range` };
  const neg = s.startsWith('-');
  const digits = neg || s.startsWith('+') ? s.slice(1) : s;
  if (digits === '') return syntax;
  // ParseUint: the first bad byte or overflow, in order, decides the error.
  let n = 0n;
  for (const c of digits) {
    if (c < '0' || c > '9') return syntax;
    if (n >= CUTOFF_10) return range;
    n = n * 10n + BigInt(c.charCodeAt(0) - 48);
    if (n > MAX_UINT64) return range;
  }
  if (!neg && n >= INT64_CUTOFF) return range;
  if (neg && n > INT64_CUTOFF) return range;
  return neg ? -n : n;
}

const invalidIndex = (idx: bigint): string => `Unable to access invalid index: ${idx}: ${ERR_INVALID_INDEX}`;

// --- containers: partialDoc and partialArray get/set/add/remove; null is success ---

function containerGet(c: Node, key: string): { node: Slot } | { error: string } {
  if (c.which === 'doc') return { node: c.doc?.get(key) ?? null };
  const idx = atoi(key);
  if (typeof idx !== 'bigint') return idx;
  const ary = c.ary ?? [];
  const len = BigInt(ary.length);
  let i = idx;
  if (i < 0n) {
    if (i < -len) return { error: invalidIndex(i) };
    i += len;
  }
  if (i >= len) return { error: invalidIndex(i) };
  return { node: ary[Number(i)] ?? null };
}

/** set: only replace calls it, after get checked the key, so an index is in range. */
function containerSet(c: Node, key: string, val: Slot): string | null {
  if (c.which === 'doc') return docAssign(c, key, val);
  const idx = atoi(key);
  if (typeof idx !== 'bigint') return idx.error;
  const ary = c.ary ?? [];
  const len = BigInt(ary.length);
  let i = idx;
  if (i < 0n) {
    if (i < -len) return invalidIndex(i);
    i += len;
  }
  ary[Number(i)] = val;
  c.ary = ary;
  return null;
}

function containerAdd(c: Node, key: string, val: Slot): string | null {
  if (c.which === 'doc') return docAssign(c, key, val);
  const ary = c.ary ?? [];
  if (key === '-') {
    ary.push(val);
    c.ary = ary;
    return null;
  }
  const idx = atoi(key);
  if (typeof idx !== 'bigint') return `value was not a proper array index: '${key}': ${idx.error}`;
  const sz = BigInt(ary.length) + 1n;
  let i = idx;
  if (i >= sz) return invalidIndex(i);
  if (i < 0n) {
    if (i < -sz) return invalidIndex(i);
    i += sz;
  }
  ary.splice(Number(i), 0, val);
  c.ary = ary;
  return null;
}

function containerRemove(c: Node, key: string): string | null {
  if (c.which === 'doc') {
    if (c.doc === null || !c.doc.has(key)) return `Unable to remove nonexistent key: ${key}: ${ERR_MISSING}`;
    c.doc.delete(key);
    return null;
  }
  const idx = atoi(key);
  if (typeof idx !== 'bigint') return idx.error;
  const ary = c.ary ?? [];
  const len = BigInt(ary.length);
  let i = idx;
  if (i >= len) return invalidIndex(i);
  if (i < 0n) {
    if (i < -len) return invalidIndex(i);
    i += len;
  }
  ary.splice(Number(i), 1);
  c.ary = ary;
  return null;
}

function docAssign(c: Node, key: string, val: Slot): null {
  if (c.doc === null) throw new GoPanic(NIL_MAP_ASSIGNMENT);
  c.doc.set(key, val);
  return null;
}

// --- pointers ---

/** decodePatchKey: RFC 6901 unescaping, ~1 then ~0, in one left-to-right pass. */
const decodePatchKey = (k: string): string => k.replace(/~[01]/g, (m) => (m === '~1' ? '/' : '~'));

/** findObject: the container holding the path's last segment, and that segment unescaped. */
function findObject(root: Node, path: string): { con: Node; key: string } | null {
  const split = path.split('/');
  if (split.length < 2) return null;
  let doc = root;
  for (const part of split.slice(1, -1)) {
    const r = containerGet(doc, decodePatchKey(part));
    if ('error' in r) return null;
    const next = r.node;
    if (next === null || next.raw === undefined) return null;
    // isArray(*next.raw) picks how to parse it; a node keeps its kind, so raw still tells.
    if (!(Array.isArray(next.raw) ? intoAry(next) : intoDoc(next))) return null;
    doc = next;
  }
  return { con: doc, key: decodePatchKey(split[split.length - 1] as string) };
}

// --- operations ---

/** Operation.Kind. */
function kind(op: JsonPatchOperation): string {
  const v = op['op'];
  return typeof v === 'string' ? v : 'unknown';
}

/** Operation.Path and Operation.From: the string, or the error. */
function stringField(op: JsonPatchOperation, field: 'path' | 'from', missing: string): { ok: string } | { error: string } {
  const v = Object.hasOwn(op, field) ? (op[field] as Json) : null;
  if (v === null) return { error: `${missing}: ${ERR_MISSING}` };
  if (typeof v !== 'string') return { error: unmarshalTypeError(v, 'string') };
  return { ok: v };
}
const opPath = (op: JsonPatchOperation) => stringField(op, 'path', 'operation missing path field');
const opFrom = (op: JsonPatchOperation) => stringField(op, 'from', 'operation, missing from field');

/** Operation.value: nil without a "value" member, a node with nil raw for `"value": null`. */
function opValue(op: JsonPatchOperation): Slot {
  if (!Object.hasOwn(op, 'value')) return null;
  const v = op['value'] as Json;
  return rawNode(v === null ? undefined : v);
}

function applyOp(root: Node, op: JsonPatchOperation): string | null {
  switch (kind(op)) {
    case 'add':
      return add(root, op);
    case 'remove':
      return remove(root, op);
    case 'replace':
      return replace(root, op);
    case 'move':
      return move(root, op);
    case 'test':
      return test(root, op);
    case 'copy':
      return copy(root, op);
    default:
      return `Unexpected kind: ${kind(op)}`;
  }
}

function add(root: Node, op: JsonPatchOperation): string | null {
  const path = opPath(op);
  if ('error' in path) return `add operation failed to decode path: ${ERR_MISSING}`;
  const f = findObject(root, path.ok);
  if (f === null) return `add operation does not apply: doc is missing path: "${path.ok}": ${ERR_MISSING}`;
  const err = containerAdd(f.con, f.key, opValue(op));
  return err === null ? null : `error in add for path: '${path.ok}': ${err}`;
}

function remove(root: Node, op: JsonPatchOperation): string | null {
  const path = opPath(op);
  if ('error' in path) return `remove operation failed to decode path: ${ERR_MISSING}`;
  const f = findObject(root, path.ok);
  if (f === null) return `remove operation does not apply: doc is missing path: "${path.ok}": ${ERR_MISSING}`;
  const err = containerRemove(f.con, f.key);
  return err === null ? null : `error in remove for path: '${path.ok}': ${err}`;
}

function replace(root: Node, op: JsonPatchOperation): string | null {
  const path = opPath(op);
  if ('error' in path) return `replace operation failed to decode path: ${path.error}`;
  if (path.ok === '') {
    const val = deref(opValue(op));
    // upstream wraps the (nil) path error with %w here, so fmt prints %!w(<nil>).
    if (val.which === 'raw' && !intoDoc(val) && !intoAry(val)) return 'replace operation value must be object or array: %!w(<nil>)';
    root.which = val.which;
    root.doc = val.doc;
    root.ary = val.ary;
    return null;
  }
  const f = findObject(root, path.ok);
  if (f === null) return `replace operation does not apply: doc is missing path: ${path.ok}: ${ERR_MISSING}`;
  if ('error' in containerGet(f.con, f.key)) return `replace operation does not apply: doc is missing key: ${path.ok}: ${ERR_MISSING}`;
  const err = containerSet(f.con, f.key, opValue(op));
  return err === null ? null : `error in remove for path: '${path.ok}': ${err}`; // sic: upstream says remove
}

function move(root: Node, op: JsonPatchOperation): string | null {
  const from = opFrom(op);
  if ('error' in from) return `move operation failed to decode from: ${from.error}`;
  const src = findObject(root, from.ok);
  if (src === null) return `move operation does not apply: doc is missing from path: ${from.ok}: ${ERR_MISSING}`;
  // These two quote the last segment, not the path.
  const got = containerGet(src.con, src.key);
  if ('error' in got) return `error in move for path: '${src.key}': ${got.error}`;
  const removed = containerRemove(src.con, src.key);
  if (removed !== null) return `error in move for path: '${src.key}': ${removed}`;
  const path = opPath(op);
  if ('error' in path) return `move operation failed to decode path: ${path.error}`;
  const dst = findObject(root, path.ok);
  if (dst === null) return `move operation does not apply: doc is missing destination path: ${path.ok}: ${ERR_MISSING}`;
  const err = containerAdd(dst.con, dst.key, got.node);
  return err === null ? null : `error in move for path: '${path.ok}': ${err}`;
}

function test(root: Node, op: JsonPatchOperation): string | null {
  const path = opPath(op);
  if ('error' in path) return `test operation failed to decode path: ${path.error}`;
  const failed = `testing value ${path.ok} failed: ${ERR_TEST_FAILED}`;
  const want = opValue(op);
  if (path.ok === '') return equal(root, want) ? null : failed;
  const f = findObject(root, path.ok);
  if (f === null) return `test operation does not apply: is missing path: ${path.ok}: ${ERR_MISSING}`;
  const got = containerGet(f.con, f.key);
  if ('error' in got) return `error in test for path: '${path.ok}': ${got.error}`;
  if (got.node === null) return want === null || want.raw === undefined ? null : failed;
  if (want === null) return failed;
  return equal(got.node, want) ? null : failed;
}

function copy(root: Node, op: JsonPatchOperation): string | null {
  const from = opFrom(op);
  if ('error' in from) return `copy operation failed to decode from: ${from.error}`;
  const src = findObject(root, from.ok);
  if (src === null) return `copy operation does not apply: doc is missing from path: ${from.ok}: ${ERR_MISSING}`;
  const got = containerGet(src.con, src.key);
  if ('error' in got) return `error in copy for from: '${from.ok}': ${got.error}`;
  const path = opPath(op);
  if ('error' in path) return `copy operation failed to decode path: ${ERR_MISSING}`;
  // The destination is found (and its containers parsed) before the copy is serialized.
  const dst = findObject(root, path.ok);
  if (dst === null) return `copy operation does not apply: doc is missing destination path: ${path.ok}: ${ERR_MISSING}`;
  // AccumulatedCopySizeLimit is 0 (no limit) in the API server, so the size is not tracked.
  const err = containerAdd(dst.con, dst.key, deepCopy(got.node));
  return err === null ? null : `error while adding value during copy: ${err}`;
}
