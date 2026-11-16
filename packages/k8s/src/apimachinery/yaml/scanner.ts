// The libyaml reader and scanner as go.yaml.in/yaml/v2 v2.4.4 has them: characters in, tokens out.
// A function-by-function port of readerc.go and scannerc.go (plus the yamlprivateh.go character
// classes) with libyaml's names in camelCase, so the two can be read side by side. parser.ts
// pulls tokens from here lazily, exactly as yaml_parser_parse does.
//
// The input is a JS string, iterated by code point; marks count code points as libyaml counts
// characters. What the C/Go buffers make observable is modelled, not simplified away:
//   - the reader decodes the input in 512-byte raw chunks (yaml_parser_update_raw_buffer), so a
//     character the reader rejects ("control characters are not allowed") is reported when the
//     scanner first needs a character from its chunk, not earlier or later;
//   - is_bom in yamlprivateh.go tests buffer[0..2], not buffer[pos], so the scanner's "allow the
//     BOM" check looks at the character that sat at the buffer's start after the last refill;
//   - the token queue is a Go slice (length, capacity, head, in-place compaction in
//     yaml_insert_token), because parserc.go keeps a pointer into it across a refill in one place
//     (see parser.ts parseFlowSequenceEntryMappingValue).
//
// upstream: vendor/go.yaml.in/yaml/v2/readerc.go, scannerc.go, yamlprivateh.go, apic.go yaml_insert_token

import type { Mark, ScalarStyle } from './events.ts';
import { YamlSyntaxError } from './events.ts';

// upstream: yamlh.go yaml_token_type_t
export type TokenType =
  | 'stream-start'
  | 'stream-end'
  | 'version-directive'
  | 'tag-directive'
  | 'document-start'
  | 'document-end'
  | 'block-sequence-start'
  | 'block-mapping-start'
  | 'block-end'
  | 'flow-sequence-start'
  | 'flow-sequence-end'
  | 'flow-mapping-start'
  | 'flow-mapping-end'
  | 'block-entry'
  | 'flow-entry'
  | 'key'
  | 'value'
  | 'alias'
  | 'anchor'
  | 'tag'
  | 'scalar';

// upstream: yamlh.go yaml_token_t
export interface Token {
  type: TokenType;
  startMark: Mark;
  endMark: Mark;
  /** Alias/anchor/scalar value, tag handle, or %TAG handle. */
  value: string;
  /** Tag suffix (tag). */
  suffix: string;
  /** %TAG prefix (tag-directive). */
  prefix: string;
  /** Scalar style (scalar); 'plain' otherwise. */
  style: ScalarStyle;
  /** %YAML version (version-directive). */
  major: number;
  minor: number;
}

// upstream: yamlh.go yaml_simple_key_t
interface SimpleKey {
  possible: boolean;
  required: boolean;
  tokenNumber: number;
  mark: Mark;
}

/** A Go []yaml_token_t: the backing array is shared until append outgrows its capacity. */
export interface TokenSlice {
  arr: Token[];
  len: number;
  cap: number;
}

/** yaml_parser_t's reader and scanner fields. Transient state: it never enters the world. */
export interface YamlScanner {
  // Reader (readerc.go). chars holds the input's code points (a leading BOM removed); byte
  // counts are the UTF-8 encoding's, as the raw buffer sees them.
  chars: number[];
  inputBytes: number;
  hasBom: boolean;
  encodingDetermined: boolean;
  eof: boolean;
  /** Byte offset of raw_buffer[0], raw buffer length and position (bytes). */
  rawStart: number;
  rawLen: number;
  rawPos: number;
  /** Characters decoded into the working buffer so far. */
  decodedChars: number;
  /** parser.unread */
  unread: number;
  /** parser.buffer_pos as a character index into chars (beyond the end: NUL). */
  pos: number;
  /** The character index that sits at buffer[0] (see is_bom). */
  bufStart: number;
  mark: Mark;

  // Scanner (scannerc.go).
  streamStartProduced: boolean;
  streamEndProduced: boolean;
  flowLevel: number;
  tokens: TokenSlice;
  tokensHead: number;
  tokensParsed: number;
  tokenAvailable: boolean;
  indent: number;
  indents: number[];
  simpleKeyAllowed: boolean;
  simpleKeys: SimpleKey[];
  /** simple_keys_by_tok: token number → index into simpleKeys. */
  simpleKeysByTok: Map<number, number>;
}

const zeroMark = (): Mark => ({ index: 0, line: 0, column: 0 });
const copyMark = (m: Mark): Mark => ({ index: m.index, line: m.line, column: m.column });

/** yaml_parser_initialize + yaml_parser_set_input_string. A leading U+FEFF is the UTF-8 BOM. */
export function newScanner(input: string): YamlScanner {
  const chars: number[] = [];
  let bytes = 0;
  for (const c of input) {
    const cp = c.codePointAt(0) ?? 0;
    chars.push(cp);
    bytes += utf8Width(cp);
  }
  const hasBom = chars[0] === 0xfeff;
  if (hasBom) chars.shift();
  return {
    chars,
    inputBytes: bytes,
    hasBom,
    encodingDetermined: false,
    eof: false,
    rawStart: 0,
    rawLen: 0,
    rawPos: 0,
    decodedChars: 0,
    unread: 0,
    pos: 0,
    bufStart: 0,
    mark: zeroMark(),
    streamStartProduced: false,
    streamEndProduced: false,
    flowLevel: 0,
    tokens: { arr: [], len: 0, cap: 0 },
    tokensHead: 0,
    tokensParsed: 0,
    tokenAvailable: false,
    indent: 0,
    indents: [],
    simpleKeyAllowed: false,
    simpleKeys: [],
    simpleKeysByTok: new Map(),
  };
}

// ---------------------------------------------------------------------------------------------
// Character classes. upstream: yamlprivateh.go (on code points instead of UTF-8 bytes; every
// multi-byte test there compares the bytes of one character, so the two agree).

/** The code point at pos+k; NUL beyond the input, as the reader pads the buffer. */
function ch(s: YamlScanner, k = 0): number {
  return s.chars[s.pos + k] ?? 0;
}

const isAlpha = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHex = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const asHex = (c: number): number => (c >= 0x41 && c <= 0x46 ? c - 0x41 + 10 : c >= 0x61 && c <= 0x66 ? c - 0x61 + 10 : c - 0x30);
const isZ = (c: number): boolean => c === 0;
const isSpace = (c: number): boolean => c === 0x20;
const isTab = (c: number): boolean => c === 0x09;
const isBlank = (c: number): boolean => c === 0x20 || c === 0x09;
// CR, LF, NEL (#x85), LS (#x2028), PS (#x2029)
const isBreak = (c: number): boolean => c === 0x0d || c === 0x0a || c === 0x85 || c === 0x2028 || c === 0x2029;
const isBreakz = (c: number): boolean => isBreak(c) || c === 0;
const isBlankz = (c: number): boolean => isBlank(c) || isBreakz(c);

function utf8Width(cp: number): number {
  return cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
}

// ---------------------------------------------------------------------------------------------
// Reader. upstream: readerc.go

const INPUT_RAW_BUFFER_SIZE = 512; // yamlprivateh.go input_raw_buffer_size

function readerError(problem: string): never {
  // yaml_parser_set_reader_error sets problem_offset and problem_value, never problem_mark, so
  // the marks stay zero (and decode.go prints no line for a reader error).
  throw new YamlSyntaxError('reader', problem, zeroMark());
}

// upstream: readerc.go yaml_parser_determine_encoding
function determineEncoding(s: YamlScanner): void {
  while (!s.eof && s.rawLen - s.rawPos < 3) updateRawBuffer(s);
  // A JS string carries no UTF-16 BOM bytes; only the UTF-8 BOM can be present.
  if (s.rawLen - s.rawPos >= 3 && s.hasBom) s.rawPos += 3;
  s.encodingDetermined = true;
}

// upstream: readerc.go yaml_parser_update_raw_buffer, apic.go yaml_string_read_handler
function updateRawBuffer(s: YamlScanner): void {
  if (s.rawPos === 0 && s.rawLen === INPUT_RAW_BUFFER_SIZE) return;
  if (s.eof) return;
  s.rawStart += s.rawPos;
  s.rawLen -= s.rawPos;
  s.rawPos = 0;
  const inputPos = s.rawStart + s.rawLen;
  if (inputPos === s.inputBytes) {
    s.eof = true;
    return;
  }
  s.rawLen += Math.min(INPUT_RAW_BUFFER_SIZE - s.rawLen, s.inputBytes - inputPos);
}

// upstream: readerc.go yaml_parser_update_buffer
function updateBuffer(s: YamlScanner, length: number): void {
  if (s.unread >= length) return;
  if (!s.encodingDetermined) determineEncoding(s);
  // The unread characters move to the start of the buffer.
  s.bufStart = s.pos;
  let first = true;
  while (s.unread < length) {
    if (!first || s.rawPos === s.rawLen) updateRawBuffer(s);
    first = false;
    while (s.rawPos !== s.rawLen) {
      const value = s.chars[s.decodedChars] ?? 0;
      const width = utf8Width(value);
      if (width > s.rawLen - s.rawPos) {
        if (s.eof) readerError('incomplete UTF-8 octet sequence');
        break;
      }
      // A lone surrogate in the JS string stands for its WTF-8 bytes, which readerc rejects here.
      if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) readerError('invalid Unicode character');
      if (
        !(
          value === 0x09 ||
          value === 0x0a ||
          value === 0x0d ||
          (value >= 0x20 && value <= 0x7e) ||
          value === 0x85 ||
          (value >= 0xa0 && value <= 0xd7ff) ||
          (value >= 0xe000 && value <= 0xfffd) ||
          (value >= 0x10000 && value <= 0x10ffff)
        )
      ) {
        readerError('control characters are not allowed');
      }
      s.rawPos += width;
      s.decodedChars++;
      s.unread++;
    }
    // On EOF, put NUL into the buffer and return.
    if (s.eof) {
      s.unread++;
      break;
    }
  }
}

/** upstream: scannerc.go cache — and every `parser.unread < n && !yaml_parser_update_buffer(parser, n)`. */
function cache(s: YamlScanner, length: number): void {
  if (s.unread < length) updateBuffer(s, length);
}

// upstream: scannerc.go skip
function skip(s: YamlScanner): void {
  s.mark.index++;
  s.mark.column++;
  s.unread--;
  s.pos++;
}

// upstream: scannerc.go skip_line
function skipLine(s: YamlScanner): void {
  if (ch(s) === 0x0d && ch(s, 1) === 0x0a) {
    s.mark.index += 2;
    s.mark.column = 0;
    s.mark.line++;
    s.unread -= 2;
    s.pos += 2;
  } else if (isBreak(ch(s))) {
    s.mark.index++;
    s.mark.column = 0;
    s.mark.line++;
    s.unread--;
    s.pos++;
  }
}

// upstream: scannerc.go read
function read(s: YamlScanner, str: string): string {
  const c = ch(s);
  s.pos++;
  s.mark.index++;
  s.mark.column++;
  s.unread--;
  return str + String.fromCodePoint(c);
}

// upstream: scannerc.go read_line
function readLine(s: YamlScanner, str: string): string {
  const c0 = ch(s);
  if (c0 === 0x0d && ch(s, 1) === 0x0a) {
    // CR LF . LF
    str += '\n';
    s.pos += 2;
    s.mark.index++;
    s.unread--;
  } else if (c0 === 0x0d || c0 === 0x0a) {
    // CR|LF . LF
    str += '\n';
    s.pos += 1;
  } else if (c0 === 0x85) {
    // NEL . LF
    str += '\n';
    s.pos += 1;
  } else if (c0 === 0x2028 || c0 === 0x2029) {
    // LS|PS . LS|PS
    str += String.fromCodePoint(c0);
    s.pos += 1;
  } else {
    return str;
  }
  s.mark.index++;
  s.mark.column = 0;
  s.mark.line++;
  s.unread--;
  return str;
}

// ---------------------------------------------------------------------------------------------
// Token queue. upstream: apic.go yaml_insert_token, with Go's append growth for []yaml_token_t.

// cap() of a []yaml_token_t (144 bytes per element) after each growth, as Go's growslice and
// size classes produce it (measured with go1.27 linux/amd64; the rules are those since go1.22).
// From 151 on the slice is a large allocation, rounded up to whole 8 KiB pages.
const SMALL_TOKEN_CAPS = [1, 2, 4, 8, 18, 37, 75, 151];
const TOKEN_SIZE = 144;

function grownTokenCap(cap: number): number {
  for (const c of SMALL_TOKEN_CAPS) if (c > cap) return c;
  // runtime/slice.go nextslicecap for oldCap >= 256 adds (newcap + 3*256) >> 2; below 256 it doubles.
  const newcap = cap < 256 ? cap * 2 : cap + ((cap + 768) >> 2);
  const mem = Math.ceil((newcap * TOKEN_SIZE) / 8192) * 8192;
  return Math.floor(mem / TOKEN_SIZE);
}

function appendToken(q: TokenSlice, token: Token): void {
  if (q.len === q.cap) {
    // A new backing array: pointers into the old one keep seeing the old tokens.
    const cap = grownTokenCap(q.cap);
    const arr = q.arr.slice(0, q.len);
    q.arr = arr;
    q.cap = cap;
  }
  q.arr[q.len] = token;
  q.len++;
}

// upstream: apic.go yaml_insert_token
function insertToken(s: YamlScanner, pos: number, token: Token): void {
  const q = s.tokens;
  // Check if we can move the queue at the beginning of the buffer.
  if (s.tokensHead > 0 && q.len === q.cap) {
    if (s.tokensHead !== q.len) q.arr.copyWithin(0, s.tokensHead, q.len);
    q.len -= s.tokensHead;
    s.tokensHead = 0;
  }
  appendToken(q, token);
  if (pos < 0) return;
  q.arr.copyWithin(s.tokensHead + pos + 1, s.tokensHead + pos, q.len - 1);
  q.arr[s.tokensHead + pos] = token;
}

function newToken(type: TokenType, startMark: Mark, endMark: Mark, fields: Partial<Token> = {}): Token {
  return { type, startMark: copyMark(startMark), endMark: copyMark(endMark), value: '', suffix: '', prefix: '', style: 'plain', major: 0, minor: 0, ...fields };
}

// ---------------------------------------------------------------------------------------------
// Scanner. upstream: scannerc.go

// upstream: scannerc.go yaml_parser_set_scanner_error
function scannerError(s: YamlScanner, context: string, contextMark: Mark, problem: string): never {
  throw new YamlSyntaxError('scanner', problem, copyMark(s.mark), context, copyMark(contextMark));
}

// upstream: scannerc.go yaml_parser_set_scanner_tag_error
function scannerTagError(s: YamlScanner, directive: boolean, contextMark: Mark, problem: string): never {
  return scannerError(s, directive ? 'while parsing a %TAG directive' : 'while parsing a tag', contextMark, problem);
}

// upstream: scannerc.go yaml_parser_fetch_more_tokens
export function fetchMoreTokens(s: YamlScanner): void {
  for (;;) {
    // [Go] The comment parsing logic requires a lookahead of two tokens so that foot comments
    // may be parsed in time of associating them with the tokens that are parsed before them.
    if (s.tokensHead !== s.tokens.len) {
      // If the current token is not a potential simple key, then we don't need to fetch more.
      const headTokIdx = s.simpleKeysByTok.get(s.tokensParsed);
      if (headTokIdx === undefined) break;
      const key = s.simpleKeys[headTokIdx];
      // Go indexes the slice here; a stale index would be a runtime panic.
      if (key === undefined) throw new RangeError(`runtime error: index out of range [${headTokIdx}] with length ${s.simpleKeys.length}`);
      if (!simpleKeyIsValid(s, key)) break;
    }
    fetchNextToken(s);
  }
  s.tokenAvailable = true;
}

// upstream: scannerc.go yaml_parser_fetch_next_token
function fetchNextToken(s: YamlScanner): void {
  // Ensure that the buffer is initialized.
  cache(s, 1);

  // Check if we just started scanning. Fetch STREAM-START then.
  if (!s.streamStartProduced) return fetchStreamStart(s);

  // Eat whitespaces and comments until we reach the next token.
  scanToNextToken(s);

  // Check the indentation level against the current column.
  unrollIndent(s, s.mark.column);

  // Ensure that the buffer contains at least 4 characters. 4 is the length of the longest
  // indicators ('--- ' and '... ').
  cache(s, 4);

  const c = ch(s);
  if (isZ(c)) return fetchStreamEnd(s);
  if (s.mark.column === 0 && c === 0x25 /* % */) return fetchDirective(s);
  if (s.mark.column === 0 && c === 0x2d && ch(s, 1) === 0x2d && ch(s, 2) === 0x2d && isBlankz(ch(s, 3))) {
    return fetchDocumentIndicator(s, 'document-start');
  }
  if (s.mark.column === 0 && c === 0x2e && ch(s, 1) === 0x2e && ch(s, 2) === 0x2e && isBlankz(ch(s, 3))) {
    return fetchDocumentIndicator(s, 'document-end');
  }
  if (c === 0x5b /* [ */) return fetchFlowCollectionStart(s, 'flow-sequence-start');
  if (c === 0x7b /* { */) return fetchFlowCollectionStart(s, 'flow-mapping-start');
  if (c === 0x5d /* ] */) return fetchFlowCollectionEnd(s, 'flow-sequence-end');
  if (c === 0x7d /* } */) return fetchFlowCollectionEnd(s, 'flow-mapping-end');
  if (c === 0x2c /* , */) return fetchFlowEntry(s);
  if (c === 0x2d /* - */ && isBlankz(ch(s, 1))) return fetchBlockEntry(s);
  if (c === 0x3f /* ? */ && (s.flowLevel > 0 || isBlankz(ch(s, 1)))) return fetchKey(s);
  if (c === 0x3a /* : */ && (s.flowLevel > 0 || isBlankz(ch(s, 1)))) return fetchValue(s);
  if (c === 0x2a /* * */) return fetchAnchor(s, 'alias');
  if (c === 0x26 /* & */) return fetchAnchor(s, 'anchor');
  if (c === 0x21 /* ! */) return fetchTag(s);
  if (c === 0x7c /* | */ && s.flowLevel === 0) return fetchBlockScalar(s, true);
  if (c === 0x3e /* > */ && s.flowLevel === 0) return fetchBlockScalar(s, false);
  if (c === 0x27 /* ' */) return fetchFlowScalar(s, true);
  if (c === 0x22 /* " */) return fetchFlowScalar(s, false);

  // Is it a plain scalar? A plain scalar may start with any non-blank characters except
  //   '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '\"',
  //   '%', '@', '`'.
  // In the block context (and, for the '-' indicator, in the flow context too), it may also
  // start with the characters '-', '?', ':' if it is followed by a non-space character.
  if (
    !(isBlankz(c) || '-?:,[]{}#&*!|>\'"%@`'.includes(String.fromCodePoint(c))) ||
    (c === 0x2d && !isBlank(ch(s, 1))) ||
    (s.flowLevel === 0 && (c === 0x3f || c === 0x3a) && !isBlankz(ch(s, 1)))
  ) {
    return fetchPlainScalar(s);
  }

  // If we don't determine the token type so far, it is an error.
  scannerError(s, 'while scanning for the next token', s.mark, 'found character that cannot start any token');
}

// upstream: scannerc.go yaml_simple_key_is_valid
function simpleKeyIsValid(s: YamlScanner, key: SimpleKey): boolean {
  if (!key.possible) return false;
  // The 1.2 specification says: "If the ? indicator is omitted, parsing needs to see past the
  // implicit key to recognize it as such. To limit the amount of lookahead required, the ':'
  // indicator must appear at most 1024 Unicode characters beyond the start of the key. In
  // addition, the key is restricted to a single line."
  if (key.mark.line < s.mark.line || key.mark.index + 1024 < s.mark.index) {
    // Check if the potential simple key to be removed is required.
    if (key.required) scannerError(s, 'while scanning a simple key', key.mark, "could not find expected ':'");
    // [Go] stale entries stay in simple_keys_by_tok here.
    key.possible = false;
    return false;
  }
  return true;
}

// upstream: scannerc.go yaml_parser_save_simple_key
function saveSimpleKey(s: YamlScanner): void {
  // A simple key is required at the current position if the scanner is in the block context
  // and the current column coincides with the indentation level.
  const required = s.flowLevel === 0 && s.indent === s.mark.column;

  // If the current position may start a simple key, save it.
  if (s.simpleKeyAllowed) {
    const key: SimpleKey = {
      possible: true,
      required,
      tokenNumber: s.tokensParsed + (s.tokens.len - s.tokensHead),
      mark: copyMark(s.mark),
    };
    removeSimpleKey(s);
    s.simpleKeys[s.simpleKeys.length - 1] = key;
    s.simpleKeysByTok.set(key.tokenNumber, s.simpleKeys.length - 1);
  }
}

// upstream: scannerc.go yaml_parser_remove_simple_key
function removeSimpleKey(s: YamlScanner): void {
  const key = s.simpleKeys[s.simpleKeys.length - 1]!;
  if (key.possible) {
    // If the key is required, it is an error.
    if (key.required) scannerError(s, 'while scanning a simple key', key.mark, "could not find expected ':'");
    // Remove the key from the stack.
    key.possible = false;
    s.simpleKeysByTok.delete(key.tokenNumber);
  }
}

// upstream: scannerc.go max_flow_level
const MAX_FLOW_LEVEL = 10000;

// upstream: scannerc.go yaml_parser_increase_flow_level
function increaseFlowLevel(s: YamlScanner): void {
  // Reset the simple key on the next level.
  s.simpleKeys.push({
    possible: false,
    required: false,
    tokenNumber: s.tokensParsed + (s.tokens.len - s.tokensHead),
    mark: copyMark(s.mark),
  });
  // Increase the flow level.
  s.flowLevel++;
  if (s.flowLevel > MAX_FLOW_LEVEL) {
    scannerError(s, 'while increasing flow level', s.simpleKeys[s.simpleKeys.length - 1]!.mark, `exceeded max depth of ${MAX_FLOW_LEVEL}`);
  }
}

// upstream: scannerc.go yaml_parser_decrease_flow_level
function decreaseFlowLevel(s: YamlScanner): void {
  if (s.flowLevel > 0) {
    s.flowLevel--;
    const last = s.simpleKeys.pop()!;
    s.simpleKeysByTok.delete(last.tokenNumber);
  }
}

// upstream: scannerc.go max_indents
const MAX_INDENTS = 10000;

// upstream: scannerc.go yaml_parser_roll_indent
function rollIndent(s: YamlScanner, column: number, number: number, type: TokenType, mark: Mark): void {
  // In the flow context, do nothing.
  if (s.flowLevel > 0) return;
  if (s.indent < column) {
    // Push the current indentation level to the stack and set the new indentation level.
    s.indents.push(s.indent);
    s.indent = column;
    if (s.indents.length > MAX_INDENTS) {
      scannerError(s, 'while increasing indent level', s.simpleKeys[s.simpleKeys.length - 1]!.mark, `exceeded max depth of ${MAX_INDENTS}`);
    }
    // Create a token and insert it into the queue.
    const token = newToken(type, mark, mark);
    if (number > -1) number -= s.tokensParsed;
    insertToken(s, number, token);
  }
}

// upstream: scannerc.go yaml_parser_unroll_indent
function unrollIndent(s: YamlScanner, column: number): void {
  // In the flow context, do nothing.
  if (s.flowLevel > 0) return;
  // Loop through the indentation levels in the stack.
  while (s.indent > column) {
    insertToken(s, -1, newToken('block-end', s.mark, s.mark));
    s.indent = s.indents.pop()!;
  }
}

// upstream: scannerc.go yaml_parser_fetch_stream_start
function fetchStreamStart(s: YamlScanner): void {
  s.indent = -1;
  // Initialize the simple key stack.
  s.simpleKeys.push({ possible: false, required: false, tokenNumber: 0, mark: zeroMark() });
  s.simpleKeysByTok = new Map();
  // A simple key is allowed at the beginning of the stream.
  s.simpleKeyAllowed = true;
  s.streamStartProduced = true;
  insertToken(s, -1, newToken('stream-start', s.mark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_stream_end
function fetchStreamEnd(s: YamlScanner): void {
  // Force new line.
  if (s.mark.column !== 0) {
    s.mark.column = 0;
    s.mark.line++;
  }
  // Reset the indentation level.
  unrollIndent(s, -1);
  // Reset simple keys.
  removeSimpleKey(s);
  s.simpleKeyAllowed = false;
  insertToken(s, -1, newToken('stream-end', s.mark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_directive
function fetchDirective(s: YamlScanner): void {
  // Reset the indentation level.
  unrollIndent(s, -1);
  // Reset simple keys.
  removeSimpleKey(s);
  s.simpleKeyAllowed = false;
  insertToken(s, -1, scanDirective(s));
}

// upstream: scannerc.go yaml_parser_fetch_document_indicator
function fetchDocumentIndicator(s: YamlScanner, type: TokenType): void {
  // Reset the indentation level.
  unrollIndent(s, -1);
  // Reset simple keys.
  removeSimpleKey(s);
  s.simpleKeyAllowed = false;
  const startMark = copyMark(s.mark);
  skip(s);
  skip(s);
  skip(s);
  insertToken(s, -1, newToken(type, startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_flow_collection_start
function fetchFlowCollectionStart(s: YamlScanner, type: TokenType): void {
  // The indicators '[' and '{' may start a simple key.
  saveSimpleKey(s);
  // Increase the flow level.
  increaseFlowLevel(s);
  // A simple key may follow the indicators '[' and '{'.
  s.simpleKeyAllowed = true;
  const startMark = copyMark(s.mark);
  skip(s);
  insertToken(s, -1, newToken(type, startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_flow_collection_end
function fetchFlowCollectionEnd(s: YamlScanner, type: TokenType): void {
  // Reset any potential simple key on the current flow level.
  removeSimpleKey(s);
  // Decrease the flow level.
  decreaseFlowLevel(s);
  // No simple keys after the indicators ']' and '}'.
  s.simpleKeyAllowed = false;
  const startMark = copyMark(s.mark);
  skip(s);
  insertToken(s, -1, newToken(type, startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_flow_entry
function fetchFlowEntry(s: YamlScanner): void {
  // Reset any potential simple keys on the current flow level.
  removeSimpleKey(s);
  // Simple keys are allowed after ','.
  s.simpleKeyAllowed = true;
  const startMark = copyMark(s.mark);
  skip(s);
  insertToken(s, -1, newToken('flow-entry', startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_block_entry
function fetchBlockEntry(s: YamlScanner): void {
  // Check if the scanner is in the block context.
  if (s.flowLevel === 0) {
    // Check if we are allowed to start a new entry.
    if (!s.simpleKeyAllowed) scannerError(s, '', s.mark, 'block sequence entries are not allowed in this context');
    // Add the BLOCK-SEQUENCE-START token if needed.
    rollIndent(s, s.mark.column, -1, 'block-sequence-start', s.mark);
  }
  // It is an error for the '-' indicator to occur in the flow context, but we let the Parser
  // detect and report about it because the Parser is able to point to the context.

  // Reset any potential simple keys on the current flow level.
  removeSimpleKey(s);
  // Simple keys are allowed after '-'.
  s.simpleKeyAllowed = true;
  const startMark = copyMark(s.mark);
  skip(s);
  insertToken(s, -1, newToken('block-entry', startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_key
function fetchKey(s: YamlScanner): void {
  // In the block context, additional checks are required.
  if (s.flowLevel === 0) {
    // Check if we are allowed to start a new key (not nessesary simple).
    if (!s.simpleKeyAllowed) scannerError(s, '', s.mark, 'mapping keys are not allowed in this context');
    // Add the BLOCK-MAPPING-START token if needed.
    rollIndent(s, s.mark.column, -1, 'block-mapping-start', s.mark);
  }
  // Reset any potential simple keys on the current flow level.
  removeSimpleKey(s);
  // Simple keys are allowed after '?' in the block context.
  s.simpleKeyAllowed = s.flowLevel === 0;
  const startMark = copyMark(s.mark);
  skip(s);
  insertToken(s, -1, newToken('key', startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_value
function fetchValue(s: YamlScanner): void {
  const key = s.simpleKeys[s.simpleKeys.length - 1]!;

  if (simpleKeyIsValid(s, key)) {
    // Have we found a simple key? Create the KEY token and insert it into the queue.
    insertToken(s, key.tokenNumber - s.tokensParsed, newToken('key', key.mark, key.mark));
    // In the block context, we may need to add the BLOCK-MAPPING-START token.
    rollIndent(s, key.mark.column, key.tokenNumber, 'block-mapping-start', key.mark);
    // Remove the simple key.
    key.possible = false;
    s.simpleKeysByTok.delete(key.tokenNumber);
    // A simple key cannot follow another simple key.
    s.simpleKeyAllowed = false;
  } else {
    // The ':' indicator follows a complex key.

    // In the block context, extra checks are required.
    if (s.flowLevel === 0) {
      // Check if we are allowed to start a complex value.
      if (!s.simpleKeyAllowed) scannerError(s, '', s.mark, 'mapping values are not allowed in this context');
      // Add the BLOCK-MAPPING-START token if needed.
      rollIndent(s, s.mark.column, -1, 'block-mapping-start', s.mark);
    }
    // Simple keys after ':' are allowed in the block context.
    s.simpleKeyAllowed = s.flowLevel === 0;
  }

  const startMark = copyMark(s.mark);
  skip(s);
  insertToken(s, -1, newToken('value', startMark, s.mark));
}

// upstream: scannerc.go yaml_parser_fetch_anchor
function fetchAnchor(s: YamlScanner, type: 'alias' | 'anchor'): void {
  // An anchor or an alias could be a simple key.
  saveSimpleKey(s);
  // A simple key cannot follow an anchor or an alias.
  s.simpleKeyAllowed = false;
  insertToken(s, -1, scanAnchor(s, type));
}

// upstream: scannerc.go yaml_parser_fetch_tag
function fetchTag(s: YamlScanner): void {
  // A tag could be a simple key.
  saveSimpleKey(s);
  // A simple key cannot follow a tag.
  s.simpleKeyAllowed = false;
  insertToken(s, -1, scanTag(s));
}

// upstream: scannerc.go yaml_parser_fetch_block_scalar
function fetchBlockScalar(s: YamlScanner, literal: boolean): void {
  // Remove any potential simple keys.
  removeSimpleKey(s);
  // A simple key may follow a block scalar.
  s.simpleKeyAllowed = true;
  insertToken(s, -1, scanBlockScalar(s, literal));
}

// upstream: scannerc.go yaml_parser_fetch_flow_scalar
function fetchFlowScalar(s: YamlScanner, single: boolean): void {
  // A plain scalar could be a simple key.
  saveSimpleKey(s);
  // A simple key cannot follow a flow scalar.
  s.simpleKeyAllowed = false;
  insertToken(s, -1, scanFlowScalar(s, single));
}

// upstream: scannerc.go yaml_parser_fetch_plain_scalar
function fetchPlainScalar(s: YamlScanner): void {
  // A plain scalar could be a simple key.
  saveSimpleKey(s);
  // A simple key cannot follow a flow scalar.
  s.simpleKeyAllowed = false;
  insertToken(s, -1, scanPlainScalar(s));
}

// upstream: scannerc.go yaml_parser_scan_to_next_token
function scanToNextToken(s: YamlScanner): void {
  // Until the next token is not found.
  for (;;) {
    // Allow the BOM. [Go] is_bom looks at buffer[0..2], whatever buffer_pos is.
    cache(s, 1);
    if (s.mark.column === 0 && (s.chars[s.bufStart] ?? 0) === 0xfeff) skip(s);

    // Eat whitespaces.
    // Tabs are allowed:
    //  - in the flow context
    //  - in the block context, but not at the beginning of the line or after '-', '?', or ':'
    //    (complex value).
    cache(s, 1);
    while (ch(s) === 0x20 || ((s.flowLevel > 0 || !s.simpleKeyAllowed) && ch(s) === 0x09)) {
      skip(s);
      cache(s, 1);
    }

    // Eat a comment until a line break.
    if (ch(s) === 0x23 /* # */) {
      while (!isBreakz(ch(s))) {
        skip(s);
        cache(s, 1);
      }
    }

    // If it is a line break, eat it.
    if (isBreak(ch(s))) {
      cache(s, 2);
      skipLine(s);
      // In the block context, a new line may start a simple key.
      if (s.flowLevel === 0) s.simpleKeyAllowed = true;
    } else {
      break; // We have found a token.
    }
  }
}

// upstream: scannerc.go yaml_parser_scan_directive
function scanDirective(s: YamlScanner): Token {
  // Eat '%'.
  const startMark = copyMark(s.mark);
  skip(s);

  // Scan the directive name.
  const name = scanDirectiveName(s, startMark);

  let token: Token;
  if (name === 'YAML') {
    // Is it a YAML directive? Scan the VERSION directive value.
    const [major, minor] = scanVersionDirectiveValue(s, startMark);
    token = newToken('version-directive', startMark, s.mark, { major, minor });
  } else if (name === 'TAG') {
    // Is it a TAG directive? Scan the TAG directive value.
    const [handle, prefix] = scanTagDirectiveValue(s, startMark);
    token = newToken('tag-directive', startMark, s.mark, { value: handle, prefix });
  } else {
    // Unknown directive.
    scannerError(s, 'while scanning a directive', startMark, 'found unknown directive name');
  }

  // Eat the rest of the line including any comments.
  cache(s, 1);
  while (isBlank(ch(s))) {
    skip(s);
    cache(s, 1);
  }
  if (ch(s) === 0x23 /* # */) {
    while (!isBreakz(ch(s))) {
      skip(s);
      cache(s, 1);
    }
  }

  // Check if we are at the end of the line.
  if (!isBreakz(ch(s))) scannerError(s, 'while scanning a directive', startMark, 'did not find expected comment or line break');

  // Eat a line break.
  if (isBreak(ch(s))) {
    cache(s, 2);
    skipLine(s);
  }
  return token;
}

// upstream: scannerc.go yaml_parser_scan_directive_name
function scanDirectiveName(s: YamlScanner, startMark: Mark): string {
  // Consume the directive name.
  cache(s, 1);
  let str = '';
  while (isAlpha(ch(s))) {
    str = read(s, str);
    cache(s, 1);
  }
  // Check if the name is empty.
  if (str === '') scannerError(s, 'while scanning a directive', startMark, 'could not find expected directive name');
  // Check for an blank character after the name.
  if (!isBlankz(ch(s))) scannerError(s, 'while scanning a directive', startMark, 'found unexpected non-alphabetical character');
  return str;
}

// upstream: scannerc.go yaml_parser_scan_version_directive_value
function scanVersionDirectiveValue(s: YamlScanner, startMark: Mark): [number, number] {
  // Eat whitespaces.
  cache(s, 1);
  while (isBlank(ch(s))) {
    skip(s);
    cache(s, 1);
  }
  // Consume the major version number.
  const major = scanVersionDirectiveNumber(s, startMark);
  // Eat '.'.
  if (ch(s) !== 0x2e) scannerError(s, 'while scanning a %YAML directive', startMark, "did not find expected digit or '.' character");
  skip(s);
  // Consume the minor version number.
  const minor = scanVersionDirectiveNumber(s, startMark);
  return [major, minor];
}

// upstream: scannerc.go max_number_length
const MAX_NUMBER_LENGTH = 2;

// upstream: scannerc.go yaml_parser_scan_version_directive_number
function scanVersionDirectiveNumber(s: YamlScanner, startMark: Mark): number {
  // Repeat while the next character is digit.
  cache(s, 1);
  let value = 0;
  let length = 0;
  while (isDigit(ch(s))) {
    // Check if the number is too long.
    length++;
    if (length > MAX_NUMBER_LENGTH) scannerError(s, 'while scanning a %YAML directive', startMark, 'found extremely long version number');
    value = value * 10 + (ch(s) - 0x30);
    skip(s);
    cache(s, 1);
  }
  // Check if the number was present.
  if (length === 0) scannerError(s, 'while scanning a %YAML directive', startMark, 'did not find expected version number');
  return value;
}

// upstream: scannerc.go yaml_parser_scan_tag_directive_value
function scanTagDirectiveValue(s: YamlScanner, startMark: Mark): [string, string] {
  // Eat whitespaces.
  cache(s, 1);
  while (isBlank(ch(s))) {
    skip(s);
    cache(s, 1);
  }
  // Scan a handle.
  const handle = scanTagHandle(s, true, startMark);

  // Expect a whitespace.
  cache(s, 1);
  if (!isBlank(ch(s))) scannerError(s, 'while scanning a %TAG directive', startMark, 'did not find expected whitespace');

  // Eat whitespaces.
  while (isBlank(ch(s))) {
    skip(s);
    cache(s, 1);
  }
  // Scan a prefix.
  const prefix = scanTagUri(s, true, '', startMark);

  // Expect a whitespace or line break.
  cache(s, 1);
  if (!isBlankz(ch(s))) scannerError(s, 'while scanning a %TAG directive', startMark, 'did not find expected whitespace or line break');
  return [handle, prefix];
}

// upstream: scannerc.go yaml_parser_scan_anchor
function scanAnchor(s: YamlScanner, type: 'alias' | 'anchor'): Token {
  // Eat the indicator character.
  const startMark = copyMark(s.mark);
  skip(s);

  // Consume the value.
  cache(s, 1);
  let str = '';
  while (isAlpha(ch(s))) {
    str = read(s, str);
    cache(s, 1);
  }
  const endMark = copyMark(s.mark);

  // Check if length of the anchor is greater than 0 and it is followed by a whitespace
  // character or one of the indicators: '?', ':', ',', ']', '}', '%', '@', '`'.
  const c = ch(s);
  if (str === '' || !(isBlankz(c) || c === 0x3f || c === 0x3a || c === 0x2c || c === 0x5d || c === 0x7d || c === 0x25 || c === 0x40 || c === 0x60)) {
    scannerError(s, type === 'anchor' ? 'while scanning an anchor' : 'while scanning an alias', startMark, 'did not find expected alphabetic or numeric character');
  }
  return newToken(type, startMark, endMark, { value: str });
}

// upstream: scannerc.go yaml_parser_scan_tag
function scanTag(s: YamlScanner): Token {
  const startMark = copyMark(s.mark);
  let handle: string;
  let suffix: string;

  // Check if the tag is in the canonical form.
  cache(s, 2);
  if (ch(s, 1) === 0x3c /* < */) {
    // Keep the handle as ''. Eat '!<'.
    handle = '';
    skip(s);
    skip(s);
    // Consume the tag value.
    suffix = scanTagUri(s, false, '', startMark);
    // Check for '>' and eat it.
    if (ch(s) !== 0x3e) scannerError(s, 'while scanning a tag', startMark, "did not find the expected '>'");
    skip(s);
  } else {
    // The tag has either the '!suffix' or the '!handle!suffix' form.

    // First, try to scan a handle.
    handle = scanTagHandle(s, false, startMark);

    // Check if it is, indeed, handle.
    if (handle[0] === '!' && handle.length > 1 && handle[handle.length - 1] === '!') {
      // Scan the suffix now.
      suffix = scanTagUri(s, false, '', startMark);
    } else {
      // It wasn't a handle after all. Scan the rest of the tag.
      suffix = scanTagUri(s, false, handle, startMark);
      // Set the handle to '!'.
      handle = '!';
      // A special case: the '!' tag. Set the handle to '' and the suffix to '!'.
      if (suffix === '') [handle, suffix] = [suffix, handle];
    }
  }

  // Check the character which ends the tag.
  cache(s, 1);
  if (!isBlankz(ch(s))) scannerError(s, 'while scanning a tag', startMark, 'did not find expected whitespace or line break');

  return newToken('tag', startMark, s.mark, { value: handle, suffix });
}

// upstream: scannerc.go yaml_parser_scan_tag_handle
function scanTagHandle(s: YamlScanner, directive: boolean, startMark: Mark): string {
  // Check the initial '!' character.
  cache(s, 1);
  if (ch(s) !== 0x21) scannerTagError(s, directive, startMark, "did not find expected '!'");

  // Copy the '!' character.
  let str = read(s, '');

  // Copy all subsequent alphabetical and numerical characters.
  cache(s, 1);
  while (isAlpha(ch(s))) {
    str = read(s, str);
    cache(s, 1);
  }

  // Check if the trailing character is '!' and copy it.
  if (ch(s) === 0x21) {
    str = read(s, str);
  } else {
    // It's either the '!' tag or not really a tag handle. If it's a %TAG directive, it's an
    // error. If it's a tag token, it must be a part of URI.
    if (directive && str !== '!') scannerTagError(s, directive, startMark, "did not find expected '!'");
  }
  return str;
}

const URI_CHARS = ";/?:@&=+$,.!~*'()[]%";

// upstream: scannerc.go yaml_parser_scan_tag_uri
function scanTagUri(s: YamlScanner, directive: boolean, head: string, startMark: Mark): string {
  let str = '';
  let hasTag = head.length > 0;

  // Copy the head if needed. Note that we don't copy the leading '!' character.
  if (head.length > 1) str = head.slice(1);

  // Scan the tag.
  cache(s, 1);

  // The set of characters that may appear in URI is as follows:
  //      '0'-'9', 'A'-'Z', 'a'-'z', '_', '-', ';', '/', '?', ':', '@', '&', '=', '+', '$', ',',
  //      '.', '!', '~', '*', '\'', '(', ')', '[', ']', '%'.
  while (isAlpha(ch(s)) || (ch(s) < 0x80 && ch(s) !== 0 && URI_CHARS.includes(String.fromCharCode(ch(s))))) {
    // Check if it is a URI-escape sequence.
    if (ch(s) === 0x25 /* % */) {
      str = scanUriEscapes(s, directive, startMark, str);
    } else {
      str = read(s, str);
    }
    cache(s, 1);
    hasTag = true;
  }

  if (!hasTag) scannerTagError(s, directive, startMark, 'did not find expected tag URI');
  return str;
}

// upstream: scannerc.go yaml_parser_scan_uri_escapes
function scanUriEscapes(s: YamlScanner, directive: boolean, startMark: Mark, str: string): string {
  // Decode the required number of characters.
  const octets: number[] = [];
  let w = 1024;
  while (w > 0) {
    // Check for a URI-escaped octet.
    cache(s, 3);
    if (!(ch(s) === 0x25 && isHex(ch(s, 1)) && isHex(ch(s, 2)))) scannerTagError(s, directive, startMark, 'did not find URI escaped octet');

    // Get the octet.
    const octet = (asHex(ch(s, 1)) << 4) + asHex(ch(s, 2));

    // If it is the leading octet, determine the length of the UTF-8 sequence.
    if (w === 1024) {
      w = octetWidth(octet);
      if (w === 0) scannerTagError(s, directive, startMark, 'found an incorrect leading UTF-8 octet');
    } else {
      // Check if the trailing octet is correct.
      if ((octet & 0xc0) !== 0x80) scannerTagError(s, directive, startMark, 'found an incorrect trailing UTF-8 octet');
    }

    // Copy the octet and move the pointers.
    octets.push(octet);
    skip(s);
    skip(s);
    skip(s);
    w--;
  }
  return str + decodeUtf8Sequence(octets);
}

// upstream: yamlprivateh.go width
function octetWidth(b: number): number {
  if ((b & 0x80) === 0x00) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 0;
}

/**
 * One escaped UTF-8 sequence as a JS string. Its lead and trailing bits are checked above, but
 * libyaml accepts overlong forms, surrogates and values past U+10FFFF as raw bytes; Go reads each
 * byte of such a sequence as U+FFFD, and so does this.
 */
function decodeUtf8Sequence(octets: number[]): string {
  const n = octets.length;
  const lead = octets[0]!;
  let value = n === 1 ? lead : n === 2 ? lead & 0x1f : n === 3 ? lead & 0x0f : lead & 0x07;
  for (let k = 1; k < n; k++) value = (value << 6) + (octets[k]! & 0x3f);
  const minimum = [0, 0, 0x80, 0x800, 0x10000][n]!;
  if (value < minimum || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) return '�'.repeat(n);
  return String.fromCodePoint(value);
}

// upstream: scannerc.go yaml_parser_scan_block_scalar
function scanBlockScalar(s: YamlScanner, literal: boolean): Token {
  // Eat the indicator '|' or '>'.
  const startMark = copyMark(s.mark);
  skip(s);

  // Scan the additional block scalar indicators.
  cache(s, 1);

  // Check for a chomping indicator.
  let chomping = 0;
  let increment = 0;
  if (ch(s) === 0x2b || ch(s) === 0x2d) {
    // Set the chomping method and eat the indicator.
    chomping = ch(s) === 0x2b ? +1 : -1;
    skip(s);

    // Check for an indentation indicator.
    cache(s, 1);
    if (isDigit(ch(s))) {
      // Check that the indentation is greater than 0.
      if (ch(s) === 0x30) scannerError(s, 'while scanning a block scalar', startMark, 'found an indentation indicator equal to 0');
      // Get the indentation level and eat the indicator.
      increment = ch(s) - 0x30;
      skip(s);
    }
  } else if (isDigit(ch(s))) {
    // Do the same as above, but in the opposite order.
    if (ch(s) === 0x30) scannerError(s, 'while scanning a block scalar', startMark, 'found an indentation indicator equal to 0');
    increment = ch(s) - 0x30;
    skip(s);

    cache(s, 1);
    if (ch(s) === 0x2b || ch(s) === 0x2d) {
      chomping = ch(s) === 0x2b ? +1 : -1;
      skip(s);
    }
  }

  // Eat whitespaces and comments to the end of the line.
  cache(s, 1);
  while (isBlank(ch(s))) {
    skip(s);
    cache(s, 1);
  }
  if (ch(s) === 0x23 /* # */) {
    while (!isBreakz(ch(s))) {
      skip(s);
      cache(s, 1);
    }
  }

  // Check if we are at the end of the line.
  if (!isBreakz(ch(s))) scannerError(s, 'while scanning a block scalar', startMark, 'did not find expected comment or line break');

  // Eat a line break.
  if (isBreak(ch(s))) {
    cache(s, 2);
    skipLine(s);
  }

  const ref = { endMark: copyMark(s.mark), indent: 0, breaks: '' };

  // Set the indentation level if it was specified.
  if (increment > 0) ref.indent = s.indent >= 0 ? s.indent + increment : increment;

  // Scan the leading line breaks and determine the indentation level if needed.
  let str = '';
  let leadingBreak = '';
  scanBlockScalarBreaks(s, ref, startMark);

  // Scan the block scalar content.
  cache(s, 1);
  let leadingBlank = false;
  while (s.mark.column === ref.indent && !isZ(ch(s))) {
    // We are at the beginning of a non-empty line.

    // Is it a trailing whitespace?
    const trailingBlank = isBlank(ch(s));

    // Check if we need to fold the leading line break.
    if (!literal && !leadingBlank && !trailingBlank && leadingBreak !== '' && leadingBreak[0] === '\n') {
      // Do we need to join the lines by space?
      if (ref.breaks === '') str += ' ';
    } else {
      str += leadingBreak;
    }
    leadingBreak = '';

    // Append the remaining line breaks.
    str += ref.breaks;
    ref.breaks = '';

    // Is it a leading whitespace?
    leadingBlank = isBlank(ch(s));

    // Consume the current line.
    while (!isBreakz(ch(s))) {
      str = read(s, str);
      cache(s, 1);
    }

    // Consume the line break.
    cache(s, 2);
    leadingBreak = readLine(s, leadingBreak);

    // Eat the following indentation spaces and line breaks.
    scanBlockScalarBreaks(s, ref, startMark);
  }

  // Chomp the tail.
  if (chomping !== -1) str += leadingBreak;
  if (chomping === 1) str += ref.breaks;

  return newToken('scalar', startMark, ref.endMark, { value: str, style: literal ? 'literal' : 'folded' });
}

// upstream: scannerc.go yaml_parser_scan_block_scalar_breaks
function scanBlockScalarBreaks(s: YamlScanner, ref: { endMark: Mark; indent: number; breaks: string }, startMark: Mark): void {
  ref.endMark = copyMark(s.mark);

  // Eat the indentation spaces and line breaks.
  let maxIndent = 0;
  for (;;) {
    // Eat the indentation spaces.
    cache(s, 1);
    while ((ref.indent === 0 || s.mark.column < ref.indent) && isSpace(ch(s))) {
      skip(s);
      cache(s, 1);
    }
    if (s.mark.column > maxIndent) maxIndent = s.mark.column;

    // Check for a tab character messing the indentation.
    if ((ref.indent === 0 || s.mark.column < ref.indent) && isTab(ch(s))) {
      scannerError(s, 'while scanning a block scalar', startMark, 'found a tab character where an indentation space is expected');
    }

    // Have we found a non-empty line?
    if (!isBreak(ch(s))) break;

    // Consume the line break.
    cache(s, 2);
    ref.breaks = readLine(s, ref.breaks);
    ref.endMark = copyMark(s.mark);
  }

  // Determine the indentation level if needed.
  if (ref.indent === 0) {
    ref.indent = maxIndent;
    if (ref.indent < s.indent + 1) ref.indent = s.indent + 1;
    if (ref.indent < 1) ref.indent = 1;
  }
}

// upstream: scannerc.go yaml_parser_scan_flow_scalar
function scanFlowScalar(s: YamlScanner, single: boolean): Token {
  // Eat the left quote.
  const startMark = copyMark(s.mark);
  skip(s);

  // Consume the content of the quoted scalar.
  let str = '';
  let leadingBreak = '';
  let trailingBreaks = '';
  let whitespaces = '';
  for (;;) {
    // Check that there are no document indicators at the beginning of the line.
    cache(s, 4);
    if (
      s.mark.column === 0 &&
      ((ch(s) === 0x2d && ch(s, 1) === 0x2d && ch(s, 2) === 0x2d) || (ch(s) === 0x2e && ch(s, 1) === 0x2e && ch(s, 2) === 0x2e)) &&
      isBlankz(ch(s, 3))
    ) {
      scannerError(s, 'while scanning a quoted scalar', startMark, 'found unexpected document indicator');
    }

    // Check for EOF.
    if (isZ(ch(s))) scannerError(s, 'while scanning a quoted scalar', startMark, 'found unexpected end of stream');

    // Consume non-blank characters.
    let leadingBlanks = false;
    while (!isBlankz(ch(s))) {
      const c = ch(s);
      if (single && c === 0x27 && ch(s, 1) === 0x27) {
        // It is an escaped single quote.
        str += "'";
        skip(s);
        skip(s);
      } else if (single && c === 0x27) {
        // It is a right single quote.
        break;
      } else if (!single && c === 0x22) {
        // It is a right double quote.
        break;
      } else if (!single && c === 0x5c && isBreak(ch(s, 1))) {
        // It is an escaped line break.
        cache(s, 3);
        skip(s);
        skipLine(s);
        leadingBlanks = true;
        break;
      } else if (!single && c === 0x5c) {
        // It is an escape sequence.
        let codeLength = 0;

        // Check the escape character.
        const e = ch(s, 1);
        const simple = SIMPLE_ESCAPES[e];
        if (simple !== undefined) {
          str += simple;
        } else if (e === 0x78 /* x */) {
          codeLength = 2;
        } else if (e === 0x75 /* u */) {
          codeLength = 4;
        } else if (e === 0x55 /* U */) {
          codeLength = 8;
        } else {
          scannerError(s, 'while parsing a quoted scalar', startMark, 'found unknown escape character');
        }

        skip(s);
        skip(s);

        // Consume an arbitrary escape code.
        if (codeLength > 0) {
          let value = 0;

          // Scan the character value.
          cache(s, codeLength);
          for (let k = 0; k < codeLength; k++) {
            if (!isHex(ch(s, k))) scannerError(s, 'while parsing a quoted scalar', startMark, 'did not find expected hexdecimal number');
            value = value * 16 + asHex(ch(s, k));
          }

          // Check the value and write the character.
          if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
            scannerError(s, 'while parsing a quoted scalar', startMark, 'found invalid Unicode character escape code');
          }
          str += String.fromCodePoint(value);

          // Advance the pointer.
          for (let k = 0; k < codeLength; k++) skip(s);
        }
      } else {
        // It is a non-escaped non-blank character.
        str = read(s, str);
      }
      cache(s, 2);
    }

    cache(s, 1);

    // Check if we are at the end of the scalar.
    if (single) {
      if (ch(s) === 0x27) break;
    } else {
      if (ch(s) === 0x22) break;
    }

    // Consume blank characters.
    while (isBlank(ch(s)) || isBreak(ch(s))) {
      if (isBlank(ch(s))) {
        // Consume a space or a tab character.
        if (!leadingBlanks) {
          whitespaces = read(s, whitespaces);
        } else {
          skip(s);
        }
      } else {
        cache(s, 2);
        // Check if it is a first line break.
        if (!leadingBlanks) {
          whitespaces = '';
          leadingBreak = readLine(s, leadingBreak);
          leadingBlanks = true;
        } else {
          trailingBreaks = readLine(s, trailingBreaks);
        }
      }
      cache(s, 1);
    }

    // Join the whitespaces or fold line breaks.
    if (leadingBlanks) {
      // Do we need to fold line breaks?
      if (leadingBreak !== '' && leadingBreak[0] === '\n') {
        if (trailingBreaks === '') {
          str += ' ';
        } else {
          str += trailingBreaks;
        }
      } else {
        str += leadingBreak;
        str += trailingBreaks;
      }
      trailingBreaks = '';
      leadingBreak = '';
    } else {
      str += whitespaces;
      whitespaces = '';
    }
  }

  // Eat the right quote.
  skip(s);
  return newToken('scalar', startMark, s.mark, { value: str, style: single ? 'single-quoted' : 'double-quoted' });
}

// upstream: scannerc.go yaml_parser_scan_flow_scalar, the escape switch without \x \u \U.
const SIMPLE_ESCAPES: Record<number, string> = {
  0x30: '\0', // 0
  0x61: '\x07', // a
  0x62: '\x08', // b
  0x74: '\x09', // t
  0x09: '\x09', // TAB
  0x6e: '\x0a', // n
  0x76: '\x0b', // v
  0x66: '\x0c', // f
  0x72: '\x0d', // r
  0x65: '\x1b', // e
  0x20: ' ',
  0x22: '"',
  0x27: "'",
  0x5c: '\\',
  0x4e: '\u0085', // N: NEL (#x85)
  0x5f: ' ', // _: #xA0
  0x4c: '\u2028', // L: LS (#x2028)
  0x50: '\u2029', // P: PS (#x2029)
};

// upstream: scannerc.go yaml_parser_scan_plain_scalar
function scanPlainScalar(s: YamlScanner): Token {
  let str = '';
  let leadingBreak = '';
  let trailingBreaks = '';
  let whitespaces = '';
  let leadingBlanks = false;
  const indent = s.indent + 1;

  const startMark = copyMark(s.mark);
  let endMark = copyMark(s.mark);

  // Consume the content of the plain scalar.
  for (;;) {
    // Check for a document indicator.
    cache(s, 4);
    if (
      s.mark.column === 0 &&
      ((ch(s) === 0x2d && ch(s, 1) === 0x2d && ch(s, 2) === 0x2d) || (ch(s) === 0x2e && ch(s, 1) === 0x2e && ch(s, 2) === 0x2e)) &&
      isBlankz(ch(s, 3))
    ) {
      break;
    }

    // Check for a comment.
    if (ch(s) === 0x23 /* # */) break;

    // Consume non-blank characters.
    while (!isBlankz(ch(s))) {
      const c = ch(s);
      // Check for indicators that may end a plain scalar.
      if (
        (c === 0x3a && isBlankz(ch(s, 1))) ||
        (s.flowLevel > 0 && (c === 0x2c || c === 0x3f || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d))
      ) {
        break;
      }

      // Check if we need to join whitespaces and breaks.
      if (leadingBlanks || whitespaces !== '') {
        if (leadingBlanks) {
          // Do we need to fold line breaks?
          if (leadingBreak[0] === '\n') {
            if (trailingBreaks === '') {
              str += ' ';
            } else {
              str += trailingBreaks;
            }
          } else {
            str += leadingBreak;
            str += trailingBreaks;
          }
          trailingBreaks = '';
          leadingBreak = '';
          leadingBlanks = false;
        } else {
          str += whitespaces;
          whitespaces = '';
        }
      }

      // Copy the character.
      str = read(s, str);
      endMark = copyMark(s.mark);
      cache(s, 2);
    }

    // Is it the end?
    if (!(isBlank(ch(s)) || isBreak(ch(s)))) break;

    // Consume blank characters.
    cache(s, 1);

    while (isBlank(ch(s)) || isBreak(ch(s))) {
      if (isBlank(ch(s))) {
        // Check for tab characters that abuse indentation.
        if (leadingBlanks && s.mark.column < indent && isTab(ch(s))) {
          scannerError(s, 'while scanning a plain scalar', startMark, 'found a tab character that violates indentation');
        }
        // Consume a space or a tab character.
        if (!leadingBlanks) {
          whitespaces = read(s, whitespaces);
        } else {
          skip(s);
        }
      } else {
        cache(s, 2);
        // Check if it is a first line break.
        if (!leadingBlanks) {
          whitespaces = '';
          leadingBreak = readLine(s, leadingBreak);
          leadingBlanks = true;
        } else {
          trailingBreaks = readLine(s, trailingBreaks);
        }
      }
      cache(s, 1);
    }

    // Check indentation level.
    if (s.flowLevel === 0 && s.mark.column < indent) break;
  }

  // Note that we change the 'simple_key_allowed' flag.
  if (leadingBlanks) s.simpleKeyAllowed = true;

  return newToken('scalar', startMark, endMark, { value: str, style: 'plain' });
}
