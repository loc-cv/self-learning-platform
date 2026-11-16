// The port of plaintext.tmpl and its functions, on small documents. The outputs over the served
// documents are compared with the real binary's by the golden cases (fixtures/golden/cases/explain).

import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { openApiV3Document } from '../../../openapi/v3.ts';
import { jsonPathParse } from './fieldpath.ts';
import { extractEnum, goValue, indent, renderPlaintext, resolveRef, truth, typeGuess, wrap } from './template.ts';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A document with one namespaced kind `Widget` in `example.com/v1`. */
function doc(schemas: JsonObject): JsonObject {
  return {
    paths: {
      '/apis/example.com/v1/namespaces/{namespace}/widgets': { get: { 'x-kubernetes-group-version-kind': { group: 'example.com', kind: 'Widget', version: 'v1' } } },
    },
    components: { schemas },
  };
}

const gvr = { group: 'example.com', version: 'v1', resource: 'widgets' };
const render = (d: JsonObject, fieldPath: string[] = [], recursive = false, maxDepth = 0) => renderPlaintext({ document: d, gvr, fieldPath, recursive, maxDepth });

const widget = {
  description: 'A widget.',
  type: 'object',
  required: ['size'],
  properties: {
    size: { description: 'How big.', type: 'integer' },
    labels: { description: 'Labels.', type: 'object', additionalProperties: { type: 'string', default: '' } },
    parts: { description: 'Parts.', type: 'array', items: { allOf: [ref('Part')], default: {} } },
    mode: { description: 'Mode.', type: 'string', enum: ['', 'A', 'B', 'C', 'D'] },
  },
  'x-kubernetes-group-version-kind': [{ group: 'example.com', kind: 'Widget', version: 'v1' }],
};
const part = { description: 'A part.', type: 'object', properties: { name: { type: 'string' }, sub: { allOf: [ref('Part')] } } };

describe('text/template semantics', () => {
  it('truth follows isTrue: empty strings, maps, slices, zero and nil are false', () => {
    expect([truth(''), truth({}), truth([]), truth(0), truth(null), truth(undefined), truth(false)]).toEqual([false, false, false, false, false, false, false]);
    expect([truth('x'), truth({ a: 1 }), truth([0]), truth(-1), truth(true)]).toEqual([true, true, true, true, true]);
  });

  it('indent pads every line, the empty last one too', () => {
    expect(indent(4, 'a\nb\n')).toBe('    a\n    b\n    ');
    expect(indent(2, '')).toBe('  ');
  });

  it('wrap breaks at spaces within the limit and never inside a word', () => {
    expect(wrap(10, 'aaaa bbbb cccc')).toBe('aaaa bbbb\ncccc');
    expect(wrap(4, 'abcdefgh ij')).toBe('abcdefgh\nij');
    expect(wrap(0, 'aaaa bbbb cccc')).toBe('aaaa bbbb cccc');
  });

  it('prints maps as fmt does: keys sorted, map[k:v]', () => {
    expect(goValue({ version: 'v1', group: '', kind: 'Pod' })).toBe('map[group: kind:Pod version:v1]');
  });

  it('resolves fragment-only references, nothing else', () => {
    const d = doc({ Part: part });
    expect(resolveRef('#/components/schemas/Part', d)).toBe(part);
    expect(resolveRef('#/components/schemas/Missing', d)).toBeUndefined();
    expect(resolveRef('other.json#/x', d)).toBeUndefined();
    expect(resolveRef('', d)).toBeUndefined();
    expect(resolveRef(undefined, d)).toBeUndefined();
  });
});

describe('typeGuess', () => {
  const d = doc({ Part: part, IntOrString: { description: 'x', format: 'int-or-string' }, Quantity: { type: 'string' } });
  it('names arrays, maps, refs and primitive refs', () => {
    expect(typeGuess({ type: 'array', items: { allOf: [ref('Part')] } }, d)).toBe('[]Part');
    expect(typeGuess({ type: 'object', additionalProperties: { type: 'string' } }, d)).toBe('map[string]string');
    expect(typeGuess({ type: 'object', additionalProperties: true }, d)).toBe('Object');
    expect(typeGuess({ allOf: [ref('IntOrString')] }, d)).toBe('IntOrString');
    expect(typeGuess({ allOf: [ref('Quantity')] }, d)).toBe('string');
    expect(typeGuess({ type: 'object' }, d)).toBe('Object');
    expect(typeGuess({ description: 'no type' }, d)).toBe('Object');
    expect(typeGuess(ref('Missing'), d)).toBe('Missing');
  });
  it('fails on an empty schema, as the template does', () => {
    expect(() => typeGuess({}, d)).toThrow("expected schema argument to subtemplate 'typeguess'");
  });
});

describe('extractEnum', () => {
  const s = { enum: ['', 'A', 'B', 'C', 'D'] };
  it('short view: four values, then ", ...."; "" for the empty string', () => {
    expect(extractEnum(s, false, 4, 2)).toBe('\n  enum: "", A, B, C, ....');
  });
  it('long view: every value on its own line', () => {
    expect(extractEnum(s, true, -1)).toBe('ENUM:\n    ""\n    A\n    B\n    C\n    D');
  });
  it('nothing without an enum', () => {
    expect(extractEnum({ type: 'string' }, true, -1)).toBe('');
  });
});

describe('renderPlaintext', () => {
  const d = doc({ Part: part, Widget: widget });

  it('a resource: header, description, sorted fields with types, required and enums', () => {
    expect(render(d).text).toBe(
      [
        'GROUP:      example.com',
        'KIND:       Widget',
        'VERSION:    v1',
        '',
        'DESCRIPTION:',
        '    A widget.',
        '    ',
        'FIELDS:',
        '  labels\t<map[string]string>',
        '    Labels.',
        '',
        '  mode\t<string>',
        '  enum: "", A, B, C, ....',
        '    Mode.',
        '',
        '  parts\t<[]Part>',
        '    Parts.',
        '',
        '  size\t<integer> -required-',
        '    How big.',
        '',
        '',
        '',
      ].join('\n'),
    );
  });

  it('a field through an array: FIELD line, the field and the item descriptions, <no description>', () => {
    const r = render(d, ['parts']);
    expect(r.text).toContain('FIELD: parts <[]Part>\n\n\nDESCRIPTION:\n    Parts.\n    A part.\n    \nFIELDS:\n  name\t<string>\n    <no description>\n');
  });

  it('--recursive stops at a reference already on the path', () => {
    const r = render(d, ['parts'], true);
    expect(r.text).toContain('FIELDS:\n  name\t<string>\n  sub\t<Part>\n\n');
  });

  it('--max-depth caps the levels', () => {
    const r = render(doc({ Part: part, Widget: { ...widget, properties: { p: { allOf: [ref('Part')] } } } }), [], true, 1);
    expect(r.text).toContain('FIELDS:\n  p\t<Part>\n\n');
  });

  it('an unknown field: the header is written, the error names the last path element', () => {
    const r = render(d, ['size', 'x', 'y']);
    expect(r.text).toBe('GROUP:      example.com\nKIND:       Widget\nVERSION:    v1\n\n');
    expect(r.error?.message).toBe('error: field "y" does not exist');
  });

  it('a resource the document has no path for', () => {
    const r = renderPlaintext({ document: d, gvr: { group: '', version: 'v1', resource: 'widgets' }, fieldPath: [], recursive: false, maxDepth: 0 });
    expect(r.text).toBe('');
    expect(r.error?.message).toBe('error: GVR (/v1, Resource=widgets) not found in OpenAPI schema');
  });

  it('a GVK no schema has', () => {
    const r = render(doc({ Part: part }));
    expect(r.error?.message).toBe('error: GVK map[group:example.com kind:Widget version:v1] not found in OpenAPI schema');
  });

  it('renders the served apps/v1 document', () => {
    const apps = openApiV3Document('apis/apps/v1') as JsonObject;
    const r = renderPlaintext({ document: apps, gvr: { group: 'apps', version: 'v1', resource: 'deployments' }, fieldPath: ['spec', 'strategy'], recursive: true, maxDepth: 0 });
    expect(r.text).toContain('FIELD: strategy <DeploymentStrategy>');
    expect(r.text).toContain('  rollingUpdate\t<RollingUpdateDeployment>\n    maxSurge\t<IntOrString>\n');
  });
});

describe('jsonPathParse', () => {
  it('fields, one trailing dot trimmed, escapes', () => {
    expect(jsonPathParse('pods.spec.')).toEqual({ nodes: [{ type: 'field', value: 'pods' }, { type: 'field', value: 'spec' }] });
    expect(jsonPathParse('a\\.b.c')).toEqual({ nodes: [{ type: 'field', value: 'a.b' }, { type: 'field', value: 'c' }] });
    expect(jsonPathParse('a..')).toEqual({ nodes: [{ type: 'field', value: 'a' }, { type: 'field', value: '' }] });
  });
  it('recursive descent and wildcards are nodes of their own', () => {
    expect(jsonPathParse('.pods')).toEqual({ nodes: [{ type: 'recursive' }, { type: 'field', value: 'pods' }] });
    expect(jsonPathParse('a.*')).toEqual({ nodes: [{ type: 'field', value: 'a' }, { type: 'wildcard' }] });
    expect(jsonPathParse('a....b')).toEqual({ error: 'invalid multiple recursive descent' });
  });
  it('other syntax is not parsed', () => {
    expect(jsonPathParse('a[0]')).toBeNull();
    expect(jsonPathParse('a b')).toBeNull();
    expect(jsonPathParse('a\\')).toBeNull();
  });
});
