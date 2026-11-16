// YAML to JSON as sigs.k8s.io/yaml does it: yaml.v2's Unmarshal of the first document into
// interface{} (composer and decoder below, over the libyaml event stream of parser.ts), then
// convertToJSONableObject (non-string keys become strings) and encoding/json's Marshal.
//
// upstream: vendor/go.yaml.in/yaml/v2/decode.go (parser: parse, document, alias, scalar,
// sequence, mapping, fail; decoder: unmarshal, alias, scalar, sequence, mapping, merge,
// isMerge, allowedAliasRatio), yaml.go (unmarshal: first document only, failf's "yaml: "
// prefix), vendor/sigs.k8s.io/yaml/yaml.go (Unmarshal, YAMLToJSON, yamlToJSONTarget,
// convertToJSONableObject), Go encoding/json encode.go (UnsupportedValueError for NaN and
// infinities, invalid UTF-8 written as U+FFFD), encoding/base64 (StdEncoding.DecodeString
// ignores \r and \n).

import type { Json, JsonObject } from '../json.ts';
import { YamlSyntaxError, type YamlEvent } from './events.ts';
import { formatFloatG, goSyntax, GoFormatUnsupported, compareGoStrings } from './gofmt.ts';
import { newParser, nextEvent, type YamlParser } from './parser.ts';
import { BINARY_TAG, MERGE_TAG, resolve, ResolveError, STR_TAG, TIMESTAMP_TAG, type GoValue } from './resolve.ts';

/** The outcome of converting YAML: a value, the error text kubectl would show, or input the simulator cannot handle exactly. */
export type YamlResult = { ok: true; value: Json } | { ok: false; error: string } | { ok: false; unsupported: string };

/** A yaml.v2 failure: the message is complete (`yaml: line 3: …`). */
class YamlFail extends Error {}

/** Input whose real behavior depends on something the simulator cannot reproduce (Go map order). */
export class YamlUnsupported extends Error {}

// ---- composer (decode.go parser) ----

interface Node {
  kind: 'document' | 'mapping' | 'sequence' | 'scalar' | 'alias';
  line: number;
  column: number;
  tag: string;
  value: string;
  implicit: boolean;
  children: Node[];
  alias?: Node | undefined;
}

interface Composer {
  p: YamlParser;
  event: YamlEvent | undefined;
  anchors: Record<string, Node>;
  doneInit: boolean;
}

function fail(e: YamlSyntaxError): never {
  let line = 0;
  if (e.problemMark.line !== 0) {
    line = e.problemMark.line;
    // Scanner errors don't iterate line before returning error.
    if (e.kind === 'scanner') line++;
  } else if (e.contextMark.line !== 0) {
    line = e.contextMark.line;
  }
  const where = line !== 0 ? `line ${line}: ` : '';
  const msg = e.problem.length > 0 ? e.problem : 'unknown problem parsing YAML content';
  throw new YamlFail(`yaml: ${where}${msg}`);
}

function peek(c: Composer): YamlEvent {
  if (c.event === undefined) {
    try {
      c.event = nextEvent(c.p);
    } catch (e) {
      if (e instanceof YamlSyntaxError) fail(e);
      throw e;
    }
  }
  return c.event;
}

function expect(c: Composer, type: YamlEvent['type']): YamlEvent {
  const ev = peek(c);
  if (ev.type === 'stream-end' && type !== 'stream-end') throw new YamlFail('yaml: attempted to go past the end of stream; corrupted value?');
  if (ev.type !== type) throw new YamlFail(`yaml: expected ${type.replace('-', ' ')} event but got ${ev.type.replace('-', ' ')}`);
  c.event = undefined;
  return ev;
}

function node(kind: Node['kind'], ev: YamlEvent): Node {
  return { kind, line: ev.start.line, column: ev.start.column, tag: '', value: '', implicit: false, children: [] };
}

function anchor(c: Composer, n: Node, name: string): void {
  if (name !== '') c.anchors[name] = n;
}

function compose(c: Composer): Node | undefined {
  if (!c.doneInit) {
    expect(c, 'stream-start');
    c.doneInit = true;
  }
  const ev = peek(c);
  switch (ev.type) {
    case 'scalar': {
      const n = node('scalar', ev);
      n.value = ev.value;
      n.tag = ev.tag;
      n.implicit = ev.implicit;
      anchor(c, n, ev.anchor);
      expect(c, 'scalar');
      return n;
    }
    case 'alias': {
      const n = node('alias', ev);
      n.value = ev.anchor;
      n.alias = c.anchors[n.value];
      if (n.alias === undefined) throw new YamlFail(`yaml: unknown anchor '${n.value}' referenced`);
      expect(c, 'alias');
      return n;
    }
    case 'mapping-start': {
      const n = node('mapping', ev);
      anchor(c, n, ev.anchor);
      expect(c, 'mapping-start');
      while (peek(c).type !== 'mapping-end') n.children.push(composeChild(c), composeChild(c));
      expect(c, 'mapping-end');
      return n;
    }
    case 'sequence-start': {
      const n = node('sequence', ev);
      anchor(c, n, ev.anchor);
      expect(c, 'sequence-start');
      while (peek(c).type !== 'sequence-end') n.children.push(composeChild(c));
      expect(c, 'sequence-end');
      return n;
    }
    case 'document-start': {
      const n = node('document', ev);
      c.anchors = {};
      expect(c, 'document-start');
      n.children.push(composeChild(c));
      expect(c, 'document-end');
      return n;
    }
    case 'stream-end':
      // Happens when attempting to decode an empty buffer.
      return undefined;
    default:
      throw new YamlFail(`yaml: attempted to parse unknown event: ${ev.type}`);
  }
}

function composeChild(c: Composer): Node {
  const n = compose(c);
  // A child position never sees STREAM-END from a correct parser; decode.go would store nil.
  if (n === undefined) throw new YamlFail('yaml: attempted to go past the end of stream; corrupted value?');
  return n;
}

// ---- decoder into interface{} ----

interface Decoder {
  aliases: Node[];
  decodeCount: number;
  aliasCount: number;
  aliasDepth: number;
}

const ALIAS_RATIO_RANGE_LOW = 400000;
const ALIAS_RATIO_RANGE_HIGH = 4000000;

function allowedAliasRatio(decodeCount: number): number {
  if (decodeCount <= ALIAS_RATIO_RANGE_LOW) return 0.99;
  if (decodeCount >= ALIAS_RATIO_RANGE_HIGH) return 0.1;
  return 0.99 - 0.89 * ((decodeCount - ALIAS_RATIO_RANGE_LOW) / (ALIAS_RATIO_RANGE_HIGH - ALIAS_RATIO_RANGE_LOW));
}

/** Go's == on two interface{} values holding these dynamic types (NaN is never equal). */
function goEqual(a: GoValue, b: GoValue): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'nil':
      return true;
    case 'bool':
    case 'int':
    case 'uint':
    case 'float':
    case 'string':
      return a.v === (b as typeof a).v;
    default:
      // Unhashable: decode.go fails before a map or slice becomes a key.
      return false;
  }
}

function setMapIndex(m: Extract<GoValue, { k: 'map' }>, key: GoValue, value: GoValue): void {
  const existing = m.entries.find((e) => goEqual(e.key, key));
  if (existing) existing.value = value;
  else m.entries.push({ key, value });
}

/** Go's base64.StdEncoding.DecodeString, as bytes; undefined on corrupt input. */
function decodeBase64(s: string): number[] | undefined {
  const t = s.replace(/[\r\n]/g, '');
  if (t.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t)) return undefined;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 4) {
    const q = t.slice(i, i + 4);
    const v = [...q].map((ch) => (ch === '=' ? 0 : alphabet.indexOf(ch)));
    const n = ((v[0] as number) << 18) | ((v[1] as number) << 12) | ((v[2] as number) << 6) | (v[3] as number);
    out.push((n >> 16) & 0xff);
    if (q[2] !== '=') out.push((n >> 8) & 0xff);
    if (q[3] !== '=') out.push(n & 0xff);
  }
  return out;
}

/** A Go string of these bytes as encoding/json writes it: each invalid UTF-8 byte becomes U+FFFD. */
function goBytesToString(b: number[]): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    const cont = (k: number): boolean => i + k < b.length && ((b[i + k] as number) & 0xc0) === 0x80;
    let cp = -1;
    let n = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c <= 0xdf && cont(1)) [cp, n] = [((c & 0x1f) << 6) | ((b[i + 1] as number) & 0x3f), 2];
    else if (c >= 0xe0 && c <= 0xef && cont(1) && cont(2)) {
      const v = ((c & 0x0f) << 12) | (((b[i + 1] as number) & 0x3f) << 6) | ((b[i + 2] as number) & 0x3f);
      if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) [cp, n] = [v, 3];
    } else if (c >= 0xf0 && c <= 0xf4 && cont(1) && cont(2) && cont(3)) {
      const v = ((c & 0x07) << 18) | (((b[i + 1] as number) & 0x3f) << 12) | (((b[i + 2] as number) & 0x3f) << 6) | ((b[i + 3] as number) & 0x3f);
      if (v >= 0x10000 && v <= 0x10ffff) [cp, n] = [v, 4];
    }
    out += cp < 0 ? '�' : String.fromCodePoint(cp);
    i += cp < 0 ? 1 : n;
  }
  return out;
}

function unmarshal(d: Decoder, n: Node): GoValue {
  d.decodeCount++;
  if (d.aliasDepth > 0) d.aliasCount++;
  if (d.aliasCount > 100 && d.decodeCount > 1000 && d.aliasCount / d.decodeCount > allowedAliasRatio(d.decodeCount)) {
    throw new YamlFail('yaml: document contains excessive aliasing');
  }
  switch (n.kind) {
    case 'document':
      return unmarshal(d, n.children[0] as Node);
    case 'alias': {
      if (d.aliases.includes(n)) throw new YamlFail(`yaml: anchor '${n.value}' value contains itself`);
      d.aliases.push(n);
      d.aliasDepth++;
      const v = unmarshal(d, n.alias as Node);
      d.aliasDepth--;
      d.aliases.splice(d.aliases.indexOf(n), 1);
      return v;
    }
    case 'scalar':
      return scalar(n);
    case 'sequence':
      return { k: 'seq', items: n.children.map((c) => unmarshal(d, c)) };
    case 'mapping': {
      const m: Extract<GoValue, { k: 'map' }> = { k: 'map', entries: [] };
      mappingInto(d, n, m);
      return m;
    }
  }
}

function scalar(n: Node): GoValue {
  let tag: string;
  let resolved: GoValue;
  if (n.tag === '' && !n.implicit) {
    tag = STR_TAG;
    resolved = { k: 'string', v: n.value };
  } else {
    try {
      ({ tag, value: resolved } = resolve(n.tag, n.value));
    } catch (e) {
      if (e instanceof ResolveError) throw new YamlFail(`yaml: ${e.message}`);
      throw e;
    }
    if (tag === BINARY_TAG) {
      const bytes = decodeBase64(n.value);
      if (bytes === undefined) throw new YamlFail('yaml: !!binary value contains invalid base64 data');
      resolved = { k: 'string', v: goBytesToString(bytes) };
    }
  }
  // It looks like a timestamp but for backward compatibility reasons it is set as a string.
  if (tag === TIMESTAMP_TAG && resolved.k !== 'nil') return { k: 'string', v: n.value };
  return resolved;
}

function isMerge(n: Node): boolean {
  return n.kind === 'scalar' && n.value === '<<' && (n.implicit || n.tag === MERGE_TAG);
}

function failWantMap(): never {
  throw new YamlFail('yaml: map merge requires map or sequence of maps as the value');
}

/** d.mapping with an existing map as the target (also what a merge decodes into). */
function mappingInto(d: Decoder, n: Node, m: Extract<GoValue, { k: 'map' }>): void {
  for (let i = 0; i < n.children.length; i += 2) {
    const kn = n.children[i] as Node;
    const vn = n.children[i + 1] as Node;
    if (isMerge(kn)) {
      merge(d, vn, m);
      continue;
    }
    const k = unmarshal(d, kn);
    if (k.k === 'map' || k.k === 'seq') throw new YamlFail(`yaml: invalid map key: ${goSyntaxOrUnsupported(k, false)}`);
    setMapIndex(m, k, unmarshal(d, vn));
  }
}

/** Decode a node into an existing map, following aliases (d.unmarshal(n, out) with a map out). */
function unmarshalInto(d: Decoder, n: Node, m: Extract<GoValue, { k: 'map' }>): void {
  d.decodeCount++;
  if (d.aliasDepth > 0) d.aliasCount++;
  if (n.kind === 'alias') {
    if (d.aliases.includes(n)) throw new YamlFail(`yaml: anchor '${n.value}' value contains itself`);
    d.aliases.push(n);
    d.aliasDepth++;
    unmarshalInto(d, n.alias as Node, m);
    d.aliasDepth--;
    d.aliases.splice(d.aliases.indexOf(n), 1);
    return;
  }
  mappingInto(d, n, m);
}

function merge(d: Decoder, n: Node, m: Extract<GoValue, { k: 'map' }>): void {
  switch (n.kind) {
    case 'mapping':
      return unmarshalInto(d, n, m);
    case 'alias':
      if (n.alias && n.alias.kind !== 'mapping') failWantMap();
      return unmarshalInto(d, n, m);
    case 'sequence':
      for (let i = n.children.length - 1; i >= 0; i--) {
        const ni = n.children[i] as Node;
        if (ni.kind === 'alias') {
          if (ni.alias && ni.alias.kind !== 'mapping') failWantMap();
        } else if (ni.kind !== 'mapping') failWantMap();
        unmarshalInto(d, ni, m);
      }
      return;
    default:
      failWantMap();
  }
}

function goSyntaxOrUnsupported(v: GoValue, top: boolean): string {
  try {
    return goSyntax(v, top);
  } catch (e) {
    if (e instanceof GoFormatUnsupported) throw new YamlUnsupported(`an error message that prints ${e.message}`);
    throw e;
  }
}

/** yaml.v2's Unmarshal(in, &v) with v an interface{}: the first document, or nil. */
export function unmarshalFirstDocument(text: string): GoValue {
  const c: Composer = { p: newParser(text === '' ? '\n' : text), event: undefined, anchors: {}, doneInit: false };
  const n = compose(c);
  if (n === undefined) return { k: 'nil' };
  return unmarshal({ aliases: [], decodeCount: 0, aliasCount: 0, aliasDepth: 0 }, n);
}

/** yaml.v2's Unmarshal into interface{}: the value, or the error text (`yaml: line 3: …`). */
export function yamlV2Unmarshal(text: string): { ok: true; value: GoValue } | { ok: false; error: string } | { ok: false; unsupported: string } {
  try {
    return { ok: true, value: unmarshalFirstDocument(text) };
  } catch (e) {
    if (e instanceof YamlFail) return { ok: false, error: e.message };
    if (e instanceof YamlUnsupported) return { ok: false, unsupported: e.message };
    throw e;
  }
}

// ---- convertToJSONableObject and json.Marshal ----

/** A value on its way to JSON: keys are strings now, floats are kept until json.Marshal checks them. */
type Conv =
  | { t: 'scalar'; v: string | boolean | number | null }
  | { t: 'float'; v: number }
  | { t: 'array'; items: Conv[] }
  | { t: 'object'; entries: [string, Conv][] };

function convert(v: GoValue): Conv {
  switch (v.k) {
    case 'map': {
      const entries: [string, Conv][] = [];
      const problems: string[] = [];
      for (const { key, value } of v.entries) {
        let ks: string;
        switch (key.k) {
          case 'string':
            ks = key.v;
            break;
          case 'int':
            ks = key.v.toString();
            break;
          case 'float': {
            // FormatFloat(typedKey, 'g', -1, 32), with yaml's names for the specials.
            const s = formatFloatG(key.v, 32);
            ks = s === '+Inf' ? '.inf' : s === '-Inf' ? '-.inf' : s === 'NaN' ? '.nan' : s;
            break;
          }
          case 'bool':
            ks = key.v ? 'true' : 'false';
            break;
          default: {
            // reflect.TypeOf(nil) printed with %s is "%!s(<nil>)".
            const type = key.k === 'nil' ? '%!s(<nil>)' : 'uint64';
            problems.push(`unsupported map key of type: ${type}, key: ${goSyntaxOrUnsupported(key, true)}, value: ${goSyntaxOrUnsupported(value, true)}`);
            continue;
          }
        }
        if (entries.some(([k]) => k === ks)) {
          // Two Go keys of different types became one string: which one wins depends on Go's
          // random map iteration order.
          throw new YamlUnsupported(`two mapping keys that both convert to the JSON key ${JSON.stringify(ks)}`);
        }
        try {
          entries.push([ks, convert(value)]);
        } catch (e) {
          if (e instanceof YamlFail) problems.push(e.message);
          else throw e;
        }
      }
      // Go iterates the map in random order and returns the first error it meets.
      if (problems.length > 1) throw new YamlUnsupported('a mapping with more than one key that JSON cannot hold');
      if (problems.length === 1) throw new YamlFail(problems[0] as string);
      return { t: 'object', entries };
    }
    case 'seq':
      return { t: 'array', items: v.items.map((x) => convert(x)) };
    case 'nil':
      return { t: 'scalar', v: null };
    case 'bool':
    case 'string':
      return { t: 'scalar', v: v.v };
    case 'int':
    case 'uint':
      return { t: 'scalar', v: Number(v.v) };
    case 'float':
      return { t: 'float', v: v.v };
  }
}

/** json.Marshal: sorted keys; NaN and infinities fail with the first one met in that order. */
function marshalJson(v: Conv): Json {
  switch (v.t) {
    case 'scalar':
      return v.v;
    case 'float':
      if (!Number.isFinite(v.v)) throw new YamlFail(`json: unsupported value: ${formatFloatG(v.v, 64)}`);
      return v.v;
    case 'array':
      return v.items.map((x) => marshalJson(x));
    case 'object': {
      const out: JsonObject = {};
      for (const [k, x] of [...v.entries].sort((a, b) => compareGoStrings(a[0], b[0]))) out[k] = marshalJson(x);
      return out;
    }
  }
}

function run(f: () => Json, prefix: string): YamlResult {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (e instanceof YamlFail) return { ok: false, error: prefix + e.message };
    if (e instanceof YamlUnsupported) return { ok: false, unsupported: e.message };
    throw e;
  }
}

/** sigs.k8s.io/yaml.YAMLToJSON: errors read `yaml: line 3: …` (what a YAML serializer, e.g. kubeconfig loading, returns). */
export function yamlToJson(text: string): YamlResult {
  return run(() => marshalJson(convert(unmarshalFirstDocument(text))), '');
}

/**
 * sigs.k8s.io/yaml.Unmarshal into a json.Unmarshaler (runtime.RawExtension, as kubectl's
 * resource builder decodes manifests): errors read `error converting YAML to JSON: yaml: …`.
 */
export function unmarshalYaml(text: string): YamlResult {
  return run(() => marshalJson(convert(unmarshalFirstDocument(text))), 'error converting YAML to JSON: ');
}
