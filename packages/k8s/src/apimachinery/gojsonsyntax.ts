// The errors of Go's json.Unmarshal(data, &map[string]interface{}{}) for raw bytes held in an API
// object (Secret .dockercfg and .dockerconfigjson contents).
// upstream: Go src/encoding/json/scanner.go (checkValid and its state machine, quoteChar; the v1
// encoder, not GOEXPERIMENT=jsonv2), decode.go (UnmarshalTypeError for a top-level value that
// is not an object). Checked against the v1.37.2 oracle: `{"a":1` gives "unexpected end of JSON
// input", `[1]` "json: cannot unmarshal array into Go value of type map[string]interface {}",
// `{"a":tru}` "invalid character '}' in literal true (expecting 'e')".

import { goQuote } from './field.ts';

type Step = (c: number) => 'continue' | 'error' | 'end';

/** quoteChar: a byte as a Go rune literal. */
function quoteChar(c: number): string {
  if (c === 0x27) return `'\\''`;
  if (c === 0x22) return `'"'`;
  // strconv.Quote(string(rune(c))): U+00A0 and U+00AD are not printable in Go either.
  const q = c === 0xa0 || c === 0xad ? `"\\u00${c.toString(16)}"` : goQuote(String.fromCharCode(c));
  return `'${q.slice(1, -1)}'`;
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHex = (c: number): boolean => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
const ch = (s: string): number => s.charCodeAt(0);

const PARSE_OBJECT_KEY = 0;
const PARSE_OBJECT_VALUE = 1;
const PARSE_ARRAY_VALUE = 2;

/** The UTF-8 bytes of a string (a lone surrogate as U+FFFD, as a Go string would hold it). */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/** The syntax error of checkValid, or undefined when the bytes are valid JSON. */
export function goJsonSyntaxError(data: string): string | undefined {
  const r = goJsonScan(data);
  return r?.error;
}

/**
 * checkValid's scan with the position: a syntax error and its offset (the bytes read, the
 * offending one included, as SyntaxError.Offset counts them), or undefined when the input is one
 * valid value. `eof` marks an input that ends inside the value: checkValid's eof() then reports
 * "unexpected end of JSON input", or the error of the space it steps (`{"a":tru` gives "invalid
 * character ' ' in literal true (expecting 'e')"); a json.Decoder reports io.ErrUnexpectedEOF.
 */
export function goJsonScan(data: string): { error: string; offset: number; eof?: true } | undefined {
  const parse: number[] = [];
  let err: string | undefined;
  let endTop = false;
  let step: Step;

  const error = (c: number, context: string): 'error' => {
    step = () => 'error';
    err = `invalid character ${quoteChar(c)} ${context}`;
    return 'error';
  };
  const pop = (): void => {
    parse.pop();
    if (parse.length === 0) {
      step = stateEndTop;
      endTop = true;
    } else {
      step = stateEndValue;
    }
  };
  const literal = (expect: string, what: string, next: Step): Step => {
    // A chain of single-character states: stateT, stateTr, stateTru and the like.
    const states: Step[] = [];
    for (let i = expect.length - 1; i >= 0; i--) {
      const want = expect.charCodeAt(i);
      const after = i === expect.length - 1 ? next : (states[0] as Step);
      states.unshift((c) => {
        if (c === want) {
          step = after;
          return 'continue';
        }
        return error(c, `in literal ${what} (expecting '${expect[i] as string}')`);
      });
    }
    return states[0] as Step;
  };

  const stateBeginValueOrEmpty: Step = (c) => {
    if (isSpace(c)) return 'continue';
    if (c === ch(']')) return stateEndValue(c);
    return stateBeginValue(c);
  };
  const stateBeginValue: Step = (c) => {
    if (isSpace(c)) return 'continue';
    switch (c) {
      case ch('{'):
        step = stateBeginStringOrEmpty;
        parse.push(PARSE_OBJECT_KEY);
        return 'continue';
      case ch('['):
        step = stateBeginValueOrEmpty;
        parse.push(PARSE_ARRAY_VALUE);
        return 'continue';
      case ch('"'):
        step = stateInString;
        return 'continue';
      case ch('-'):
        step = stateNeg;
        return 'continue';
      case ch('0'):
        step = state0;
        return 'continue';
      case ch('t'):
        step = literal('rue', 'true', stateEndValue);
        return 'continue';
      case ch('f'):
        step = literal('alse', 'false', stateEndValue);
        return 'continue';
      case ch('n'):
        step = literal('ull', 'null', stateEndValue);
        return 'continue';
    }
    if (c >= ch('1') && c <= ch('9')) {
      step = state1;
      return 'continue';
    }
    return error(c, 'looking for beginning of value');
  };
  const stateBeginStringOrEmpty: Step = (c) => {
    if (isSpace(c)) return 'continue';
    if (c === ch('}')) {
      parse[parse.length - 1] = PARSE_OBJECT_VALUE;
      return stateEndValue(c);
    }
    return stateBeginString(c);
  };
  const stateBeginString: Step = (c) => {
    if (isSpace(c)) return 'continue';
    if (c === ch('"')) {
      step = stateInString;
      return 'continue';
    }
    return error(c, 'looking for beginning of object key string');
  };
  const stateEndValue: Step = (c) => {
    const n = parse.length;
    if (n === 0) {
      step = stateEndTop;
      endTop = true;
      return stateEndTop(c);
    }
    if (isSpace(c)) {
      step = stateEndValue;
      return 'continue';
    }
    switch (parse[n - 1]) {
      case PARSE_OBJECT_KEY:
        if (c === ch(':')) {
          parse[n - 1] = PARSE_OBJECT_VALUE;
          step = stateBeginValue;
          return 'continue';
        }
        return error(c, 'after object key');
      case PARSE_OBJECT_VALUE:
        if (c === ch(',')) {
          parse[n - 1] = PARSE_OBJECT_KEY;
          step = stateBeginString;
          return 'continue';
        }
        if (c === ch('}')) {
          pop();
          return 'continue';
        }
        return error(c, 'after object key:value pair');
      default:
        if (c === ch(',')) {
          step = stateBeginValue;
          return 'continue';
        }
        if (c === ch(']')) {
          pop();
          return 'continue';
        }
        return error(c, 'after array element');
    }
  };
  // Records the error but answers scanEnd, as upstream does: the next byte (or eof) reports it.
  const stateEndTop: Step = (c) => {
    if (!isSpace(c)) error(c, 'after top-level value');
    return 'end';
  };
  const stateInString: Step = (c) => {
    if (c === ch('"')) {
      step = stateEndValue;
      return 'continue';
    }
    if (c === ch('\\')) {
      step = stateInStringEsc;
      return 'continue';
    }
    if (c < 0x20) return error(c, 'in string literal');
    return 'continue';
  };
  const stateInStringEsc: Step = (c) => {
    if ('bfnrt\\/"'.includes(String.fromCharCode(c))) {
      step = stateInString;
      return 'continue';
    }
    if (c === ch('u')) {
      step = hexDigit(3);
      return 'continue';
    }
    return error(c, 'in string escape code');
  };
  const hexDigit = (left: number): Step => (c) => {
    if (isHex(c)) {
      step = left === 0 ? stateInString : hexDigit(left - 1);
      return 'continue';
    }
    return error(c, 'in \\u hexadecimal character escape');
  };
  const stateNeg: Step = (c) => {
    if (c === ch('0')) {
      step = state0;
      return 'continue';
    }
    if (c >= ch('1') && c <= ch('9')) {
      step = state1;
      return 'continue';
    }
    return error(c, 'in numeric literal');
  };
  const state1: Step = (c) => {
    if (isDigit(c)) {
      step = state1;
      return 'continue';
    }
    return state0(c);
  };
  const state0: Step = (c) => {
    if (c === ch('.')) {
      step = stateDot;
      return 'continue';
    }
    if (c === ch('e') || c === ch('E')) {
      step = stateE;
      return 'continue';
    }
    return stateEndValue(c);
  };
  const stateDot: Step = (c) => {
    if (isDigit(c)) {
      step = stateDot0;
      return 'continue';
    }
    return error(c, 'after decimal point in numeric literal');
  };
  const stateDot0: Step = (c) => {
    if (isDigit(c)) return 'continue';
    if (c === ch('e') || c === ch('E')) {
      step = stateE;
      return 'continue';
    }
    return stateEndValue(c);
  };
  const stateE: Step = (c) => {
    if (c === ch('+') || c === ch('-')) {
      step = stateESign;
      return 'continue';
    }
    return stateESign(c);
  };
  const stateESign: Step = (c) => {
    if (isDigit(c)) {
      step = stateE0;
      return 'continue';
    }
    return error(c, 'in exponent of numeric literal');
  };
  const stateE0: Step = (c) => {
    if (isDigit(c)) return 'continue';
    return stateEndValue(c);
  };

  step = stateBeginValue;
  // The scanner reads bytes: a non-ASCII character is its UTF-8 bytes (an error names the first).
  const bytes = utf8Bytes(data);
  for (let i = 0; i < bytes.length; i++) {
    // stateEndTop records its error and still returns 'end'.
    if (step(bytes[i] as number) === 'error' || err !== undefined) return { error: err as string, offset: i + 1 };
  }
  // eof()
  if (endTop) return undefined;
  step(0x20);
  if (endTop) return undefined;
  return { error: err ?? 'unexpected end of JSON input', offset: bytes.length, eof: true };
}

/** The error of json.Unmarshal(data, &map[string]interface{}{}), or undefined. */
export function unmarshalMapError(data: string): string | undefined {
  const syntax = goJsonSyntaxError(data);
  if (syntax !== undefined) return syntax;
  const first = data.replace(/^[ \t\r\n]+/, '')[0];
  const kind =
    first === '{' || first === 'n' ? undefined : first === '[' ? 'array' : first === '"' ? 'string' : first === 't' || first === 'f' ? 'bool' : 'number';
  return kind === undefined ? undefined : `json: cannot unmarshal ${kind} into Go value of type map[string]interface {}`;
}
