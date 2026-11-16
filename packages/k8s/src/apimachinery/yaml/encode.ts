// sigs.k8s.io/yaml.Marshal of a JSON-compatible value, as kubectl's YAMLPrinter calls it on an
// unstructured object: json.Marshal, then JSONToYAML, which decodes the JSON with yaml.v2 into
// interface{} (so numbers become int, uint64 or float64 as yaml.v2 resolves their JSON text) and
// marshals that with yaml.v2: map keys in yaml.v2's natural order, strings quoted where they
// would resolve to something else, block style, multi-line strings as literal blocks.
//
// upstream: vendor/sigs.k8s.io/yaml/yaml.go (Marshal, JSONToYAML), vendor/go.yaml.in/yaml/v2/
// encode.go (marshal, mapv, slicev, stringv, intv, uintv, floatv, boolv, nilv), sorter.go
// (keyList.Less), resolve.go (resolve); Go encoding/json encode.go (float64 text: 'f' unless
// the exponent is below -6 or at least 21, which is JavaScript's Number#toString rule too).

import type { Json } from '../json.ts';
import { emit, type EmitEvent, type EmitScalarStyle } from './emitter.ts';
import { yamlV2Unmarshal } from './decode.ts';
import { compareGoStrings, formatFloatG } from './gofmt.ts';
import { isBase60Float, resolvedTag, STR_TAG, type GoValue } from './resolve.ts';

/** Go strings are UTF-8: a lone surrogate cannot reach yaml.v2 (encoding/json would have written U+FFFD). */
export function toGoString(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}

const isLetter = (r: string): boolean => /^\p{L}$/u.test(r);
const isDigit = (r: string): boolean => /^\p{Nd}$/u.test(r);

/** keyList.Less for two string keys (sorter.go): letters before other runes, digit runs by value. */
export function yamlKeyLess(a: string, b: string): boolean {
  const ar = Array.from(a);
  const br = Array.from(b);
  for (let i = 0; i < ar.length && i < br.length; i++) {
    if (ar[i] === br[i]) continue;
    const ai0 = ar[i] as string;
    const bi0 = br[i] as string;
    const al = isLetter(ai0);
    const bl = isLetter(bi0);
    if (al && bl) return (ai0.codePointAt(0) as number) < (bi0.codePointAt(0) as number);
    if (al || bl) return bl;
    let an = 0n;
    let bn = 0n;
    if (ai0 === '0' || bi0 === '0') {
      for (let j = i - 1; j >= 0 && isDigit(ar[j] as string); j--) {
        if (ar[j] !== '0') {
          an = 1n;
          bn = 1n;
          break;
        }
      }
    }
    // int64 arithmetic wraps in Go; digits here are rarely long enough for that to matter.
    const wrap = (n: bigint): bigint => BigInt.asIntN(64, n);
    let ai = i;
    for (; ai < ar.length && isDigit(ar[ai] as string); ai++) an = wrap(an * 10n + BigInt((ar[ai] as string).codePointAt(0) as number) - 48n);
    let bi = i;
    for (; bi < br.length && isDigit(br[bi] as string); bi++) bn = wrap(bn * 10n + BigInt((br[bi] as string).codePointAt(0) as number) - 48n);
    if (an !== bn) return an < bn;
    if (ai !== bi) return ai < bi;
    return (ai0.codePointAt(0) as number) < (bi0.codePointAt(0) as number);
  }
  return ar.length < br.length;
}

/** sort.Sort(keyList): an insertion sort, so the result does not depend on the sort algorithm for a strict weak order. */
function sortKeys(keys: string[]): string[] {
  const out = [...keys];
  for (let i = 1; i < out.length; i++) {
    for (let j = i; j > 0 && yamlKeyLess(out[j] as string, out[j - 1] as string); j--) {
      [out[j], out[j - 1]] = [out[j - 1] as string, out[j] as string];
    }
  }
  return out;
}

/** encoder.stringv: the requested style; the emitter may still change it. */
function stringStyle(s: string): EmitScalarStyle {
  const canUsePlain = resolvedTag(s) === STR_TAG && !isBase60Float(s);
  if (s.includes('\n')) return 'literal';
  return canUsePlain ? 'plain' : 'double-quoted';
}

/** json.Marshal of a JSON value: Go's text, which JSONToYAML then parses as YAML. */
function goJsonText(v: Json): string {
  if (v === null || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new YamlMarshalError(`json: unsupported value: ${formatFloatG(v, 64)}`);
    // encoding/json's float64 text ('f' below 1e21 and from 1e-6, else 'e' with a short exponent) is Number#toString's.
    return String(v);
  }
  if (typeof v === 'string') return goJsonString(v);
  if (Array.isArray(v)) return `[${v.map((x) => goJsonText(x)).join(',')}]`;
  const keys = Object.keys(v).map((k) => [toGoString(k), k] as const);
  keys.sort((a, b) => compareGoStrings(a[0], b[0]));
  return `{${keys.map(([g, k]) => `${goJsonString(g)}:${goJsonText(v[k] as Json)}`).join(',')}}`;
}

function goJsonString(s: string): string {
  return JSON.stringify(toGoString(s)).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** sigs.k8s.io/yaml.Marshal failed: the message kubectl prints after `error: `. */
export class YamlMarshalError extends Error {}

function scalarEvent(value: string, style: EmitScalarStyle = 'plain'): EmitEvent {
  return { type: 'scalar', value, style };
}

/** yaml.v2's encoder.marshal for what yaml.Unmarshal of JSON text yields. */
function valueEvents(v: GoValue, out: EmitEvent[]): void {
  switch (v.k) {
    case 'nil':
      out.push(scalarEvent('null'));
      return;
    case 'bool':
      out.push(scalarEvent(v.v ? 'true' : 'false'));
      return;
    case 'int':
    case 'uint':
      out.push(scalarEvent(v.v.toString()));
      return;
    case 'float': {
      const s = formatFloatG(v.v, 64);
      out.push(scalarEvent(s === '+Inf' ? '.inf' : s === '-Inf' ? '-.inf' : s === 'NaN' ? '.nan' : s));
      return;
    }
    case 'string':
      out.push(scalarEvent(v.v, stringStyle(v.v)));
      return;
    case 'seq':
      out.push({ type: 'sequence-start', flow: false });
      for (const x of v.items) valueEvents(x, out);
      out.push({ type: 'sequence-end' });
      return;
    case 'map': {
      out.push({ type: 'mapping-start', flow: false });
      const entries = v.entries.map((e) => {
        if (e.key.k !== 'string') throw new Error('a JSON object key that is not a string');
        return { key: e.key.v, value: e.value };
      });
      const order = sortKeys(entries.map((e) => e.key));
      for (const k of order) {
        const e = entries.find((x) => x.key === k) as { key: string; value: GoValue };
        out.push(scalarEvent(k, stringStyle(k)));
        valueEvents(e.value, out);
      }
      out.push({ type: 'mapping-end' });
      return;
    }
  }
}

/**
 * sigs.k8s.io/yaml.Marshal(v) for a JSON value: the text kubectl -o yaml prints for one object.
 * The JSON text really goes through the yaml.v2 parser, as in JSONToYAML, so its failures are
 * kept: a raw DEL or C1 control character (encoding/json does not escape them) fails with
 * "yaml: control characters are not allowed", a key over 1024 characters with "yaml: did not
 * find expected ',' or '}'", and NEL inside a string is folded like a line break. Throws
 * YamlMarshalError then.
 */
export function marshalYaml(v: Json): string {
  const parsed = yamlV2Unmarshal(goJsonText(v));
  if (!parsed.ok) throw new YamlMarshalError('error' in parsed ? parsed.error : parsed.unsupported);
  const events: EmitEvent[] = [{ type: 'stream-start' }, { type: 'document-start', implicit: true }];
  valueEvents(parsed.value, events);
  events.push({ type: 'document-end', implicit: true }, { type: 'stream-end' });
  return emit(events, { clearOpenEndedBeforeStreamEnd: true });
}
