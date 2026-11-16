// Event streams and errors of the yaml.v2 parser port. Every expectation below is the output of
// go.yaml.in/yaml/v2 v2.4.4 itself (yaml_parser_parse driven like decode.go, dumped as JSON), so
// these rows are regression cases of the differential test against the Go code.
import { describe, expect, test } from 'vitest';
import type { Mark, YamlEvent } from './events.ts';
import { YamlSyntaxError } from './events.ts';
import { newParser, nextEvent } from './parser.ts';

const mark = (m: Mark): string => `${m.index}@${m.line}:${m.column}`;

/** One event as `type [&anchor] [<tag>] [style "value" flags] start-end`. */
function show(e: YamlEvent): string {
  let s: string = e.type;
  if ('anchor' in e && e.anchor) s += ' &' + e.anchor;
  if ('tag' in e && e.tag) s += ' <' + e.tag + '>';
  if (e.type === 'scalar') {
    s += ` ${e.style} ${JSON.stringify(e.value)}${e.implicit ? ' plain-implicit' : ''}${e.quotedImplicit ? ' quoted-implicit' : ''}`;
  } else if (e.type === 'sequence-start' || e.type === 'mapping-start') {
    s += ' ' + e.style + (e.implicit ? '' : ' explicit-tag');
  } else if (e.type === 'document-end' && !e.implicit) {
    s += ' explicit';
  }
  return s + ' ' + mark(e.start) + '-' + mark(e.end);
}

/** Pulls events until STREAM-END or an error, as yaml.v2's decoder would. */
function run(input: string): { events: YamlEvent[]; error: YamlSyntaxError | null } {
  const p = newParser(input);
  const events: YamlEvent[] = [];
  try {
    for (;;) {
      const e = nextEvent(p);
      events.push(e);
      if (e.type === 'stream-end') return { events, error: null };
    }
  } catch (e) {
    if (e instanceof YamlSyntaxError) return { events, error: e };
    throw e;
  }
}

function showError(e: YamlSyntaxError): string {
  return `${e.kind}: ${e.problem} at ${mark(e.problemMark)}` + (e.context ? `, ${e.context} at ${mark(e.contextMark)}` : '');
}

describe('event streams', () => {
  test.each<[string, string[]]>([
    ["a: b\nc: [d, {e: f}]\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "scalar plain \"b\" plain-implicit 3@0:3-4@0:4",
      "scalar plain \"c\" plain-implicit 5@1:0-6@1:1",
      "sequence-start flow 8@1:3-9@1:4",
      "scalar plain \"d\" plain-implicit 9@1:4-10@1:5",
      "mapping-start flow 12@1:7-13@1:8",
      "scalar plain \"e\" plain-implicit 13@1:8-14@1:9",
      "scalar plain \"f\" plain-implicit 16@1:11-17@1:12",
      "mapping-end 17@1:12-18@1:13",
      "sequence-end 18@1:13-19@1:14",
      "mapping-end 20@2:0-20@2:0",
      "document-end 20@2:0-20@2:0",
      "stream-end 20@2:0-20@2:0",
    ]],
    ["- a\n- - b\n  - c\n-\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "sequence-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 2@0:2-3@0:3",
      "sequence-start block 6@1:2-6@1:2",
      "scalar plain \"b\" plain-implicit 8@1:4-9@1:5",
      "scalar plain \"c\" plain-implicit 14@2:4-15@2:5",
      "sequence-end 16@3:0-16@3:0",
      "scalar plain \"\" plain-implicit 17@3:1-17@3:1",
      "sequence-end 18@4:0-18@4:0",
      "document-end 18@4:0-18@4:0",
      "stream-end 18@4:0-18@4:0",
    ]],
    ["key:\n- a\n- b\nnext: x\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"key\" plain-implicit 0@0:0-3@0:3",
      "sequence-start block 5@1:0-6@1:1",
      "scalar plain \"a\" plain-implicit 7@1:2-8@1:3",
      "scalar plain \"b\" plain-implicit 11@2:2-12@2:3",
      "sequence-end 13@3:0-13@3:0",
      "scalar plain \"next\" plain-implicit 13@3:0-17@3:4",
      "scalar plain \"x\" plain-implicit 19@3:6-20@3:7",
      "mapping-end 21@4:0-21@4:0",
      "document-end 21@4:0-21@4:0",
      "stream-end 21@4:0-21@4:0",
    ]],
    ["? [a, b]\n: {c: d}\n? x\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "sequence-start flow 2@0:2-3@0:3",
      "scalar plain \"a\" plain-implicit 3@0:3-4@0:4",
      "scalar plain \"b\" plain-implicit 6@0:6-7@0:7",
      "sequence-end 7@0:7-8@0:8",
      "mapping-start flow 11@1:2-12@1:3",
      "scalar plain \"c\" plain-implicit 12@1:3-13@1:4",
      "scalar plain \"d\" plain-implicit 15@1:6-16@1:7",
      "mapping-end 16@1:7-17@1:8",
      "scalar plain \"x\" plain-implicit 20@2:2-21@2:3",
      "scalar plain \"\" plain-implicit 22@3:0-22@3:0",
      "mapping-end 22@3:0-22@3:0",
      "document-end 22@3:0-22@3:0",
      "stream-end 22@3:0-22@3:0",
    ]],
    ["base: &b {a: 1}\nref: *b\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"base\" plain-implicit 0@0:0-4@0:4",
      "mapping-start &b flow 6@0:6-10@0:10",
      "scalar plain \"a\" plain-implicit 10@0:10-11@0:11",
      "scalar plain \"1\" plain-implicit 13@0:13-14@0:14",
      "mapping-end 14@0:14-15@0:15",
      "scalar plain \"ref\" plain-implicit 16@1:0-19@1:3",
      "alias &b 21@1:5-23@1:7",
      "mapping-end 24@2:0-24@2:0",
      "document-end 24@2:0-24@2:0",
      "stream-end 24@2:0-24@2:0",
    ]],
    ["- !!str 1\n- !local x\n- !<tag:x,2000:y> z\n- ! w\n- !!map {}\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "sequence-start block 0@0:0-0@0:0",
      "scalar <tag:yaml.org,2002:str> plain \"1\" 2@0:2-9@0:9",
      "scalar <!local> plain \"x\" 12@1:2-20@1:10",
      "scalar <tag:x,2000:y> plain \"z\" 23@2:2-40@2:19",
      "scalar <!> plain \"w\" plain-implicit 43@3:2-46@3:5",
      "mapping-start <tag:yaml.org,2002:map> flow explicit-tag 49@4:2-56@4:9",
      "mapping-end 56@4:9-57@4:10",
      "sequence-end 58@5:0-58@5:0",
      "document-end 58@5:0-58@5:0",
      "stream-end 58@5:0-58@5:0",
    ]],
    ["%YAML 1.1\n%TAG !e! tag:example.com,2000:\n--- !e!foo bar\n...\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-44@2:3",
      "scalar <tag:example.com,2000:foo> plain \"bar\" 45@2:4-55@2:14",
      "document-end explicit 56@3:0-59@3:3",
      "stream-end 60@4:0-60@4:0",
    ]],
    ["- !%E2%82%AC x\n- !e%41 y\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "sequence-start block 0@0:0-0@0:0",
      "scalar <!\u20ac> plain \"x\" 2@0:2-14@0:14",
      "scalar <!eA> plain \"y\" 17@1:2-24@1:9",
      "sequence-end 25@2:0-25@2:0",
      "document-end 25@2:0-25@2:0",
      "stream-end 25@2:0-25@2:0",
    ]],
    ["lit: |\n  a\n   b\n\n  c\nfold: >\n  a\n  b\n\n  c\n   d\nkeep: |+\n  x\n\nstrip: >-\n  y\n\nind: |2\n   z\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"lit\" plain-implicit 0@0:0-3@0:3",
      "scalar literal \"a\\n b\\n\\nc\\n\" quoted-implicit 5@0:5-21@5:0",
      "scalar plain \"fold\" plain-implicit 21@5:0-25@5:4",
      "scalar folded \"a b\\nc\\n d\\n\" quoted-implicit 27@5:6-47@11:0",
      "scalar plain \"keep\" plain-implicit 47@11:0-51@11:4",
      "scalar literal \"x\\n\\n\" quoted-implicit 53@11:6-61@14:0",
      "scalar plain \"strip\" plain-implicit 61@14:0-66@14:5",
      "scalar folded \"y\" quoted-implicit 68@14:7-76@17:0",
      "scalar plain \"ind\" plain-implicit 76@17:0-79@17:3",
      "scalar literal \" z\\n\" quoted-implicit 81@17:5-89@19:0",
      "mapping-end 89@19:0-89@19:0",
      "document-end 89@19:0-89@19:0",
      "stream-end 89@19:0-89@19:0",
    ]],
    ["s: 'it''s\n  folded\n\n  here'\nd: \"\\x41\\u00e9\\U0001F600\\t\\\\\\\"\\0\\N\\_\\L\\P\"\nc: \"a\\\n  b\"\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"s\" plain-implicit 0@0:0-1@0:1",
      "scalar single-quoted \"it's folded\\nhere\" quoted-implicit 3@0:3-27@3:7",
      "scalar plain \"d\" plain-implicit 28@4:0-29@4:1",
      "scalar double-quoted \"A\u00e9\u{1f600}\\t\\\\\\\"\\u0000\u0085\u00a0\u2028\u2029\" quoted-implicit 31@4:3-69@4:41",
      "scalar plain \"c\" plain-implicit 70@5:0-71@5:1",
      "scalar double-quoted \"ab\" quoted-implicit 73@5:3-81@6:4",
      "mapping-end 82@7:0-82@7:0",
      "document-end 82@7:0-82@7:0",
      "stream-end 82@7:0-82@7:0",
    ]],
    ["p: this is\n  a multi line\n\n  plain scalar\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"p\" plain-implicit 0@0:0-1@0:1",
      "scalar plain \"this is a multi line\\nplain scalar\" plain-implicit 3@0:3-41@3:14",
      "mapping-end 42@4:0-42@4:0",
      "document-end 42@4:0-42@4:0",
      "stream-end 42@4:0-42@4:0",
    ]],
    ["[a: ]\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-1@0:1",
      "sequence-start flow 0@0:0-1@0:1",
      "mapping-start flow 1@0:1-1@0:1",
      "scalar plain \"a\" plain-implicit 1@0:1-2@0:2",
      "scalar plain \"\" plain-implicit 2@0:2-2@0:2",
      "mapping-end 4@0:4-4@0:4",
      "sequence-end 4@0:4-5@0:5",
      "document-end 6@1:0-6@1:0",
      "stream-end 6@1:0-6@1:0",
    ]],
    ["[a, b: c, ? d : e, f:]\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-1@0:1",
      "sequence-start flow 0@0:0-1@0:1",
      "scalar plain \"a\" plain-implicit 1@0:1-2@0:2",
      "mapping-start flow 4@0:4-4@0:4",
      "scalar plain \"b\" plain-implicit 4@0:4-5@0:5",
      "scalar plain \"c\" plain-implicit 7@0:7-8@0:8",
      "mapping-end 8@0:8-8@0:8",
      "mapping-start flow 10@0:10-11@0:11",
      "scalar plain \"d\" plain-implicit 12@0:12-13@0:13",
      "scalar plain \"e\" plain-implicit 16@0:16-17@0:17",
      "mapping-end 17@0:17-17@0:17",
      "scalar plain \"f:\" plain-implicit 19@0:19-21@0:21",
      "sequence-end 21@0:21-22@0:22",
      "document-end 23@1:0-23@1:0",
      "stream-end 23@1:0-23@1:0",
    ]],
    ["{a: 1, b, ? c, d: }\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-1@0:1",
      "mapping-start flow 0@0:0-1@0:1",
      "scalar plain \"a\" plain-implicit 1@0:1-2@0:2",
      "scalar plain \"1\" plain-implicit 4@0:4-5@0:5",
      "scalar plain \"b\" plain-implicit 7@0:7-8@0:8",
      "scalar plain \"\" plain-implicit 8@0:8-8@0:8",
      "scalar plain \"c\" plain-implicit 12@0:12-13@0:13",
      "scalar plain \"\" plain-implicit 13@0:13-13@0:13",
      "scalar plain \"d\" plain-implicit 15@0:15-16@0:16",
      "scalar plain \"\" plain-implicit 18@0:18-18@0:18",
      "mapping-end 18@0:18-19@0:19",
      "document-end 20@1:0-20@1:0",
      "stream-end 20@1:0-20@1:0",
    ]],
    ["x: [a,\n\tb]\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"x\" plain-implicit 0@0:0-1@0:1",
      "sequence-start flow 3@0:3-4@0:4",
      "scalar plain \"a\" plain-implicit 4@0:4-5@0:5",
      "scalar plain \"b\" plain-implicit 8@1:1-9@1:2",
      "sequence-end 9@1:2-10@1:3",
      "mapping-end 11@2:0-11@2:0",
      "document-end 11@2:0-11@2:0",
      "stream-end 11@2:0-11@2:0",
    ]],
    ["--- a\n--- |\n  b\n...\n--- >-\n  c\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-3@0:3",
      "scalar plain \"a\" plain-implicit 4@0:4-5@0:5",
      "document-end 6@1:0-6@1:0",
      "document-start 6@1:0-9@1:3",
      "scalar literal \"b\\n\" quoted-implicit 10@1:4-16@3:0",
      "document-end explicit 16@3:0-19@3:3",
      "document-start 20@4:0-23@4:3",
      "scalar folded \"c\" quoted-implicit 24@4:4-31@6:0",
      "document-end 31@6:0-31@6:0",
      "stream-end 31@6:0-31@6:0",
    ]],
    ["", [
      "stream-start 0@0:0-0@0:0",
      "stream-end 1@1:0-1@1:0",
    ]],
    ["# only a comment\n", [
      "stream-start 0@0:0-0@0:0",
      "stream-end 17@1:0-17@1:0",
    ]],
    ["\ufeffa: b\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "scalar plain \"b\" plain-implicit 3@0:3-4@0:4",
      "mapping-end 5@1:0-5@1:0",
      "document-end 5@1:0-5@1:0",
      "stream-end 5@1:0-5@1:0",
    ]],
    ["a: b\r\nc: d\r\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "scalar plain \"b\" plain-implicit 3@0:3-4@0:4",
      "scalar plain \"c\" plain-implicit 6@1:0-7@1:1",
      "scalar plain \"d\" plain-implicit 9@1:3-10@1:4",
      "mapping-end 12@2:0-12@2:0",
      "document-end 12@2:0-12@2:0",
      "stream-end 12@2:0-12@2:0",
    ]],
    ["a: b\u0085c: \u00e9\u{1f600}\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "scalar plain \"b\" plain-implicit 3@0:3-4@0:4",
      "scalar plain \"c\" plain-implicit 5@1:0-6@1:1",
      "scalar plain \"\u00e9\u{1f600}\" plain-implicit 8@1:3-10@1:5",
      "mapping-end 11@2:0-11@2:0",
      "document-end 11@2:0-11@2:0",
      "stream-end 11@2:0-11@2:0",
    ]],
    ["a: \"x\u2028y\"\nb: 'p\u2029q'\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "scalar double-quoted \"x\u2028y\" quoted-implicit 3@0:3-8@1:2",
      "scalar plain \"b\" plain-implicit 9@2:0-10@2:1",
      "scalar single-quoted \"p\u2029q\" quoted-implicit 12@2:3-17@3:2",
      "mapping-end 18@4:0-18@4:0",
      "document-end 18@4:0-18@4:0",
      "stream-end 18@4:0-18@4:0",
    ]],
    ["a:\n  -\n  - b\nc:\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "sequence-start block 5@1:2-5@1:2",
      "scalar plain \"\" plain-implicit 6@1:3-6@1:3",
      "scalar plain \"b\" plain-implicit 11@2:4-12@2:5",
      "sequence-end 13@3:0-13@3:0",
      "scalar plain \"c\" plain-implicit 13@3:0-14@3:1",
      "scalar plain \"\" plain-implicit 15@3:2-15@3:2",
      "mapping-end 16@4:0-16@4:0",
      "document-end 16@4:0-16@4:0",
      "stream-end 16@4:0-16@4:0",
    ]],
    ["&a !t\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-2@0:2",
      "scalar &a <!t> plain \"\" 0@0:0-5@0:5",
      "document-end 6@1:0-6@1:0",
      "stream-end 6@1:0-6@1:0",
    ]],
    ["a: b # c\n# d\n", [
      "stream-start 0@0:0-0@0:0",
      "document-start 0@0:0-0@0:0",
      "mapping-start block 0@0:0-0@0:0",
      "scalar plain \"a\" plain-implicit 0@0:0-1@0:1",
      "scalar plain \"b\" plain-implicit 3@0:3-4@0:4",
      "mapping-end 13@2:0-13@2:0",
      "document-end 13@2:0-13@2:0",
      "stream-end 13@2:0-13@2:0",
    ]],
  ])('%j', (input, expected) => {
    const { events, error } = run(input);
    expect(error).toBeNull();
    expect(events.map(show)).toEqual(expected);
  });

  test('document-start is never implicit in yaml.v2, explicit or not', () => {
    const { events } = run('a\n--- b\n');
    expect(events.filter((e) => e.type === 'document-start').map((e) => e.type === 'document-start' && e.implicit)).toEqual([false, false]);
  });

  test('after stream-end the stream-end event comes again', () => {
    const p = newParser('a');
    const types: string[] = [];
    for (let i = 0; i < 7; i++) types.push(nextEvent(p).type);
    expect(types).toEqual(['stream-start', 'document-start', 'scalar', 'document-end', 'stream-end', 'stream-end', 'stream-end']);
  });

  test('a surrogate pair is one character for marks', () => {
    const { events } = run('a: \u{1F600}x\n');
    const value = events.find((e) => e.type === 'scalar' && e.value !== 'a');
    expect(value && show(value)).toBe('scalar plain "\u{1F600}x" plain-implicit 3@0:3-5@0:5');
  });
});

describe('errors: problem, context and marks as libyaml sets them', () => {
  // [input, events delivered before the error, error]
  test.each<[string, number, string]>([
    ["a: \u0001\n", 0, "reader: control characters are not allowed at 0@0:0"],
    ["a: b\u007f", 0, "reader: control characters are not allowed at 0@0:0"],
    ["\ufeffa: \u0000", 0, "reader: control characters are not allowed at 0@0:0"],
    ['a: b\n'.repeat(120) + '---\n\u0001\n', 207, "reader: control characters are not allowed at 0@0:0"],
    ["a: b\n\t\n", 4, "scanner: found a tab character that violates indentation at 5@1:0, while scanning a plain scalar at 3@0:3"],
    ["a:\n\tb: c\n", 4, "scanner: found character that cannot start any token at 3@1:0, while scanning for the next token at 3@1:0"],
    ["a: |\n\tb\n", 4, "scanner: found a tab character where an indentation space is expected at 5@1:0, while scanning a block scalar at 3@0:3"],
    ["a: @b\n", 4, "scanner: found character that cannot start any token at 3@0:3, while scanning for the next token at 3@0:3"],
    ["a: `b\n", 4, "scanner: found character that cannot start any token at 3@0:3, while scanning for the next token at 3@0:3"],
    ["%FOO bar\n", 1, "scanner: found unknown directive name at 4@0:4, while scanning a directive at 0@0:0"],
    ["%\n", 1, "scanner: could not find expected directive name at 1@0:1, while scanning a directive at 0@0:0"],
    ["%YAML\n", 1, "scanner: did not find expected version number at 5@0:5, while scanning a %YAML directive at 0@0:0"],
    ["%YAML 1\n", 1, "scanner: did not find expected digit or '.' character at 7@0:7, while scanning a %YAML directive at 0@0:0"],
    ["%YAML 123.1\n", 1, "scanner: found extremely long version number at 8@0:8, while scanning a %YAML directive at 0@0:0"],
    ["%YAML 1.1 x\n", 1, "scanner: did not find expected comment or line break at 10@0:10, while scanning a directive at 0@0:0"],
    ["%TAG !a b\n", 1, "scanner: did not find expected '!' at 7@0:7, while parsing a %TAG directive at 0@0:0"],
    ["%TAG ! \n", 1, "scanner: did not find expected tag URI at 7@0:7, while parsing a %TAG directive at 0@0:0"],
    ["%TAG !x!y z\n", 1, "scanner: did not find expected whitespace at 8@0:8, while scanning a %TAG directive at 0@0:0"],
    ["!<x y\n", 1, "scanner: did not find the expected '>' at 3@0:3, while scanning a tag at 0@0:0"],
    ["!<> x\n", 1, "scanner: did not find expected tag URI at 2@0:2, while parsing a tag at 0@0:0"],
    ["!a!\n", 1, "scanner: did not find expected tag URI at 3@0:3, while parsing a tag at 0@0:0"],
    ["!%ZZ x\n", 1, "scanner: did not find URI escaped octet at 1@0:1, while parsing a tag at 0@0:0"],
    ["!%80 x\n", 1, "scanner: found an incorrect leading UTF-8 octet at 1@0:1, while parsing a tag at 0@0:0"],
    ["!%E2%28%AC x\n", 1, "scanner: found an incorrect trailing UTF-8 octet at 4@0:4, while parsing a tag at 0@0:0"],
    ["&: x\n", 1, "scanner: did not find expected alphabetic or numeric character at 1@0:1, while scanning an anchor at 0@0:0"],
    ["*\n", 1, "scanner: did not find expected alphabetic or numeric character at 1@0:1, while scanning an alias at 0@0:0"],
    ["&a@ b\n", 1, "scanner: found character that cannot start any token at 2@0:2, while scanning for the next token at 2@0:2"],
    ["a: 'x\n", 4, "scanner: found unexpected end of stream at 6@1:0, while scanning a quoted scalar at 3@0:3"],
    ["a: \"x\n", 4, "scanner: found unexpected end of stream at 6@1:0, while scanning a quoted scalar at 3@0:3"],
    ["a: \"\\z\"\n", 4, "scanner: found unknown escape character at 4@0:4, while parsing a quoted scalar at 3@0:3"],
    ["a: \"\\xZZ\"\n", 4, "scanner: did not find expected hexdecimal number at 6@0:6, while parsing a quoted scalar at 3@0:3"],
    ["a: \"\\uD800\"\n", 4, "scanner: found invalid Unicode character escape code at 6@0:6, while parsing a quoted scalar at 3@0:3"],
    ["'a\n---\n'", 1, "scanner: found unexpected document indicator at 3@1:0, while scanning a quoted scalar at 0@0:0"],
    ["a: |0\n", 4, "scanner: found an indentation indicator equal to 0 at 4@0:4, while scanning a block scalar at 3@0:3"],
    ["a: |x\n", 4, "scanner: did not find expected comment or line break at 4@0:4, while scanning a block scalar at 3@0:3"],
    ["a: >-0\n", 4, "scanner: found an indentation indicator equal to 0 at 5@0:5, while scanning a block scalar at 3@0:3"],
    ["a: - b\n", 4, "scanner: block sequence entries are not allowed in this context at 3@0:3"],
    ["a: b: c\n", 5, "scanner: mapping values are not allowed in this context at 4@0:4"],
    ["a: b\n- c\n", 5, "parser: did not find expected key at 5@1:0, while parsing a block mapping at 0@0:0"],
    ["a:\n  b: c\n d: e\n", 8, "parser: did not find expected key at 11@2:1, while parsing a block mapping at 0@0:0"],
    ["a\nb: c\n", 3, "scanner: mapping values are not allowed in this context at 3@1:1"],
    ['x'.repeat(1030) + ': y\n', 3, "scanner: mapping values are not allowed in this context at 1030@0:1030"],
    ['['.repeat(10001), 8978, "scanner: exceeded max depth of 10000 at 10000@0:10000, while increasing flow level at 10000@0:10000"],
    ["a:\n  b\n\t c\n", 4, "scanner: found a tab character that violates indentation at 7@2:0, while scanning a plain scalar at 5@1:2"],
    ["- a\nb: c\n", 4, "parser: did not find expected '-' indicator at 4@1:0, while parsing a block collection at 0@0:0"],
    ["a:\n  - b\n c: d\n", 7, "parser: did not find expected key at 10@2:1, while parsing a block mapping at 0@0:0"],
    ["[a, b\n", 5, "parser: did not find expected ',' or ']' at 6@1:0, while parsing a flow sequence at 0@0:0"],
    ["{a: b\n", 5, "parser: did not find expected ',' or '}' at 6@1:0, while parsing a flow mapping at 0@0:0"],
    ["]\n", 2, "parser: did not find expected node content at 0@0:0, while parsing a block node at 0@0:0"],
    ["}\n", 2, "parser: did not find expected node content at 0@0:0, while parsing a block node at 0@0:0"],
    [",\n", 2, "parser: did not find expected node content at 0@0:0, while parsing a block node at 0@0:0"],
    ["a: ,\n", 4, "parser: did not find expected node content at 3@0:3, while parsing a block node at 3@0:3"],
    ["%YAML 1.1\n%YAML 1.1\n---\n", 1, "parser: found duplicate %YAML directive at 10@1:0"],
    ["%YAML 1.2\n---\n", 1, "parser: found incompatible YAML document at 0@0:0"],
    ["%TAG ! x\n%TAG ! y\n---\n", 1, "parser: found duplicate %TAG directive at 9@1:0"],
    ["%YAML 1.1\na\n", 1, "parser: did not find expected <document start> at 10@1:0"],
    ["!u!x y\n", 2, "parser: found undefined tag handle at 0@0:0, while parsing a node at 0@0:0"],
    ["- &a\n- !t\n-\n- ]\n", 6, "parser: did not find expected node content at 14@3:2, while parsing a block node at 14@3:2"],
    ["a: b\n---\n]\n", 8, "parser: did not find expected node content at 9@2:0, while parsing a block node at 9@2:0"],
    ["\ufeff\ufeffa: b\nc: d\n", 5, "parser: did not find expected key at 7@1:1, while parsing a block mapping at 1@0:1"],
    ['k'.repeat(1025) + ': v\n', 3, "scanner: mapping values are not allowed in this context at 1025@0:1025"],
    ['[' + 'k'.repeat(1030) + ': v]\n', 4, "parser: did not find expected ',' or ']' at 1031@0:1031, while parsing a flow sequence at 0@0:0"],
    ['- '.repeat(10001) + 'x\n', 10002, "scanner: exceeded max depth of 10000 at 20000@0:20000, while increasing indent level at 0@0:0"],
    ["[a, b: c, : f]\n", 8, "parser: did not find expected node content at 10@0:10, while parsing a flow node at 10@0:10"],
    ["x:\n\t\n  y\n", 4, "scanner: found character that cannot start any token at 3@1:0, while scanning for the next token at 3@1:0"],
  ])('%j', (input, before, expected) => {
    const { events, error } = run(input);
    expect(error && showError(error)).toBe(expected);
    expect(events.length).toBe(before);
  });

  test('the error is thrown again on the next call', () => {
    const p = newParser('a: b: c\n');
    for (let i = 0; i < 5; i++) nextEvent(p);
    expect(() => nextEvent(p)).toThrow('mapping values are not allowed in this context');
    expect(() => nextEvent(p)).toThrow('mapping values are not allowed in this context');
  });

  test('a lone surrogate is an invalid Unicode character for the reader', () => {
    expect(run('a: \ud800\n').error?.problem).toBe('invalid Unicode character');
  });
});
