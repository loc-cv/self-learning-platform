import { describe, expect, test } from 'vitest';
import {
  defaultMetaV1FieldSelectorConversion,
  escapeValue,
  everythingFields,
  fieldRequiresExactMatch,
  fieldSelectorEmpty,
  fieldSelectorFromSet,
  fieldSelectorMatches,
  fieldSelectorString,
  fieldsString,
  nothingFields,
  parseFieldSelector,
  splitTerm,
  splitTerms,
  transformFieldSelector,
  unescapeValue,
  unsupportedFieldError,
  type FieldSelector,
  type FieldSelectorResult,
} from './fields.ts';

function ok(r: FieldSelectorResult): FieldSelector {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
}
const err = (s: string): string | undefined => {
  const r = parseFieldSelector(s);
  return 'error' in r ? r.error : undefined;
};

describe('splitting, upstream TestSplitTerms and TestSplitTerm', () => {
  test.each<[string, string[]]>([
    ['a', ['a']],
    ['a=avalue,b=bvalue', ['a=avalue', 'b=bvalue']],
    ['a=avalue,b==bvalue,c!=cvalue', ['a=avalue', 'b==bvalue', 'c!=cvalue']],
    ['', []],
    ['a=a,', ['a=a', '']],
    [',a=a', ['', 'a=a']],
    ['k=\\,,k2=v2', ['k=\\,', 'k2=v2']],
    ['k=\\\\,k2=v2', ['k=\\\\', 'k2=v2']],
    ['k=\\\\\\,,k2=v2', ['k=\\\\\\,', 'k2=v2']],
    ['k=\\a\\b\\', ['k=\\a\\b\\']],
    ['k=\\', ['k=\\']],
    ['함=수,목=록', ['함=수', '목=록']],
    // a backslash escapes a whole astral character, not half of it
    ['k=\\😀,j=1', ['k=\\😀', 'j=1']],
  ])('splitTerms(%j)', (s, want) => {
    expect(splitTerms(s)).toEqual(want);
  });

  test('splitTerm', () => {
    expect(splitTerm('a=value')).toEqual({ lhs: 'a', op: '=', rhs: 'value' });
    expect(splitTerm('b==value')).toEqual({ lhs: 'b', op: '==', rhs: 'value' });
    expect(splitTerm('c!=value')).toEqual({ lhs: 'c', op: '!=', rhs: 'value' });
    expect(splitTerm('')).toBeNull();
    expect(splitTerm('a')).toBeNull();
    expect(splitTerm('k=\\,')).toEqual({ lhs: 'k', op: '=', rhs: '\\,' });
    expect(splitTerm('k=\\\\\\a\\b\\=\\,\\')).toEqual({ lhs: 'k', op: '=', rhs: '\\\\\\a\\b\\=\\,\\' });
    expect(splitTerm('함=수')).toEqual({ lhs: '함', op: '=', rhs: '수' });
    // the key is not unescaped: the first operator wins even after a backslash
    expect(splitTerm('a\\=b=c')).toEqual({ lhs: 'a\\', op: '=', rhs: 'b=c' });
  });
});

describe('escaping, upstream TestEscapeValue', () => {
  test.each([
    ['', ''],
    ['a', 'a'],
    ['=', '\\='],
    [',', '\\,'],
    ['\\', '\\\\'],
    ['\\=\\,\\', '\\\\\\=\\\\\\,\\\\'],
  ])('%j <-> %j', (raw, escaped) => {
    expect(escapeValue(raw)).toBe(escaped);
    expect(unescapeValue(escaped)).toEqual({ value: raw });
  });

  test('invalid escapes and unescaped characters', () => {
    expect(unescapeValue('\\')).toEqual({ error: 'invalid field selector: invalid escape sequence: \\' });
    expect(unescapeValue('\\\\\\')).toEqual({ error: 'invalid field selector: invalid escape sequence: \\' });
    expect(unescapeValue('\\a')).toEqual({ error: 'invalid field selector: invalid escape sequence: \\a' });
    // %v of a rune prints its number
    expect(unescapeValue('a=b')).toEqual({ error: 'invalid field selector: unescaped character in value: 61' });
    expect(unescapeValue('a,b')).toEqual({ error: 'invalid field selector: unescaped character in value: 44' });
  });
});

describe('parseFieldSelector', () => {
  test('upstream TestSelectorParse good strings restring unchanged', () => {
    for (const s of ['x=a,y=b,z=c', '', 'x!=a,y=b', 'x=a||y\\=b', 'x=a\\=\\=b']) {
      expect(fieldSelectorString(ok(parseFieldSelector(s)))).toBe(s);
    }
  });

  test('errors', () => {
    // fixtures/golden/v1.37.2/api/crud.yaml
    expect(err('metadata.name')).toBe("invalid selector: 'metadata.name'; can't understand 'metadata.name'");
    // upstream TestSelectorParse bad strings
    expect(err('x=a||y=b')).toBe('invalid field selector: unescaped character in value: 61');
    expect(err('x==a==b')).toBe('invalid field selector: unescaped character in value: 61');
    expect(err('x=a,b')).toBe("invalid selector: 'x=a,b'; can't understand 'b'");
    expect(err('x in (a)')).toBe("invalid selector: 'x in (a)'; can't understand 'x in (a)'");
    expect(err('x in (a,b,c)')).toBe("invalid selector: 'x in (a,b,c)'; can't understand 'b'");
    expect(err('x')).toBe("invalid selector: 'x'; can't understand 'x'");
    expect(err('k=\\q')).toBe('invalid field selector: invalid escape sequence: \\q');
  });

  test('terms are sorted as raw strings; == is =; empty terms are skipped', () => {
    expect(fieldSelectorString(ok(parseFieldSelector('x=a,a=x')))).toBe('a=x,x=a');
    expect(fieldSelectorString(ok(parseFieldSelector('metadata.name!=cm3,metadata.namespace=default')))).toBe('metadata.name!=cm3,metadata.namespace=default');
    expect(fieldSelectorString(ok(parseFieldSelector('b==1,,a!=2,')))).toBe('a!=2,b=1');
    // the term `=` has an empty field and value: Transform turns it into Everything
    expect(fieldSelectorEmpty(ok(parseFieldSelector('=')))).toBe(true);
    expect(ok(parseFieldSelector('=x')).terms).toEqual([{ field: '', operator: '=', value: 'x' }]);
    expect(ok(parseFieldSelector('k=a\\,b')).terms).toEqual([{ field: 'k', operator: '=', value: 'a,b' }]);
  });

  test('matching; a missing field reads as ""', () => {
    const m = (s: string, f: Record<string, string>): boolean => fieldSelectorMatches(ok(parseFieldSelector(s)), f);
    expect(m('', { x: 'y' })).toBe(true);
    expect(m('x=y', { x: 'y' })).toBe(true);
    expect(m('x=y,z=w', { x: 'y', z: 'w' })).toBe(true);
    expect(m('x!=y,z!=w', { x: 'z', z: 'a' })).toBe(true);
    expect(m('x=z', {})).toBe(false);
    expect(m('x=', {})).toBe(true);
    expect(m('x!=', {})).toBe(false);
    expect(m('x=y,z=w', { x: 'w', z: 'w' })).toBe(false);
    expect(m('constructor=', {})).toBe(true);
    expect(fieldSelectorMatches(nothingFields(), {})).toBe(false);
  });

  test('RequiresExactMatch', () => {
    const s = ok(parseFieldSelector('a!=1,b=2,spec.nodeName=n1'));
    expect(fieldRequiresExactMatch(s, 'spec.nodeName')).toEqual({ value: 'n1' });
    expect(fieldRequiresExactMatch(s, 'a')).toBeNull();
    expect(fieldRequiresExactMatch(everythingFields(), 'a')).toBeNull();
  });

  test('Transform, upstream TestTransform', () => {
    const id = (field: string, value: string): { field: string; value: string } => ({ field, value });
    expect(fieldSelectorString(ok(parseFieldSelector('a=b,c=d', id)))).toBe('a=b,c=d');
    expect(fieldSelectorString(ok(parseFieldSelector('a=b,c=d', (f, v) => (f === 'a' ? { field: 'e', value: 'f' } : { field: f, value: v }))))).toBe('e=f,c=d');
    expect(fieldSelectorEmpty(ok(parseFieldSelector('a=b', () => ({ field: '', value: '' }))))).toBe(true);
    expect(fieldSelectorString(ok(parseFieldSelector('a=b,c=d,e=f', (f, v) => (f === 'c' ? { field: '', value: '' } : { field: f, value: v }))))).toBe('a=b,e=f');
  });

  test('the default conversion and unsupported-label errors (crud.yaml data.k)', () => {
    const sel = ok(parseFieldSelector('data.k=v'));
    expect(transformFieldSelector(sel, defaultMetaV1FieldSelectorConversion)).toEqual({ error: '"data.k" is not a known field selector: only "metadata.name", "metadata.namespace"' });
    expect(transformFieldSelector(ok(parseFieldSelector('metadata.name=x')), defaultMetaV1FieldSelectorConversion)).toEqual({ terms: [{ field: 'metadata.name', operator: '=', value: 'x' }] });
    expect(unsupportedFieldError(null, 'status.replicas')).toBe('"status.replicas" is not a known field selector: only "metadata.name", "metadata.namespace"');
    expect(unsupportedFieldError('Node', 'metadata.namespace')).toBe('field label not supported: metadata.namespace');
    expect(unsupportedFieldError('Job', 'spec.x')).toBe('field label "spec.x" not supported for Job');
    expect(transformFieldSelector(nothingFields(), defaultMetaV1FieldSelectorConversion)).toEqual(nothingFields());
  });

  test('sets', () => {
    expect(fieldSelectorString(fieldSelectorFromSet({ b: '1', a: 'x,y' }))).toBe('a=x\\,y,b=1');
    expect(fieldSelectorEmpty(fieldSelectorFromSet(null))).toBe(true);
    expect(fieldsString({ a: '1', 'a.b': '2' })).toBe('a.b=2,a=1');
  });

  test('selectors are plain data', () => {
    const s = ok(parseFieldSelector('a=1,b!=2'));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
