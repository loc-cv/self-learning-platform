// The libyaml parser as go.yaml.in/yaml/v2 v2.4.4 has it: tokens in, events out. A
// function-by-function port of parserc.go with libyaml's names in camelCase. Events are pulled
// one at a time and the scanner runs only as far as libyaml's lookahead needs, so an error
// later in the stream surfaces exactly when yaml_parser_parse would report it.
//
// Go-specific behaviour kept on purpose (it differs from C libyaml):
//   - DOCUMENT-START events always carry implicit=false (parserc.go never sets it);
//   - the empty value of a single-pair mapping inside a flow sequence (`[a: ]`) takes its mark
//     from a stale pointer into the token queue (parseFlowSequenceEntryMappingValue);
//   - after STREAM-END or an error, yaml_parser_parse returns an empty event; here nextEvent
//     returns the STREAM-END event again, or throws the same error again.
//
// upstream: vendor/go.yaml.in/yaml/v2/parserc.go, decode.go newParser

import type { Mark, YamlEvent } from './events.ts';
import { YamlSyntaxError } from './events.ts';
import type { Token, YamlScanner } from './scanner.ts';
import { fetchMoreTokens, newScanner } from './scanner.ts';

// upstream: yamlh.go yaml_parser_state_t
type ParserState =
  | 'stream-start'
  | 'implicit-document-start'
  | 'document-start'
  | 'document-content'
  | 'document-end'
  | 'block-node'
  | 'block-node-or-indentless-sequence'
  | 'flow-node'
  | 'block-sequence-first-entry'
  | 'block-sequence-entry'
  | 'indentless-sequence-entry'
  | 'block-mapping-first-key'
  | 'block-mapping-key'
  | 'block-mapping-value'
  | 'flow-sequence-first-entry'
  | 'flow-sequence-entry'
  | 'flow-sequence-entry-mapping-key'
  | 'flow-sequence-entry-mapping-value'
  | 'flow-sequence-entry-mapping-end'
  | 'flow-mapping-first-key'
  | 'flow-mapping-key'
  | 'flow-mapping-value'
  | 'flow-mapping-empty-value'
  | 'end';

interface TagDirective {
  handle: string;
  prefix: string;
}

/** yaml_parser_t: the scanner plus the parser's state. Plain data; transient, never world state. */
export interface YamlParser {
  scanner: YamlScanner;
  state: ParserState;
  states: ParserState[];
  marks: Mark[];
  tagDirectives: TagDirective[];
  /** The error that stopped the parser (yaml_parser_t error/problem/context), thrown again. */
  error: YamlSyntaxError | null;
  /** The STREAM-END event, returned again on later calls. */
  streamEnd: YamlEvent | null;
}

/** decode.go newParser: yaml_parser_initialize + yaml_parser_set_input_string; empty input is "\n". */
export function newParser(input: string): YamlParser {
  return {
    scanner: newScanner(input === '' ? '\n' : input),
    state: 'stream-start',
    states: [],
    marks: [],
    tagDirectives: [],
    error: null,
    streamEnd: null,
  };
}

/** upstream: parserc.go yaml_parser_parse. Throws YamlSyntaxError on a reader, scanner or parser error. */
export function nextEvent(p: YamlParser): YamlEvent {
  if (p.error !== null) throw p.error;
  if (p.streamEnd !== null) return { ...p.streamEnd };
  try {
    const event = stateMachine(p);
    if (event.type === 'stream-end') p.streamEnd = event;
    return event;
  } catch (e) {
    if (e instanceof YamlSyntaxError) p.error = e;
    throw e;
  }
}

const copyMark = (m: Mark): Mark => ({ index: m.index, line: m.line, column: m.column });

// upstream: parserc.go peek_token
function peekToken(p: YamlParser): Token {
  const s = p.scanner;
  if (!s.tokenAvailable) fetchMoreTokens(s);
  return s.tokens.arr[s.tokensHead]!;
}

// upstream: parserc.go skip_token
function skipToken(p: YamlParser): void {
  const s = p.scanner;
  s.tokenAvailable = false;
  s.tokensParsed++;
  s.streamEndProduced = s.tokens.arr[s.tokensHead]!.type === 'stream-end';
  s.tokensHead++;
}

// upstream: parserc.go yaml_parser_set_parser_error
function parserError(problem: string, problemMark: Mark): never {
  throw new YamlSyntaxError('parser', problem, copyMark(problemMark));
}

// upstream: parserc.go yaml_parser_set_parser_error_context
function parserErrorContext(context: string, contextMark: Mark, problem: string, problemMark: Mark): never {
  throw new YamlSyntaxError('parser', problem, copyMark(problemMark), context, copyMark(contextMark));
}

function popState(p: YamlParser): ParserState {
  return p.states.pop()!;
}

// upstream: parserc.go yaml_parser_state_machine
function stateMachine(p: YamlParser): YamlEvent {
  switch (p.state) {
    case 'stream-start':
      return parseStreamStart(p);
    case 'implicit-document-start':
      return parseDocumentStart(p, true);
    case 'document-start':
      return parseDocumentStart(p, false);
    case 'document-content':
      return parseDocumentContent(p);
    case 'document-end':
      return parseDocumentEnd(p);
    case 'block-node':
      return parseNode(p, true, false);
    case 'block-node-or-indentless-sequence':
      return parseNode(p, true, true);
    case 'flow-node':
      return parseNode(p, false, false);
    case 'block-sequence-first-entry':
      return parseBlockSequenceEntry(p, true);
    case 'block-sequence-entry':
      return parseBlockSequenceEntry(p, false);
    case 'indentless-sequence-entry':
      return parseIndentlessSequenceEntry(p);
    case 'block-mapping-first-key':
      return parseBlockMappingKey(p, true);
    case 'block-mapping-key':
      return parseBlockMappingKey(p, false);
    case 'block-mapping-value':
      return parseBlockMappingValue(p);
    case 'flow-sequence-first-entry':
      return parseFlowSequenceEntry(p, true);
    case 'flow-sequence-entry':
      return parseFlowSequenceEntry(p, false);
    case 'flow-sequence-entry-mapping-key':
      return parseFlowSequenceEntryMappingKey(p);
    case 'flow-sequence-entry-mapping-value':
      return parseFlowSequenceEntryMappingValue(p);
    case 'flow-sequence-entry-mapping-end':
      return parseFlowSequenceEntryMappingEnd(p);
    case 'flow-mapping-first-key':
      return parseFlowMappingKey(p, true);
    case 'flow-mapping-key':
      return parseFlowMappingKey(p, false);
    case 'flow-mapping-value':
      return parseFlowMappingValue(p, false);
    case 'flow-mapping-empty-value':
      return parseFlowMappingValue(p, true);
    case 'end':
      // yaml_parser_parse returns before the state machine in the END state.
      throw new Error('yaml: parser in the end state');
  }
}

// Parse the production:
// stream   ::= STREAM-START implicit_document? explicit_document* STREAM-END
//              ************
// upstream: parserc.go yaml_parser_parse_stream_start
function parseStreamStart(p: YamlParser): YamlEvent {
  const token = peekToken(p);
  if (token.type !== 'stream-start') parserError('did not find expected <stream-start>', token.startMark);
  p.state = 'implicit-document-start';
  const event: YamlEvent = { type: 'stream-start', start: copyMark(token.startMark), end: copyMark(token.endMark) };
  skipToken(p);
  return event;
}

// Parse the productions:
// implicit_document    ::= block_node DOCUMENT-END*
//                          *
// explicit_document    ::= DIRECTIVE* DOCUMENT-START block_node? DOCUMENT-END*
//                          *************************
// upstream: parserc.go yaml_parser_parse_document_start
function parseDocumentStart(p: YamlParser, implicit: boolean): YamlEvent {
  let token = peekToken(p);

  // Parse extra document end indicators.
  if (!implicit) {
    while (token.type === 'document-end') {
      skipToken(p);
      token = peekToken(p);
    }
  }

  if (implicit && token.type !== 'version-directive' && token.type !== 'tag-directive' && token.type !== 'document-start' && token.type !== 'stream-end') {
    // Parse an implicit document.
    processDirectives(p);
    p.states.push('document-end');
    p.state = 'block-node';
    // [Go] implicit is left false here.
    return { type: 'document-start', start: copyMark(token.startMark), end: copyMark(token.endMark), implicit: false };
  }

  if (token.type !== 'stream-end') {
    // Parse an explicit document.
    const startMark = copyMark(token.startMark);
    processDirectives(p);
    token = peekToken(p);
    if (token.type !== 'document-start') parserError('did not find expected <document start>', token.startMark);
    p.states.push('document-end');
    p.state = 'document-content';
    const event: YamlEvent = { type: 'document-start', start: startMark, end: copyMark(token.endMark), implicit: false };
    skipToken(p);
    return event;
  }

  // Parse the stream end.
  p.state = 'end';
  const event: YamlEvent = { type: 'stream-end', start: copyMark(token.startMark), end: copyMark(token.endMark) };
  skipToken(p);
  return event;
}

// Parse the productions:
// explicit_document    ::= DIRECTIVE* DOCUMENT-START block_node? DOCUMENT-END*
//                                                    ***********
// upstream: parserc.go yaml_parser_parse_document_content
function parseDocumentContent(p: YamlParser): YamlEvent {
  const token = peekToken(p);
  if (token.type === 'version-directive' || token.type === 'tag-directive' || token.type === 'document-start' || token.type === 'document-end' || token.type === 'stream-end') {
    p.state = popState(p);
    return processEmptyScalar(token.startMark);
  }
  return parseNode(p, true, false);
}

// Parse the productions:
// implicit_document    ::= block_node DOCUMENT-END*
//                                     *************
// explicit_document    ::= DIRECTIVE* DOCUMENT-START block_node? DOCUMENT-END*
// upstream: parserc.go yaml_parser_parse_document_end
function parseDocumentEnd(p: YamlParser): YamlEvent {
  const token = peekToken(p);
  const startMark = copyMark(token.startMark);
  let endMark = copyMark(token.startMark);
  let implicit = true;
  if (token.type === 'document-end') {
    endMark = copyMark(token.endMark);
    skipToken(p);
    implicit = false;
  }
  p.tagDirectives = [];
  p.state = 'document-start';
  return { type: 'document-end', start: startMark, end: endMark, implicit };
}

// Parse the productions:
// block_node_or_indentless_sequence    ::=
//                          ALIAS
//                          *****
//                          | properties (block_content | indentless_block_sequence)?
//                            **********  *
//                          | block_content | indentless_block_sequence
//                            *
// block_node           ::= ALIAS
//                          *****
//                          | properties block_content?
//                            ********** *
//                          | block_content
//                            *
// flow_node            ::= ALIAS
//                          *****
//                          | properties flow_content?
//                            ********** *
//                          | flow_content
//                            *
// properties           ::= TAG ANCHOR? | ANCHOR TAG?
//                          *************************
// block_content        ::= block_collection | flow_collection | SCALAR
//                                                               ******
// flow_content         ::= flow_collection | SCALAR
//                                            ******
// upstream: parserc.go yaml_parser_parse_node
function parseNode(p: YamlParser, block: boolean, indentlessSequence: boolean): YamlEvent {
  let token = peekToken(p);

  if (token.type === 'alias') {
    p.state = popState(p);
    const event: YamlEvent = { type: 'alias', start: copyMark(token.startMark), end: copyMark(token.endMark), anchor: token.value };
    skipToken(p);
    return event;
  }

  let startMark = copyMark(token.startMark);
  let endMark = copyMark(token.startMark);

  let tagToken = false;
  let tagHandle = '';
  let tagSuffix = '';
  let anchor = '';
  let tagMark: Mark = { index: 0, line: 0, column: 0 };
  if (token.type === 'anchor') {
    anchor = token.value;
    startMark = copyMark(token.startMark);
    endMark = copyMark(token.endMark);
    skipToken(p);
    token = peekToken(p);
    if (token.type === 'tag') {
      tagToken = true;
      tagHandle = token.value;
      tagSuffix = token.suffix;
      tagMark = copyMark(token.startMark);
      endMark = copyMark(token.endMark);
      skipToken(p);
      token = peekToken(p);
    }
  } else if (token.type === 'tag') {
    tagToken = true;
    tagHandle = token.value;
    tagSuffix = token.suffix;
    startMark = copyMark(token.startMark);
    tagMark = copyMark(token.startMark);
    endMark = copyMark(token.endMark);
    skipToken(p);
    token = peekToken(p);
    if (token.type === 'anchor') {
      anchor = token.value;
      endMark = copyMark(token.endMark);
      skipToken(p);
      token = peekToken(p);
    }
  }

  let tag = '';
  if (tagToken) {
    if (tagHandle === '') {
      tag = tagSuffix;
    } else {
      for (const d of p.tagDirectives) {
        if (d.handle === tagHandle) {
          tag = d.prefix + tagSuffix;
          break;
        }
      }
      if (tag === '') parserErrorContext('while parsing a node', startMark, 'found undefined tag handle', tagMark);
    }
  }

  const implicit = tag === '';
  if (indentlessSequence && token.type === 'block-entry') {
    endMark = copyMark(token.endMark);
    p.state = 'indentless-sequence-entry';
    return { type: 'sequence-start', start: startMark, end: endMark, anchor, tag, implicit, style: 'block' };
  }
  if (token.type === 'scalar') {
    let plainImplicit = false;
    let quotedImplicit = false;
    endMark = copyMark(token.endMark);
    if ((tag === '' && token.style === 'plain') || tag === '!') {
      plainImplicit = true;
    } else if (tag === '') {
      quotedImplicit = true;
    }
    p.state = popState(p);
    const event: YamlEvent = {
      type: 'scalar',
      start: startMark,
      end: endMark,
      anchor,
      tag,
      value: token.value,
      implicit: plainImplicit,
      quotedImplicit,
      style: token.style,
    };
    skipToken(p);
    return event;
  }
  if (token.type === 'flow-sequence-start') {
    // [Go] Some of the events below can be merged as they differ only on style.
    endMark = copyMark(token.endMark);
    p.state = 'flow-sequence-first-entry';
    return { type: 'sequence-start', start: startMark, end: endMark, anchor, tag, implicit, style: 'flow' };
  }
  if (token.type === 'flow-mapping-start') {
    endMark = copyMark(token.endMark);
    p.state = 'flow-mapping-first-key';
    return { type: 'mapping-start', start: startMark, end: endMark, anchor, tag, implicit, style: 'flow' };
  }
  if (block && token.type === 'block-sequence-start') {
    endMark = copyMark(token.endMark);
    p.state = 'block-sequence-first-entry';
    return { type: 'sequence-start', start: startMark, end: endMark, anchor, tag, implicit, style: 'block' };
  }
  if (block && token.type === 'block-mapping-start') {
    endMark = copyMark(token.endMark);
    p.state = 'block-mapping-first-key';
    return { type: 'mapping-start', start: startMark, end: endMark, anchor, tag, implicit, style: 'block' };
  }
  if (anchor !== '' || tag !== '') {
    p.state = popState(p);
    return { type: 'scalar', start: startMark, end: endMark, anchor, tag, value: '', implicit, quotedImplicit: false, style: 'plain' };
  }

  parserErrorContext(block ? 'while parsing a block node' : 'while parsing a flow node', startMark, 'did not find expected node content', token.startMark);
}

// Parse the productions:
// block_sequence ::= BLOCK-SEQUENCE-START (BLOCK-ENTRY block_node?)* BLOCK-END
//                    ********************  *********** *             *********
// upstream: parserc.go yaml_parser_parse_block_sequence_entry
function parseBlockSequenceEntry(p: YamlParser, first: boolean): YamlEvent {
  if (first) {
    const token = peekToken(p);
    p.marks.push(copyMark(token.startMark));
    skipToken(p);
  }

  let token = peekToken(p);

  if (token.type === 'block-entry') {
    const mark = copyMark(token.endMark);
    skipToken(p);
    token = peekToken(p);
    if (token.type !== 'block-entry' && token.type !== 'block-end') {
      p.states.push('block-sequence-entry');
      return parseNode(p, true, false);
    }
    p.state = 'block-sequence-entry';
    return processEmptyScalar(mark);
  }
  if (token.type === 'block-end') {
    p.state = popState(p);
    p.marks.pop();
    const event: YamlEvent = { type: 'sequence-end', start: copyMark(token.startMark), end: copyMark(token.endMark) };
    skipToken(p);
    return event;
  }

  const contextMark = p.marks.pop()!;
  parserErrorContext('while parsing a block collection', contextMark, "did not find expected '-' indicator", token.startMark);
}

// Parse the productions:
// indentless_sequence  ::= (BLOCK-ENTRY block_node?)+
//                           *********** *
// upstream: parserc.go yaml_parser_parse_indentless_sequence_entry
function parseIndentlessSequenceEntry(p: YamlParser): YamlEvent {
  let token = peekToken(p);

  if (token.type === 'block-entry') {
    const mark = copyMark(token.endMark);
    skipToken(p);
    token = peekToken(p);
    if (token.type !== 'block-entry' && token.type !== 'key' && token.type !== 'value' && token.type !== 'block-end') {
      p.states.push('indentless-sequence-entry');
      return parseNode(p, true, false);
    }
    p.state = 'indentless-sequence-entry';
    return processEmptyScalar(mark);
  }
  p.state = popState(p);
  // [Go] Shouldn't this be token.end_mark?
  return { type: 'sequence-end', start: copyMark(token.startMark), end: copyMark(token.startMark) };
}

// Parse the productions:
// block_mapping        ::= BLOCK-MAPPING_START
//                          *******************
//                          ((KEY block_node_or_indentless_sequence?)?
//                            *** *
//                          (VALUE block_node_or_indentless_sequence?)?)*
//
//                          BLOCK-END
//                          *********
// upstream: parserc.go yaml_parser_parse_block_mapping_key
function parseBlockMappingKey(p: YamlParser, first: boolean): YamlEvent {
  if (first) {
    const token = peekToken(p);
    p.marks.push(copyMark(token.startMark));
    skipToken(p);
  }

  let token = peekToken(p);

  if (token.type === 'key') {
    const mark = copyMark(token.endMark);
    skipToken(p);
    token = peekToken(p);
    if (token.type !== 'key' && token.type !== 'value' && token.type !== 'block-end') {
      p.states.push('block-mapping-value');
      return parseNode(p, true, true);
    }
    p.state = 'block-mapping-value';
    return processEmptyScalar(mark);
  } else if (token.type === 'block-end') {
    p.state = popState(p);
    p.marks.pop();
    const event: YamlEvent = { type: 'mapping-end', start: copyMark(token.startMark), end: copyMark(token.endMark) };
    skipToken(p);
    return event;
  }

  const contextMark = p.marks.pop()!;
  parserErrorContext('while parsing a block mapping', contextMark, 'did not find expected key', token.startMark);
}

// Parse the productions:
// block_mapping        ::= BLOCK-MAPPING_START
//
//                          ((KEY block_node_or_indentless_sequence?)?
//
//                          (VALUE block_node_or_indentless_sequence?)?)*
//                           ***** *
//                          BLOCK-END
// upstream: parserc.go yaml_parser_parse_block_mapping_value
function parseBlockMappingValue(p: YamlParser): YamlEvent {
  let token = peekToken(p);
  if (token.type === 'value') {
    const mark = copyMark(token.endMark);
    skipToken(p);
    token = peekToken(p);
    if (token.type !== 'key' && token.type !== 'value' && token.type !== 'block-end') {
      p.states.push('block-mapping-key');
      return parseNode(p, true, true);
    }
    p.state = 'block-mapping-key';
    return processEmptyScalar(mark);
  }
  p.state = 'block-mapping-key';
  return processEmptyScalar(token.startMark);
}

// Parse the productions:
// flow_sequence        ::= FLOW-SEQUENCE-START
//                          *******************
//                          (flow_sequence_entry FLOW-ENTRY)*
//                           *                   **********
//                          flow_sequence_entry?
//                          *
//                          FLOW-SEQUENCE-END
//                          *****************
// flow_sequence_entry  ::= flow_node | KEY flow_node? (VALUE flow_node?)?
//                          *
// upstream: parserc.go yaml_parser_parse_flow_sequence_entry
function parseFlowSequenceEntry(p: YamlParser, first: boolean): YamlEvent {
  if (first) {
    const token = peekToken(p);
    p.marks.push(copyMark(token.startMark));
    skipToken(p);
  }
  let token = peekToken(p);
  if (token.type !== 'flow-sequence-end') {
    if (!first) {
      if (token.type === 'flow-entry') {
        skipToken(p);
        token = peekToken(p);
      } else {
        const contextMark = p.marks.pop()!;
        parserErrorContext('while parsing a flow sequence', contextMark, "did not find expected ',' or ']'", token.startMark);
      }
    }

    if (token.type === 'key') {
      p.state = 'flow-sequence-entry-mapping-key';
      const event: YamlEvent = {
        type: 'mapping-start',
        start: copyMark(token.startMark),
        end: copyMark(token.endMark),
        anchor: '',
        tag: '',
        implicit: true,
        style: 'flow',
      };
      skipToken(p);
      return event;
    } else if (token.type !== 'flow-sequence-end') {
      p.states.push('flow-sequence-entry');
      return parseNode(p, false, false);
    }
  }

  p.state = popState(p);
  p.marks.pop();
  const event: YamlEvent = { type: 'sequence-end', start: copyMark(token.startMark), end: copyMark(token.endMark) };
  skipToken(p);
  return event;
}

// Parse the productions:
// flow_sequence_entry  ::= flow_node | KEY flow_node? (VALUE flow_node?)?
//                                      *** *
// upstream: parserc.go yaml_parser_parse_flow_sequence_entry_mapping_key
function parseFlowSequenceEntryMappingKey(p: YamlParser): YamlEvent {
  const token = peekToken(p);
  if (token.type !== 'value' && token.type !== 'flow-entry' && token.type !== 'flow-sequence-end') {
    p.states.push('flow-sequence-entry-mapping-value');
    return parseNode(p, false, false);
  }
  const mark = copyMark(token.endMark);
  skipToken(p);
  p.state = 'flow-sequence-entry-mapping-value';
  return processEmptyScalar(mark);
}

// Parse the productions:
// flow_sequence_entry  ::= flow_node | KEY flow_node? (VALUE flow_node?)?
//                                                      ***** *
// upstream: parserc.go yaml_parser_parse_flow_sequence_entry_mapping_value
function parseFlowSequenceEntryMappingValue(p: YamlParser): YamlEvent {
  // [Go] `token` is a pointer into parser.tokens. The inner peek below declares a new `token`, so
  // the empty scalar after it reads the outer slot, which a refill of the queue may have
  // overwritten in place (yaml_insert_token compacts the slice) or left behind (append grew it).
  const s = p.scanner;
  const token = peekToken(p);
  const slotArray = s.tokens.arr;
  const slot = s.tokensHead;
  if (token.type === 'value') {
    skipToken(p);
    const inner = peekToken(p);
    if (inner.type !== 'flow-entry' && inner.type !== 'flow-sequence-end') {
      p.states.push('flow-sequence-entry-mapping-end');
      return parseNode(p, false, false);
    }
  }
  p.state = 'flow-sequence-entry-mapping-end';
  return processEmptyScalar(slotArray[slot]!.startMark);
}

// Parse the productions:
// flow_sequence_entry  ::= flow_node | KEY flow_node? (VALUE flow_node?)?
//                                                                      *
// upstream: parserc.go yaml_parser_parse_flow_sequence_entry_mapping_end
function parseFlowSequenceEntryMappingEnd(p: YamlParser): YamlEvent {
  const token = peekToken(p);
  p.state = 'flow-sequence-entry';
  // [Go] Shouldn't this be end_mark?
  return { type: 'mapping-end', start: copyMark(token.startMark), end: copyMark(token.startMark) };
}

// Parse the productions:
// flow_mapping         ::= FLOW-MAPPING-START
//                          ******************
//                          (flow_mapping_entry FLOW-ENTRY)*
//                           *                  **********
//                          flow_mapping_entry?
//                          ******************
//                          FLOW-MAPPING-END
//                          ****************
// flow_mapping_entry   ::= flow_node | KEY flow_node? (VALUE flow_node?)?
//                          *           *** *
// upstream: parserc.go yaml_parser_parse_flow_mapping_key
function parseFlowMappingKey(p: YamlParser, first: boolean): YamlEvent {
  if (first) {
    const token = peekToken(p);
    p.marks.push(copyMark(token.startMark));
    skipToken(p);
  }

  let token = peekToken(p);

  if (token.type !== 'flow-mapping-end') {
    if (!first) {
      if (token.type === 'flow-entry') {
        skipToken(p);
        token = peekToken(p);
      } else {
        const contextMark = p.marks.pop()!;
        parserErrorContext('while parsing a flow mapping', contextMark, "did not find expected ',' or '}'", token.startMark);
      }
    }

    if (token.type === 'key') {
      skipToken(p);
      token = peekToken(p);
      if (token.type !== 'value' && token.type !== 'flow-entry' && token.type !== 'flow-mapping-end') {
        p.states.push('flow-mapping-value');
        return parseNode(p, false, false);
      }
      p.state = 'flow-mapping-value';
      return processEmptyScalar(token.startMark);
    } else if (token.type !== 'flow-mapping-end') {
      p.states.push('flow-mapping-empty-value');
      return parseNode(p, false, false);
    }
  }

  p.state = popState(p);
  p.marks.pop();
  const event: YamlEvent = { type: 'mapping-end', start: copyMark(token.startMark), end: copyMark(token.endMark) };
  skipToken(p);
  return event;
}

// Parse the productions:
// flow_mapping_entry   ::= flow_node | KEY flow_node? (VALUE flow_node?)?
//                                   *                  ***** *
// upstream: parserc.go yaml_parser_parse_flow_mapping_value
function parseFlowMappingValue(p: YamlParser, empty: boolean): YamlEvent {
  let token = peekToken(p);
  if (empty) {
    p.state = 'flow-mapping-key';
    return processEmptyScalar(token.startMark);
  }
  if (token.type === 'value') {
    skipToken(p);
    token = peekToken(p);
    if (token.type !== 'flow-entry' && token.type !== 'flow-mapping-end') {
      p.states.push('flow-mapping-key');
      return parseNode(p, false, false);
    }
  }
  p.state = 'flow-mapping-key';
  return processEmptyScalar(token.startMark);
}

// Generate an empty scalar event.
// upstream: parserc.go yaml_parser_process_empty_scalar
function processEmptyScalar(mark: Mark): YamlEvent {
  return { type: 'scalar', start: copyMark(mark), end: copyMark(mark), anchor: '', tag: '', value: '', implicit: true, quotedImplicit: false, style: 'plain' };
}

// upstream: parserc.go default_tag_directives
const DEFAULT_TAG_DIRECTIVES: readonly TagDirective[] = [
  { handle: '!', prefix: '!' },
  { handle: '!!', prefix: 'tag:yaml.org,2002:' },
];

// Parse directives. The version and tag directives are not part of the event here (decode.go
// does not read them), but their checks are.
// upstream: parserc.go yaml_parser_process_directives
function processDirectives(p: YamlParser): void {
  let versionDirective = false;
  let token = peekToken(p);

  while (token.type === 'version-directive' || token.type === 'tag-directive') {
    if (token.type === 'version-directive') {
      if (versionDirective) parserError('found duplicate %YAML directive', token.startMark);
      if (token.major !== 1 || token.minor !== 1) parserError('found incompatible YAML document', token.startMark);
      versionDirective = true;
    } else {
      appendTagDirective(p, { handle: token.value, prefix: token.prefix }, false, token.startMark);
    }
    skipToken(p);
    token = peekToken(p);
  }

  for (const d of DEFAULT_TAG_DIRECTIVES) appendTagDirective(p, d, true, token.startMark);
}

// upstream: parserc.go yaml_parser_append_tag_directive
function appendTagDirective(p: YamlParser, value: TagDirective, allowDuplicates: boolean, mark: Mark): void {
  for (const d of p.tagDirectives) {
    if (value.handle === d.handle) {
      if (allowDuplicates) return;
      parserError('found duplicate %TAG directive', mark);
    }
  }
  p.tagDirectives.push({ handle: value.handle, prefix: value.prefix });
}
