// Stored v1 JSON → the Go value a controller holds after its informer decoded the object from
// protobuf (kube-controller-manager's default --kube-api-content-type is
// application/vnd.kubernetes.protobuf), as the GoValue model of spew.ts.
//
// Layouts of the API structs come from the Go sources (npm run api:vendor writes them to
// openapi/data/<tag>.golayout.ts; format in tools/src/openapi/vendor.ts). The few library types
// with their own encoding are written out here, each with its source.
//
// What protobuf decoding gives that JSON does not say directly (upstream:
// staging/src/k8s.io/api/core/v1/generated.pb.go Unmarshal): a repeated field or map with no
// entries is never allocated, so an empty list or map is nil whatever the JSON showed; an optional
// message or scalar pointer is set exactly when the field was on the wire, which is when the
// stored JSON has it (encoding/json omits only nil pointers).

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { parseQuantity, type Quantity } from '../../apimachinery/quantity.ts';
import { parseTime } from '../../apimachinery/time.ts';
import { goJson } from '../../apimachinery/json.ts';
import { DATA } from '../../openapi/data/v1.37.2.golayout.ts';
import type { GoValue } from './spew.ts';

type Expr =
  | { k: 'basic'; name: string }
  | { k: 'bytes' }
  | { k: 'ptr'; elem: Expr }
  | { k: 'slice'; elem: Expr }
  | { k: 'map'; key: Expr; elem: Expr }
  | { k: 'named'; id: string };

type Layout =
  | { n: string; f: [string, string, string][] }
  | { n: string; u: string }
  | { n: string; c: 'time' | 'quantity' | 'intstr' | 'json' | string };

let layouts: Record<string, Layout> | undefined;
const parsed = new Map<string, Expr>();

function layout(id: string): Layout {
  layouts ??= (JSON.parse(DATA) as { types: Record<string, Layout> }).types;
  const l = layouts[id];
  if (!l) throw new Error(`no Go layout for ${id} (npm run api:vendor, LAYOUT_ROOTS)`);
  return l;
}

function parseExpr(s: string): Expr {
  const cached = parsed.get(s);
  if (cached) return cached;
  let e: Expr;
  if (s.startsWith('*')) e = { k: 'ptr', elem: parseExpr(s.slice(1)) };
  else if (s.startsWith('[]')) e = { k: 'slice', elem: parseExpr(s.slice(2)) };
  else if (s.startsWith('map[')) {
    // Key types are basic or named: no brackets inside.
    const close = s.indexOf(']');
    e = { k: 'map', key: parseExpr(s.slice(4, close)), elem: parseExpr(s.slice(close + 1)) };
  } else if (s === 'bytes') e = { k: 'bytes' };
  else if (s.startsWith('@')) e = { k: 'named', id: s.slice(1) };
  else e = { k: 'basic', name: s };
  parsed.set(s, e);
  return e;
}

/** reflect's Type.String() of a type expression. */
function display(e: Expr): string {
  switch (e.k) {
    case 'basic':
      return e.name;
    case 'bytes':
      return '[]uint8';
    case 'ptr':
      return '*' + display(e.elem);
    case 'slice':
      return '[]' + display(e.elem);
    case 'map':
      return `map[${display(e.key)}]${display(e.elem)}`;
    case 'named':
      return layout(e.id).n;
  }
}

const SIGNED = new Set(['int', 'int8', 'int16', 'int32', 'int64']);
const UNSIGNED = new Set(['uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr']);

const str = (t: string, v: string): GoValue => ({ k: 'string', t, v });
const int = (t: string, v: number | bigint): GoValue => ({ k: 'int', t, v: BigInt(v) });
const uint = (t: string, v: number | bigint): GoValue => ({ k: 'uint', t, v: BigInt(v) });
const nilPtr = (t: string): GoValue => ({ k: 'ptr', t, elem: null });
const struct = (t: string, fields: [string, GoValue][]): GoValue => ({ k: 'struct', t, fields });

/** The Go value of the root type `id` (a layout key such as `core/v1.PodTemplateSpec`) for `json`. */
export function goValueOf(id: string, json: JsonObject | undefined): GoValue {
  return decode({ k: 'named', id }, json);
}

function decode(e: Expr, json: Json | undefined): GoValue {
  const v = json === null ? undefined : json;
  const t = display(e);
  switch (e.k) {
    case 'basic':
      if (e.name === 'string') return str(t, typeof v === 'string' ? v : '');
      if (e.name === 'bool') return { k: 'bool', t, v: v === true };
      if (SIGNED.has(e.name)) return int(t, typeof v === 'number' ? v : 0);
      if (UNSIGNED.has(e.name)) return uint(t, typeof v === 'number' ? v : 0);
      throw new Error(`hash: Go type ${e.name} is not supported`);
    case 'bytes':
      throw new Error('hash: []byte fields are not supported');
    case 'ptr':
      return v === undefined ? nilPtr(t) : { k: 'ptr', t, elem: decode(e.elem, v) };
    case 'slice': {
      const items = Array.isArray(v) ? v : [];
      return { k: 'slice', t, elems: items.length === 0 ? null : items.map((x) => decode(e.elem, x)) };
    }
    case 'map': {
      const entries = v !== undefined && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [];
      return {
        k: 'map',
        t,
        entries: entries.length === 0 ? null : entries.map(([key, x]) => [decode(e.key, key), decode(e.elem, x)] as const),
      };
    }
    case 'named':
      return decodeNamed(e.id, v);
  }
}

function decodeNamed(id: string, v: Json | undefined): GoValue {
  const l = layout(id);
  if ('u' in l) return { ...decode(parseExpr(l.u), v), t: l.n };
  if ('c' in l) {
    switch (l.c) {
      case 'quantity':
        return quantityValue(l.n, v);
      case 'intstr':
        return intOrStringValue(l.n, v);
      case 'time':
        return timeValue(l.n, v);
      case 'json':
        return fieldsV1Value(l.n, v);
      default:
        throw new Error(`hash: custom type ${id} (${l.c}) is not supported`);
    }
  }
  const obj = v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  return struct(
    l.n,
    l.f.map(([goName, json, type]): [string, GoValue] => {
      const fe = parseExpr(type);
      if (json === '') {
        // An embedded struct whose fields sit in the enclosing JSON object.
        if (fe.k !== 'named') throw new Error(`hash: embedded ${goName} of ${id} is not a struct value`);
        return [goName, decode(fe, obj ?? {})];
      }
      return [goName, decode(fe, json === '-' ? undefined : obj?.[json])];
    }),
  );
}

// ---- resource.Quantity ----
// upstream: staging/src/k8s.io/apimachinery/pkg/api/resource/quantity.go type Quantity
// {i int64Amount; d infDecAmount; s string; Format}; amount.go int64Amount {value int64; scale
// Scale}, infDecAmount {*inf.Dec}, type Scale int32; vendor/gopkg.in/inf.v0/dec.go Dec {unscaled
// big.Int; scale Scale}, type Scale int32; Go src/math/big/int.go Int {neg bool; abs nat},
// nat.go nat []Word (Word is uint: 64-bit words on amd64 and arm64, least significant first; zero
// is the empty nat, nil after norm of a nil slice).
// On the wire a Quantity is its canonical string (quantity_proto.go Marshal writes m.String());
// Unmarshal sets *m = ParseQuantity(s), so the decoded value is ParseQuantity of the stored string,
// with whatever `s` ParseQuantity caches and the inf.Dec it builds on the slow path.

const DEC_T = 'inf.Dec';

function quantityValue(t: string, v: Json | undefined): GoValue {
  let q: Quantity | undefined;
  if (typeof v === 'string') {
    const r = parseQuantity(v);
    if ('error' in r) throw new Error(`hash: stored quantity ${JSON.stringify(v)} does not parse: ${r.error}`);
    q = r;
  }
  const isInt = q !== undefined && q.rep === 'int64';
  const i = struct('resource.int64Amount', [
    ['value', int('int64', isInt ? q!.unscaled : 0n)],
    ['scale', int('resource.Scale', isInt ? q!.scale : 0)],
  ]);
  const dec = q !== undefined && q.rep === 'dec' ? infDec(q.unscaled, -q.scale) : null;
  const d = struct('resource.infDecAmount', [['Dec', { k: 'ptr', t: '*' + DEC_T, elem: dec }]]);
  return struct(t, [
    ['i', i],
    ['d', d],
    ['s', str('string', q?.s ?? '')],
    ['Format', str('resource.Format', q?.format ?? '')],
  ]);
}

function infDec(unscaled: bigint, infScale: number): GoValue {
  const neg = unscaled < 0n;
  let abs = neg ? -unscaled : unscaled;
  const words: GoValue[] = [];
  while (abs > 0n) {
    words.push(uint('big.Word', abs & 0xffffffffffffffffn));
    abs >>= 64n;
  }
  const bigInt = struct('big.Int', [
    ['neg', { k: 'bool', t: 'bool', v: neg }],
    ['abs', { k: 'slice', t: 'big.nat', elems: words.length === 0 ? null : words }],
  ]);
  return struct(DEC_T, [
    ['unscaled', bigInt],
    ['scale', int('inf.Scale', infScale)],
  ]);
}

// ---- intstr.IntOrString ----
// upstream: staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go IntOrString {Type Type;
// IntVal int32; StrVal string}, type Type int64, Int = 0, String = 1; on the wire the three fields.

function intOrStringValue(t: string, v: Json | undefined): GoValue {
  const isStr = typeof v === 'string';
  return struct(t, [
    ['Type', int('intstr.Type', isStr ? 1 : 0)],
    ['IntVal', int('int32', typeof v === 'number' ? v : 0)],
    ['StrVal', str('string', isStr ? v : '')],
  ]);
}

// ---- metav1.Time ----
// upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/time.go Time {time.Time};
// time_proto.go: Marshal writes nothing for the zero time, Unmarshal of nothing gives time.Time{},
// otherwise time.Unix(p.Seconds, 0).Local(). Go src/time/time.go (the workstation's go1.27.4, same
// layout as the go1.26 the pin builds with): Time {wall uint64; ext int64; loc *Location};
// unixTime gives wall = nsec (0) and ext = sec + unixToInternal; Local() points loc at &localLoc.
// zoneinfo.go Location {name string; zone []zone; tx []zoneTrans; extend string; cacheStart,
// cacheEnd int64; cacheZone *zone}.
//
// localLoc depends on the controller-manager's environment (zoneinfo_unix.go initLocal): the
// zone file /etc/localtime when TZ is unset, UTC when it is missing or TZ is empty. Modeled: the
// UTC fallback, name "UTC" and nothing else set, which is a kubeadm control plane (the static Pod
// mounts no /etc/localtime into a distroless image). A controller-manager that loaded a zone file
// prints that file's transition table instead, and its hashes differ.

const UNIX_TO_INTERNAL = 62135596800n; // (1969*365 + 1969/4 - 1969/100 + 1969/400) * 86400

function timeValue(t: string, v: Json | undefined): GoValue {
  let sec: bigint | undefined;
  if (typeof v === 'string') {
    const r = parseTime(v, false);
    if ('error' in r) throw new Error(`hash: stored time ${JSON.stringify(v)} does not parse: ${r.error}`);
    sec = BigInt(Math.floor(r.micros / 1e6));
  }
  const loc =
    sec === undefined
      ? nilPtr('*time.Location')
      : {
          k: 'ptr' as const,
          t: '*time.Location',
          elem: struct('time.Location', [
            ['name', str('string', 'UTC')],
            ['zone', { k: 'slice', t: '[]time.zone', elems: null }],
            ['tx', { k: 'slice', t: '[]time.zoneTrans', elems: null }],
            ['extend', str('string', '')],
            ['cacheStart', int('int64', 0)],
            ['cacheEnd', int('int64', 0)],
            ['cacheZone', nilPtr('*time.zone')],
          ]),
        };
  return struct(t, [
    [
      'Time',
      struct('time.Time', [
        ['wall', uint('uint64', 0)],
        ['ext', int('int64', sec === undefined ? 0n : sec + UNIX_TO_INTERNAL)],
        ['loc', loc],
      ]),
    ],
  ]);
}

// ---- metav1.FieldsV1 ----
// upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go FieldsV1 {Raw []byte};
// generated.pb.go keeps the raw bytes, a present field gives a non-nil slice. Only managedFields
// entries hold one, and a Pod template has none in practice. The bytes are taken as Go's compact
// encoding of the stored object, which is what the API server writes for server-side apply.

function fieldsV1Value(t: string, v: Json | undefined): GoValue {
  if (v === undefined) return struct(t, [['Raw', { k: 'slice', t: '[]uint8', elems: null }]]);
  const bytes = utf8(goJson(v));
  return struct(t, [['Raw', { k: 'slice', t: '[]uint8', elems: bytes.map((b) => uint('uint8', b)) }]]);
}

/** UTF-8 bytes of a string (what Go holds for it). */
export function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
