// Expectations from the vendored go.yaml.in/yaml/v2, sigs.k8s.io/yaml and apimachinery
// util/yaml run in a Go harness (Go 1.27 with GOEXPERIMENT=nojsonv2, as kubectl v1.37.2's Go 1.26
// encoding/json), and from Go's strconv; the golden fixtures are compared in
// tools/src/golden/yaml.test.ts.

import { describe, expect, test } from 'vitest';
import { unmarshalYaml, yamlToJson } from './decode.ts';
import { marshalYaml, YamlMarshalError, yamlKeyLess } from './encode.ts';
import { formatFloatG, goSyntax } from './gofmt.ts';
import { marshalIndentJson, printJson } from './jsonprint.ts';
import { isTimestamp, resolve } from './resolve.ts';
import { decodeManifestStream, splitYamlDocuments } from './stream.ts';

describe('marshalYaml', () => {
  test('block style, sequences unindented under a key, {} and [] for empty, no folding without spaces', () => {
    expect(marshalYaml({ a: { b: [1, { c: [] }], d: {} }, e: [[1, 2], []], f: 'x'.repeat(130) })).toBe(
      `a:\n  b:\n  - 1\n  - c: []\n  d: {}\ne:\n- - 1\n  - 2\n- []\nf: ${'x'.repeat(130)}\n`,
    );
  });

  test('a key over 128 bytes or with a line break is a complex key', () => {
    expect(marshalYaml({ ['k'.repeat(129)]: 1, 'multi\nkey': 2 })).toBe(`? ${'k'.repeat(129)}\n: 1\n? |-\n  multi\n  key\n: 2\n`);
  });

  test('line separators, a leading BOM, block indentation and keep hints', () => {
    expect(marshalYaml({ s: 'a\u2028b', t: '\ufeffab', u: ' lead\nx', v: 'x\n\n' })).toBe(
      "s: 'a\u2028  b'\nt: \"\\uFEFF\\x61\\x62\"\nu: |2-\n   lead\n  x\nv: |+\n  x\n\n",
    );
  });

  test('floats through JSON text and yaml.v2 FormatFloat', () => {
    expect(marshalYaml({ f: [0.5, 1e-7, 1234567.5, 1e21, 100000.5] })).toBe('f:\n- 0.5\n- 1e-07\n- 1.2345675e+06\n- 1e+21\n- 100000.5\n');
  });

  test('scalars and empty sequences at the root', () => {
    expect(marshalYaml('plain')).toBe('plain\n');
    expect(marshalYaml([])).toBe('[]\n');
  });

  test('a key over 1024 characters fails in the JSON-to-YAML parse', () => {
    expect(() => marshalYaml({ ['a'.repeat(1100)]: 1 })).toThrow(new YamlMarshalError("yaml: did not find expected ',' or '}'"));
  });

  test('natural key order: letters after other runes, digit runs by value', () => {
    const keys = ['a10', 'a9', 'a1', 'A', '_x', '1', '10', '9', 'b1c10', 'b1c2'];
    expect([...keys].sort((x, y) => (yamlKeyLess(x, y) ? -1 : yamlKeyLess(y, x) ? 1 : 0))).toEqual(['_x', '1', '9', '10', 'A', 'a1', 'a9', 'a10', 'b1c2', 'b1c10']);
  });
});

describe('resolution', () => {
  test('YAML 1.1 words, Go integer syntax, floats', () => {
    expect(resolve('', 'yes').value).toEqual({ k: 'bool', v: true });
    expect(resolve('', 'oN').value).toEqual({ k: 'string', v: 'oN' });
    expect(resolve('', '0x1F').value).toEqual({ k: 'int', v: 31n });
    expect(resolve('', '012').value).toEqual({ k: 'int', v: 10n });
    expect(resolve('', '08').value).toEqual({ k: 'float', v: 8 });
    expect(resolve('', '1_000').value).toEqual({ k: 'int', v: 1000n });
    expect(resolve('', '18446744073709551615').value).toEqual({ k: 'uint', v: 18446744073709551615n });
    expect(resolve('', '1e400').value).toEqual({ k: 'string', v: '1e400' });
    expect(resolve('', '.5_0').value).toEqual({ k: 'float', v: 0.5 });
    expect(() => resolve('tag:yaml.org,2002:int', 'abc')).toThrow('cannot decode !!str `abc` as a !!int');
  });

  test('timestamps as time.Parse takes them', () => {
    for (const s of ['2024-01-01', '2024-1-2', '2024-01-01T10:00:00Z', '2024-01-01t10:00:00+02:00', '2024-01-01  10:00:00', '2024-01-01T10:00:00,5Z', '2024-02-29']) {
      expect(isTimestamp(s), s).toBe(true);
    }
    for (const s of ['2024-13-01', '2024-02-30', '2023-02-29', '20240-01-01', '2024-01-01T10:00:00', '2024-01-01T24:00:00Z']) {
      expect(isTimestamp(s), s).toBe(false);
    }
  });
});

describe('Go formatting', () => {
  test("FormatFloat 'g' -1 for 64 and 32 bits", () => {
    expect(formatFloatG(1234567.5)).toBe('1.2345675e+06');
    expect(formatFloatG(0.0001)).toBe('0.0001');
    expect(formatFloatG(0.00001)).toBe('1e-05');
    expect(formatFloatG(3.14159265358979, 32)).toBe('3.1415927');
    expect(formatFloatG(1000000.5, 32)).toBe('1.0000005e+06');
  });

  test('%#v of decoded values', () => {
    expect(goSyntax({ k: 'seq', items: [{ k: 'int', v: 1n }, { k: 'nil' }, { k: 'map', entries: [{ key: { k: 'string', v: 'a' }, value: { k: 'float', v: 1.5 } }] }] })).toBe(
      '[]interface {}{1, interface {}(nil), map[interface {}]interface {}{"a":1.5}}',
    );
    expect(goSyntax({ k: 'uint', v: 18446744073709551615n })).toBe('0xffffffffffffffff');
    expect(goSyntax({ k: 'nil' })).toBe('<nil>');
  });
});

describe('yamlToJson and unmarshalYaml', () => {
  test('errors carry the yaml: prefix, and Unmarshal adds its own', () => {
    expect(yamlToJson('a: 1\n  b: 2')).toEqual({ ok: false, error: 'yaml: line 2: mapping values are not allowed in this context' });
    expect(unmarshalYaml('a: 1\n  b: 2')).toEqual({ ok: false, error: 'error converting YAML to JSON: yaml: line 2: mapping values are not allowed in this context' });
  });

  test('binary data: base64 decoded, invalid UTF-8 written as U+FFFD', () => {
    expect(yamlToJson('a: !!binary "////"')).toEqual({ ok: true, value: { a: '\ufffd\ufffd\ufffd' } });
    expect(yamlToJson('a: !!binary "!!"')).toEqual({ ok: false, error: 'yaml: !!binary value contains invalid base64 data' });
  });

  test('keys of different types that become one JSON key are unsupported (Go map order decides)', () => {
    expect(yamlToJson('{1: a, 1.0: b}')).toEqual({ ok: false, unsupported: 'two mapping keys that both convert to the JSON key "1"' });
  });

  test('merge keys overwrite what came before them, later keys overwrite the merge', () => {
    expect(yamlToJson('base: &b {a: 1, b: 2}\nm:\n  b: 3\n  <<: *b\n  c: 4\n')).toEqual({ ok: true, value: { base: { a: 1, b: 2 }, m: { a: 1, b: 2, c: 4 } } });
  });

  test('only the first document of a chunk counts; an empty input is null', () => {
    expect(yamlToJson('a: 1\n---\nb: [')).toEqual({ ok: true, value: { a: 1 } });
    expect(yamlToJson('')).toEqual({ ok: true, value: null });
  });
});

describe('decodeManifestStream', () => {
  test('YAML documents: separators, empty documents, ... ends a document within its chunk', () => {
    expect(decodeManifestStream('---\na: 1\n---\n\n---\nb: 2\n...\nc: 3\n')).toEqual({ docs: [{ a: 1 }, null, { b: 2 }] });
    expect(splitYamlDocuments('a: 1\n--- # c\nb: 2')).toEqual({ docs: ['a: 1\n', 'b: 2\n'] });
    expect(splitYamlDocuments('a: 1\n---x\nb: 2')).toEqual({ docs: [], error: 'invalid Yaml document separator: x' });
  });

  test('a JSON stream: an unambiguous one keeps its error, one object falls back to YAML', () => {
    expect(decodeManifestStream('{"a": 1}\n{"b": 2}\n{"c": 3')).toEqual({ docs: [{ a: 1 }, { b: 2 }], error: 'unexpected EOF' });
    expect(decodeManifestStream('{"a": 1}\nb: 2\n')).toEqual({ docs: [{ a: 1 }, { b: 2 }] });
    expect(decodeManifestStream('{"a" 1}')).toEqual({ docs: [], error: "json: offset 6: invalid character '1' after object key" });
  });
});

describe('JSON printer', () => {
  test('indent, HTML escapes, sorted keys for unstructured objects', () => {
    expect(printJson({ b: '<&>', a: [], c: {}, d: [1, 'x\u2028'] }, { sortKeys: true })).toBe(
      '{\n    "a": [],\n    "b": "\\u003c\\u0026\\u003e",\n    "c": {},\n    "d": [\n        1,\n        "x\\u2028"\n    ]\n}\n',
    );
  });

  test('struct order is kept; an object with integer-like keys is a map and sorted as Go sorts it', () => {
    expect(marshalIndentJson({ kind: 'ConfigMap', data: { '9': 'x', '10': 'y', a: 'z' } }, '', '  ')).toBe('{\n  "kind": "ConfigMap",\n  "data": {\n    "10": "y",\n    "9": "x",\n    "a": "z"\n  }\n}');
  });

  test('the prefix starts every line but the first', () => {
    expect(marshalIndentJson({ a: 1 }, '>', '\t')).toBe('{\n>\t"a": 1\n>}');
  });
});
