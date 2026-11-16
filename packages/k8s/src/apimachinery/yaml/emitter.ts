// The libyaml emitter as go.yaml.in/yaml/v2 runs it for yaml.Marshal: block style, indent 2,
// line width 80, unicode output, LF breaks. Ported for the events the encoder produces (no
// anchors, aliases, tags or directives: the encoder only emits those for Go values a JSON
// document cannot hold); the canonical mode is not ported.
//
// upstream: vendor/go.yaml.in/yaml/v2/emitterc.go (state machine, yaml_emitter_analyze_scalar,
// yaml_emitter_select_scalar_style, yaml_emitter_write_* scalar writers, write_indent,
// write_indicator, check_simple_key), yamlprivateh.go (character classes), apic.go
// (yaml_emitter_initialize: best_width 0 becomes 80 unless FutureLineWrap was called, which
// Kubernetes does not do).

export type EmitScalarStyle = 'plain' | 'single-quoted' | 'double-quoted' | 'literal' | 'folded';

export type EmitEvent =
  | { type: 'stream-start' }
  | { type: 'stream-end' }
  | { type: 'document-start'; implicit: boolean }
  | { type: 'document-end'; implicit: boolean }
  | { type: 'scalar'; value: string; style: EmitScalarStyle }
  | { type: 'sequence-start'; flow: boolean }
  | { type: 'sequence-end' }
  | { type: 'mapping-start'; flow: boolean }
  | { type: 'mapping-end' };

const BEST_INDENT = 2;
const BEST_WIDTH = 80;

type State =
  | 'stream-start'
  | 'first-document-start'
  | 'document-start'
  | 'document-content'
  | 'document-end'
  | 'flow-sequence-first-item'
  | 'flow-sequence-item'
  | 'flow-mapping-first-key'
  | 'flow-mapping-key'
  | 'flow-mapping-simple-value'
  | 'flow-mapping-value'
  | 'block-sequence-first-item'
  | 'block-sequence-item'
  | 'block-mapping-first-key'
  | 'block-mapping-key'
  | 'block-mapping-simple-value'
  | 'block-mapping-value'
  | 'end';

interface ScalarData {
  /** The value as code points. */
  value: number[];
  /** UTF-8 length, as libyaml's len(value). */
  bytes: number;
  multiline: boolean;
  flowPlainAllowed: boolean;
  blockPlainAllowed: boolean;
  singleQuotedAllowed: boolean;
  blockAllowed: boolean;
  style: EmitScalarStyle;
}

interface Emitter {
  out: string[];
  events: EmitEvent[];
  head: number;
  state: State;
  states: State[];
  indent: number;
  indents: number[];
  flowLevel: number;
  rootContext: boolean;
  sequenceContext: boolean;
  mappingContext: boolean;
  simpleKeyContext: boolean;
  column: number;
  whitespace: boolean;
  indention: boolean;
  openEnded: boolean;
  scalar: ScalarData;
}

export class EmitterError extends Error {}

// ---- character classes (yamlprivateh.go), on code points ----

const NUL = -1; // past the end: is_z

function isPrintable(c: number): boolean {
  return c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff);
}
const isSpace = (c: number): boolean => c === 0x20;
const isBlank = (c: number): boolean => c === 0x20 || c === 0x09;
const isBreak = (c: number): boolean => c === 0x0d || c === 0x0a || c === 0x85 || c === 0x2028 || c === 0x2029;
const isBreakz = (c: number): boolean => isBreak(c) || c === NUL || c === 0;
const isBlankz = (c: number): boolean => isBlank(c) || isBreakz(c);

function utf8Len(c: number): number {
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

function at(v: number[], i: number): number {
  return i < v.length ? (v[i] as number) : NUL;
}

// ---- output primitives ----

function put(e: Emitter, ch: string): void {
  e.out.push(ch);
  e.column++;
}

function putBreak(e: Emitter): void {
  e.out.push('\n');
  e.column = 0;
}

/** write: copy one character of the value. */
function write(e: Emitter, c: number): void {
  e.out.push(String.fromCodePoint(c));
  e.column++;
}

function writeAll(e: Emitter, s: string): void {
  for (const ch of s) write(e, ch.codePointAt(0) as number);
}

function writeBreak(e: Emitter, c: number): void {
  if (c === 0x0a) putBreak(e);
  else {
    write(e, c);
    e.column = 0;
  }
}

function writeIndent(e: Emitter): void {
  const indent = e.indent < 0 ? 0 : e.indent;
  if (!e.indention || e.column > indent || (e.column === indent && !e.whitespace)) putBreak(e);
  while (e.column < indent) put(e, ' ');
  e.whitespace = true;
  e.indention = true;
}

function writeIndicator(e: Emitter, indicator: string, needWhitespace: boolean, isWhitespace: boolean, isIndention: boolean): void {
  if (needWhitespace && !e.whitespace) put(e, ' ');
  writeAll(e, indicator);
  e.whitespace = isWhitespace;
  e.indention = e.indention && isIndention;
  e.openEnded = false;
}

function increaseIndent(e: Emitter, flow: boolean, indentless: boolean): void {
  e.indents.push(e.indent);
  if (e.indent < 0) e.indent = flow ? BEST_INDENT : 0;
  else if (!indentless) e.indent += BEST_INDENT;
}

function popIndent(e: Emitter): void {
  e.indent = e.indents.pop() as number;
}

function popState(e: Emitter): void {
  e.state = e.states.pop() as State;
}

// ---- analysis ----

function analyzeScalar(e: Emitter, s: string): void {
  const value = Array.from(s, (ch) => ch.codePointAt(0) as number);
  const d: ScalarData = {
    value,
    bytes: value.reduce((n, c) => n + utf8Len(c), 0),
    multiline: false,
    flowPlainAllowed: false,
    blockPlainAllowed: true,
    singleQuotedAllowed: true,
    blockAllowed: false,
    style: 'plain',
  };
  e.scalar = d;
  if (value.length === 0) return;

  let blockIndicators = false;
  let flowIndicators = false;
  let lineBreaks = false;
  let specialCharacters = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let previousSpace = false;
  let previousBreak = false;

  if (value.length >= 3 && ((value[0] === 0x2d && value[1] === 0x2d && value[2] === 0x2d) || (value[0] === 0x2e && value[1] === 0x2e && value[2] === 0x2e))) {
    blockIndicators = true;
    flowIndicators = true;
  }
  let precededByWhitespace = true;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as number;
    const followedByWhitespace = i + 1 >= value.length || isBlank(value[i + 1] as number);
    const ch = String.fromCodePoint(c);
    if (i === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) {
        flowIndicators = true;
        blockIndicators = true;
      } else if (ch === '?' || ch === ':') {
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      } else if (ch === '-') {
        if (followedByWhitespace) {
          flowIndicators = true;
          blockIndicators = true;
        }
      }
    } else {
      if (',?[]{}'.includes(ch)) flowIndicators = true;
      else if (ch === ':') {
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      } else if (ch === '#') {
        if (precededByWhitespace) {
          flowIndicators = true;
          blockIndicators = true;
        }
      }
    }
    // emitter.unicode is true (yaml_emitter_set_unicode in newEncoder).
    if (!isPrintable(c)) specialCharacters = true;
    if (isSpace(c)) {
      if (i === 0) leadingSpace = true;
      if (i + 1 === value.length) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (isBreak(c)) {
      lineBreaks = true;
      if (i === 0) leadingBreak = true;
      if (i + 1 === value.length) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWhitespace = isBlankz(c);
  }

  d.multiline = lineBreaks;
  d.flowPlainAllowed = true;
  d.blockPlainAllowed = true;
  d.singleQuotedAllowed = true;
  d.blockAllowed = true;
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
    d.flowPlainAllowed = false;
    d.blockPlainAllowed = false;
  }
  if (trailingSpace) d.blockAllowed = false;
  if (breakSpace) {
    d.flowPlainAllowed = false;
    d.blockPlainAllowed = false;
    d.singleQuotedAllowed = false;
  }
  if (spaceBreak || specialCharacters) {
    d.flowPlainAllowed = false;
    d.blockPlainAllowed = false;
    d.singleQuotedAllowed = false;
    d.blockAllowed = false;
  }
  if (lineBreaks) {
    d.flowPlainAllowed = false;
    d.blockPlainAllowed = false;
  }
  if (flowIndicators) d.flowPlainAllowed = false;
  if (blockIndicators) d.blockPlainAllowed = false;
}

function analyzeEvent(e: Emitter, ev: EmitEvent): void {
  if (ev.type === 'scalar') analyzeScalar(e, ev.value);
}

// ---- checks ----

function checkEmptySequence(e: Emitter): boolean {
  return e.events[e.head]?.type === 'sequence-start' && e.events[e.head + 1]?.type === 'sequence-end';
}

function checkEmptyMapping(e: Emitter): boolean {
  return e.events[e.head]?.type === 'mapping-start' && e.events[e.head + 1]?.type === 'mapping-end';
}

function checkSimpleKey(e: Emitter): boolean {
  let length = 0;
  const ev = e.events[e.head] as EmitEvent;
  switch (ev.type) {
    case 'scalar':
      if (e.scalar.multiline) return false;
      length += e.scalar.bytes;
      break;
    case 'sequence-start':
      if (!checkEmptySequence(e)) return false;
      break;
    case 'mapping-start':
      if (!checkEmptyMapping(e)) return false;
      break;
    default:
      return false;
  }
  return length <= 128;
}

// ---- scalar writers ----

function selectScalarStyle(e: Emitter, ev: Extract<EmitEvent, { type: 'scalar' }>): void {
  let style = ev.style;
  const d = e.scalar;
  if (e.simpleKeyContext && d.multiline) style = 'double-quoted';
  if (style === 'plain') {
    if ((e.flowLevel > 0 && !d.flowPlainAllowed) || (e.flowLevel === 0 && !d.blockPlainAllowed)) style = 'single-quoted';
    if (d.value.length === 0 && (e.flowLevel > 0 || e.simpleKeyContext)) style = 'single-quoted';
  }
  if (style === 'single-quoted' && !d.singleQuotedAllowed) style = 'double-quoted';
  if ((style === 'literal' || style === 'folded') && (!d.blockAllowed || e.flowLevel > 0 || e.simpleKeyContext)) style = 'double-quoted';
  d.style = style;
}

function writePlainScalar(e: Emitter, value: number[], allowBreaks: boolean): void {
  if (!e.whitespace) put(e, ' ');
  let spaces = false;
  let breaks = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as number;
    if (isSpace(c)) {
      if (allowBreaks && !spaces && e.column > BEST_WIDTH && !isSpace(at(value, i + 1))) writeIndent(e);
      else write(e, c);
      spaces = true;
    } else if (isBreak(c)) {
      if (!breaks && c === 0x0a) putBreak(e);
      writeBreak(e, c);
      e.indention = true;
      breaks = true;
    } else {
      if (breaks) writeIndent(e);
      write(e, c);
      e.indention = false;
      spaces = false;
      breaks = false;
    }
  }
  e.whitespace = false;
  e.indention = false;
  if (e.rootContext) e.openEnded = true;
}

function writeSingleQuotedScalar(e: Emitter, value: number[], allowBreaks: boolean): void {
  writeIndicator(e, "'", true, false, false);
  let spaces = false;
  let breaks = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as number;
    if (isSpace(c)) {
      if (allowBreaks && !spaces && e.column > BEST_WIDTH && i > 0 && i < value.length - 1 && !isSpace(at(value, i + 1))) writeIndent(e);
      else write(e, c);
      spaces = true;
    } else if (isBreak(c)) {
      if (!breaks && c === 0x0a) putBreak(e);
      writeBreak(e, c);
      e.indention = true;
      breaks = true;
    } else {
      if (breaks) writeIndent(e);
      if (c === 0x27) put(e, "'");
      write(e, c);
      e.indention = false;
      spaces = false;
      breaks = false;
    }
  }
  writeIndicator(e, "'", false, false, false);
  e.whitespace = false;
  e.indention = false;
}

const SHORT_ESCAPES: Record<number, string> = {
  0x00: '0',
  0x07: 'a',
  0x08: 'b',
  0x09: 't',
  0x0a: 'n',
  0x0b: 'v',
  0x0c: 'f',
  0x0d: 'r',
  0x1b: 'e',
  0x22: '"',
  0x5c: '\\',
  0x85: 'N',
  0xa0: '_',
  0x2028: 'L',
  0x2029: 'P',
};

function writeDoubleQuotedScalar(e: Emitter, value: number[], allowBreaks: boolean): void {
  let spaces = false;
  writeIndicator(e, '"', true, false, false);
  // is_bom(value, i) looks at the first three bytes of the value whatever i is: a value that
  // starts with U+FEFF has every character escaped.
  const bom = value[0] === 0xfeff;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as number;
    if (!isPrintable(c) || bom || isBreak(c) || c === 0x22 || c === 0x5c) {
      put(e, '\\');
      const short = SHORT_ESCAPES[c];
      if (short !== undefined) put(e, short);
      else {
        const [letter, w] = c <= 0xff ? ['x', 2] : c <= 0xffff ? ['u', 4] : ['U', 8];
        put(e, letter);
        for (const h of c.toString(16).toUpperCase().padStart(w, '0')) put(e, h);
      }
      spaces = false;
    } else if (isSpace(c)) {
      if (allowBreaks && !spaces && e.column > BEST_WIDTH && i > 0 && i < value.length - 1) {
        writeIndent(e);
        if (isSpace(at(value, i + 1))) put(e, '\\');
      } else write(e, c);
      spaces = true;
    } else {
      write(e, c);
      spaces = false;
    }
  }
  writeIndicator(e, '"', false, false, false);
  e.whitespace = false;
  e.indention = false;
}

function writeBlockScalarHints(e: Emitter, value: number[]): void {
  if (isSpace(at(value, 0)) || isBreak(at(value, 0))) writeIndicator(e, String(BEST_INDENT), false, false, false);
  e.openEnded = false;
  let chomp = '';
  if (value.length === 0) chomp = '-';
  else {
    let i = value.length - 1;
    if (!isBreak(value[i] as number)) chomp = '-';
    else if (i === 0) {
      chomp = '+';
      e.openEnded = true;
    } else {
      i--;
      if (isBreak(value[i] as number)) {
        chomp = '+';
        e.openEnded = true;
      }
    }
  }
  if (chomp !== '') writeIndicator(e, chomp, false, false, false);
}

function writeLiteralScalar(e: Emitter, value: number[]): void {
  writeIndicator(e, '|', true, false, false);
  writeBlockScalarHints(e, value);
  putBreak(e);
  e.indention = true;
  e.whitespace = true;
  let breaks = true;
  for (const c of value) {
    if (isBreak(c)) {
      writeBreak(e, c);
      e.indention = true;
      breaks = true;
    } else {
      if (breaks) writeIndent(e);
      write(e, c);
      e.indention = false;
      breaks = false;
    }
  }
}

function writeFoldedScalar(e: Emitter, value: number[]): void {
  writeIndicator(e, '>', true, false, false);
  writeBlockScalarHints(e, value);
  putBreak(e);
  e.indention = true;
  e.whitespace = true;
  let breaks = true;
  let leadingSpaces = true;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as number;
    if (isBreak(c)) {
      if (!breaks && !leadingSpaces && c === 0x0a) {
        // upstream bug kept: k starts at 0, not i.
        let k = 0;
        while (isBreak(at(value, k))) k++;
        if (!isBlankz(at(value, k))) putBreak(e);
      }
      writeBreak(e, c);
      e.indention = true;
      breaks = true;
    } else {
      if (breaks) {
        writeIndent(e);
        leadingSpaces = isBlank(c);
      }
      if (!breaks && isSpace(c) && !isSpace(at(value, i + 1)) && e.column > BEST_WIDTH) writeIndent(e);
      else write(e, c);
      e.indention = false;
      breaks = false;
    }
  }
}

function processScalar(e: Emitter): void {
  const d = e.scalar;
  switch (d.style) {
    case 'plain':
      return writePlainScalar(e, d.value, !e.simpleKeyContext);
    case 'single-quoted':
      return writeSingleQuotedScalar(e, d.value, !e.simpleKeyContext);
    case 'double-quoted':
      return writeDoubleQuotedScalar(e, d.value, !e.simpleKeyContext);
    case 'literal':
      return writeLiteralScalar(e, d.value);
    case 'folded':
      return writeFoldedScalar(e, d.value);
  }
}

// ---- state machine ----

function emitNode(e: Emitter, ev: EmitEvent, root: boolean, sequence: boolean, mapping: boolean, simpleKey: boolean): void {
  e.rootContext = root;
  e.sequenceContext = sequence;
  e.mappingContext = mapping;
  e.simpleKeyContext = simpleKey;
  switch (ev.type) {
    case 'scalar':
      selectScalarStyle(e, ev);
      increaseIndent(e, true, false);
      processScalar(e);
      popIndent(e);
      popState(e);
      return;
    case 'sequence-start':
      e.state = e.flowLevel > 0 || ev.flow || checkEmptySequence(e) ? 'flow-sequence-first-item' : 'block-sequence-first-item';
      return;
    case 'mapping-start':
      e.state = e.flowLevel > 0 || ev.flow || checkEmptyMapping(e) ? 'flow-mapping-first-key' : 'block-mapping-first-key';
      return;
    default:
      throw new EmitterError(`expected SCALAR, SEQUENCE-START, MAPPING-START, or ALIAS, but got ${ev.type}`);
  }
}

function flowSequenceItem(e: Emitter, ev: EmitEvent, first: boolean): void {
  if (first) {
    writeIndicator(e, '[', true, true, false);
    increaseIndent(e, true, false);
    e.flowLevel++;
  }
  if (ev.type === 'sequence-end') {
    e.flowLevel--;
    popIndent(e);
    writeIndicator(e, ']', false, false, false);
    popState(e);
    return;
  }
  if (!first) writeIndicator(e, ',', false, false, false);
  if (e.column > BEST_WIDTH) writeIndent(e);
  e.states.push('flow-sequence-item');
  emitNode(e, ev, false, true, false, false);
}

function flowMappingKey(e: Emitter, ev: EmitEvent, first: boolean): void {
  if (first) {
    writeIndicator(e, '{', true, true, false);
    increaseIndent(e, true, false);
    e.flowLevel++;
  }
  if (ev.type === 'mapping-end') {
    e.flowLevel--;
    popIndent(e);
    writeIndicator(e, '}', false, false, false);
    popState(e);
    return;
  }
  if (!first) writeIndicator(e, ',', false, false, false);
  if (e.column > BEST_WIDTH) writeIndent(e);
  if (checkSimpleKey(e)) {
    e.states.push('flow-mapping-simple-value');
    emitNode(e, ev, false, false, true, true);
    return;
  }
  writeIndicator(e, '?', true, false, false);
  e.states.push('flow-mapping-value');
  emitNode(e, ev, false, false, true, false);
}

function flowMappingValue(e: Emitter, ev: EmitEvent, simple: boolean): void {
  if (simple) writeIndicator(e, ':', false, false, false);
  else {
    if (e.column > BEST_WIDTH) writeIndent(e);
    writeIndicator(e, ':', true, false, false);
  }
  e.states.push('flow-mapping-key');
  emitNode(e, ev, false, false, true, false);
}

function blockSequenceItem(e: Emitter, ev: EmitEvent, first: boolean): void {
  if (first) increaseIndent(e, false, e.mappingContext && !e.indention);
  if (ev.type === 'sequence-end') {
    popIndent(e);
    popState(e);
    return;
  }
  writeIndent(e);
  writeIndicator(e, '-', true, false, true);
  e.states.push('block-sequence-item');
  emitNode(e, ev, false, true, false, false);
}

function blockMappingKey(e: Emitter, ev: EmitEvent, first: boolean): void {
  if (first) increaseIndent(e, false, false);
  if (ev.type === 'mapping-end') {
    popIndent(e);
    popState(e);
    return;
  }
  writeIndent(e);
  if (checkSimpleKey(e)) {
    e.states.push('block-mapping-simple-value');
    emitNode(e, ev, false, false, true, true);
    return;
  }
  writeIndicator(e, '?', true, false, true);
  e.states.push('block-mapping-value');
  emitNode(e, ev, false, false, true, false);
}

function blockMappingValue(e: Emitter, ev: EmitEvent, simple: boolean): void {
  if (simple) writeIndicator(e, ':', false, false, false);
  else {
    writeIndent(e);
    writeIndicator(e, ':', true, false, true);
  }
  e.states.push('block-mapping-key');
  emitNode(e, ev, false, false, true, false);
}

function stateMachine(e: Emitter, ev: EmitEvent): void {
  switch (e.state) {
    case 'stream-start':
      if (ev.type !== 'stream-start') throw new EmitterError('expected STREAM-START');
      e.indent = -1;
      e.column = 0;
      e.whitespace = true;
      e.indention = true;
      e.state = 'first-document-start';
      return;
    case 'first-document-start':
    case 'document-start': {
      if (ev.type === 'document-start') {
        const implicit = ev.implicit && e.state === 'first-document-start';
        if (!implicit) {
          writeIndent(e);
          writeIndicator(e, '---', true, false, false);
        }
        e.state = 'document-content';
        return;
      }
      if (ev.type === 'stream-end') {
        if (e.openEnded) {
          writeIndicator(e, '...', true, false, false);
          writeIndent(e);
        }
        e.state = 'end';
        return;
      }
      throw new EmitterError('expected DOCUMENT-START or STREAM-END');
    }
    case 'document-content':
      e.states.push('document-end');
      emitNode(e, ev, true, false, false, false);
      return;
    case 'document-end':
      if (ev.type !== 'document-end') throw new EmitterError('expected DOCUMENT-END');
      writeIndent(e);
      if (!ev.implicit) {
        writeIndicator(e, '...', true, false, false);
        writeIndent(e);
      }
      e.state = 'document-start';
      return;
    case 'flow-sequence-first-item':
      return flowSequenceItem(e, ev, true);
    case 'flow-sequence-item':
      return flowSequenceItem(e, ev, false);
    case 'flow-mapping-first-key':
      return flowMappingKey(e, ev, true);
    case 'flow-mapping-key':
      return flowMappingKey(e, ev, false);
    case 'flow-mapping-simple-value':
      return flowMappingValue(e, ev, true);
    case 'flow-mapping-value':
      return flowMappingValue(e, ev, false);
    case 'block-sequence-first-item':
      return blockSequenceItem(e, ev, true);
    case 'block-sequence-item':
      return blockSequenceItem(e, ev, false);
    case 'block-mapping-first-key':
      return blockMappingKey(e, ev, true);
    case 'block-mapping-key':
      return blockMappingKey(e, ev, false);
    case 'block-mapping-simple-value':
      return blockMappingValue(e, ev, true);
    case 'block-mapping-value':
      return blockMappingValue(e, ev, false);
    case 'end':
      throw new EmitterError('expected nothing');
  }
}

/**
 * Emit a complete event stream. All events are known up front, which gives the same lookahead
 * as yaml_emitter_need_more_events (it only ever looks one event past the current one).
 * `openEndedAtEnd` mirrors encoder.finish, which clears open_ended before STREAM-END.
 */
export function emit(events: EmitEvent[], opts: { clearOpenEndedBeforeStreamEnd?: boolean } = {}): string {
  const e: Emitter = {
    out: [],
    events,
    head: 0,
    state: 'stream-start',
    states: [],
    indent: -1,
    indents: [],
    flowLevel: 0,
    rootContext: false,
    sequenceContext: false,
    mappingContext: false,
    simpleKeyContext: false,
    column: 0,
    whitespace: true,
    indention: true,
    openEnded: false,
    scalar: { value: [], bytes: 0, multiline: false, flowPlainAllowed: false, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: false, style: 'plain' },
  };
  for (; e.head < events.length; e.head++) {
    const ev = events[e.head] as EmitEvent;
    if (ev.type === 'stream-end' && opts.clearOpenEndedBeforeStreamEnd) e.openEnded = false;
    analyzeEvent(e, ev);
    stateMachine(e, ev);
  }
  return e.out.join('');
}
