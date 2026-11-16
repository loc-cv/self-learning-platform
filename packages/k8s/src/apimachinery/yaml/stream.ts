// A manifest stream as kubectl's resource builder reads it (`kubectl create -f`, `apply -f`):
// apimachinery's YAMLOrJSONDecoder. JSON when the first non-space character (in the first 4096
// bytes) is `{`, decoded value after value; otherwise YAML documents split at lines starting
// with `---`, each converted by sigs.k8s.io/yaml.Unmarshal. A failed JSON stream with at most
// one object decoded falls back to YAML from the point it reached.
//
// upstream: staging/src/k8s.io/apimachinery/pkg/util/yaml/decoder.go (YAMLOrJSONDecoder.Decode,
// consumeWhitespace, YAMLToJSONDecoder.Decode, YAMLReader.Read, LineReader.Read,
// GuessJSONStream, JSONSyntaxError "json: offset %d: %s"), Go bufio ReadLine (drops "\n" and
// "\r\n"), encoding/json stream.go (Decoder.readValue: the offset counts bytes from the start of
// the stream; io.ErrUnexpectedEOF "unexpected EOF"), staging/src/k8s.io/cli-runtime/pkg/
// resource/visitor.go StreamVisitor (the caller: "error parsing %s: %v", empty and null
// documents skipped).

import type { Json } from '../json.ts';
import { goJsonScan } from '../gojsonsyntax.ts';
import { unmarshalYaml } from './decode.ts';
import { toGoString } from './encode.ts';

export interface StreamResult {
  /** Every document decoded before the error, in order; `null` for an empty document (the caller skips those). */
  docs: Json[];
  /**
   * For each document of a JSON stream, its text as the decoder passed it on (RawExtension.Raw:
   * the value's bytes without surrounding space); undefined for a YAML document, whose bytes are
   * the JSON sigs.k8s.io/yaml made of it (json.Marshal of the value: keys sorted, compact).
   */
  raw?: (string | undefined)[];
  /** The decoder's error for the next document; kubectl prints `error parsing <source>: <error>`. */
  error?: string;
  /** Input the simulator cannot decode exactly; reported as a [sim] notice. */
  unsupported?: string;
}

const GUESS_JSON_BYTES = 4096;

const GO_SPACES = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const GO_SPACE_EDGES = new RegExp(`^[${GO_SPACES}]+|[${GO_SPACES}]+$`, 'gu');

/** unicode.IsSpace */
const GO_SPACE = new RegExp(`^[${GO_SPACES}]$`, 'u');

function isGoSpace(c: string): boolean {
  return GO_SPACE.test(c);
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** GuessJSONStream / IsJSONBuffer: within the first 4096 bytes, the first non-space is `{`. */
function looksLikeJson(text: string): boolean {
  let bytes = 0;
  for (const ch of text) {
    bytes += utf8Length(ch);
    if (bytes > GUESS_JSON_BYTES) return false;
    if (!isGoSpace(ch)) return ch === '{';
  }
  return false;
}

// ---- YAML documents ----

/** LineReader over the text: each line without its "\n" (or "\r\n"), with "\n" appended. */
function lines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  // A final "\n" leaves an empty last part: ReadLine reports EOF there, not a line.
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l, i) => (i < parts.length - 1 || text.endsWith('\n') ? l.replace(/\r$/, '') : l) + '\n');
}

/** YAMLReader.Read, document by document: the documents' text, or the separator error. */
export function splitYamlDocuments(text: string): { docs: string[]; error?: string } {
  const docs: string[] = [];
  let buffer = '';
  for (const line of lines(text)) {
    if (line.startsWith('---')) {
      // strings.TrimSpace: unicode.IsSpace at both ends.
      const trimmed = line.slice(3).replace(GO_SPACE_EDGES, '');
      if (trimmed.length > 0 && trimmed[0] !== '#') return { docs, error: `invalid Yaml document separator: ${trimmed}` };
      if (buffer.length !== 0) {
        docs.push(buffer);
        buffer = '';
        // The separator ends this document; it is not part of the next one.
        continue;
      }
    }
    buffer += line;
  }
  if (buffer.length !== 0) docs.push(buffer);
  return { docs };
}

function decodeYaml(text: string, out: StreamResult, firstErr?: string): StreamResult {
  const split = splitYamlDocuments(text);
  for (const doc of split.docs) {
    const r = unmarshalYaml(doc);
    if (r.ok) {
      out.docs.push(r.value);
      firstErr = undefined;
      continue;
    }
    if ('unsupported' in r) return { ...out, unsupported: r.unsupported };
    return { ...out, error: firstErr ?? r.error };
  }
  if (split.error !== undefined) return { ...out, error: firstErr ?? split.error };
  if (firstErr !== undefined) return { ...out, error: firstErr };
  return out;
}

// ---- JSON values ----

const isJsonSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** The end of the object or array starting at `i` (strings and nesting followed), or -1 at the end of input. */
function compositeEnd(s: string, i: number): number {
  let depth = 0;
  let inString = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

type JsonStep = { value: Json; end: number } | { error: string; syntax: boolean } | { eof: true } | { unsupported: string };

/** One Decoder.Decode from `start` (bytes before it: `startBytes`). */
function decodeJsonValue(s: string, start: number, startBytes: number): JsonStep {
  let i = start;
  while (i < s.length && isJsonSpace(s[i] as string)) i++;
  if (i >= s.length) return { eof: true };
  const c = s[i] as string;
  if (c !== '{' && c !== '[') {
    if (/[-0-9"tfn]/.test(c)) return { unsupported: 'a JSON stream with a top-level value that is not an object or array' };
  }
  const end = c === '{' || c === '[' ? compositeEnd(s, i) : -1;
  const candidate = end < 0 ? s.slice(i) : s.slice(i, end);
  const scan = goJsonScan(candidate);
  if (scan === undefined) return { value: toGoValue(JSON.parse(candidate) as Json), end };
  // The input ends inside the value: Decoder.readValue's io.ErrUnexpectedEOF.
  if (scan.eof) return { error: 'unexpected EOF', syntax: false };
  // SyntaxError.Offset counts from the start of the stream.
  const offset = startBytes + utf8Length(s.slice(start, i)) + scan.offset;
  const problem = scan.error;
  return { error: `json: offset ${offset}: ${problem}`, syntax: true };
}

/** A decoded JSON value as Go holds it: lone surrogates from \u escapes become U+FFFD. */
function toGoValue(v: Json): Json {
  if (typeof v === 'string') return toGoString(v);
  if (Array.isArray(v)) return v.map((x) => toGoValue(x));
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v)) out[toGoString(k)] = toGoValue(v[k] as Json);
    return out;
  }
  return v;
}

/** consumeWhitespace: spaces up to and including the first newline; undefined at the end of input. */
function consumeWhitespace(s: string, i: number): number | undefined {
  let j = i;
  for (const ch of s.slice(i)) {
    if (!isGoSpace(ch)) return j;
    j += ch.length;
    if (ch === '\n') return j;
  }
  return undefined;
}

/** Every document of a manifest stream, as kubectl's StreamVisitor would decode them. */
export function decodeManifestStream(text: string): StreamResult {
  const out: StreamResult = { docs: [] };
  if (!looksLikeJson(text)) return decodeYaml(text, out);
  let pos = 0;
  let bytes = 0;
  let count = 0;
  for (;;) {
    const step = decodeJsonValue(text, pos, bytes);
    if ('eof' in step) return out;
    if ('unsupported' in step) return { ...out, unsupported: step.unsupported };
    if ('value' in step) {
      out.docs.push(step.value);
      (out.raw ??= []).length = out.docs.length - 1;
      out.raw.push(text.slice(pos, step.end).replace(/^[ \t\n\r]+/, ''));
      count++;
      bytes += utf8Length(text.slice(pos, step.end));
      pos = step.end;
      continue;
    }
    // An unambiguous JSON stream (more than one object) does not switch to YAML; the error is
    // the decoder's own, without the offset wrapper.
    if (count > 1) return { ...out, error: step.syntax ? step.error.replace(/^json: offset \d+: /, '') : step.error };
    const from = consumeWhitespace(text, pos);
    if (from === undefined) return { ...out, error: step.error };
    return decodeYaml(text.slice(from), out, step.error);
  }
}
