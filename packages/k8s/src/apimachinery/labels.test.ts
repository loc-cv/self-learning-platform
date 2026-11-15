import { describe, expect, test } from 'vitest';
import { newPath } from './field.ts';
import {
  compareGoStrings,
  everything,
  formatLabels,
  formatLabelSelector,
  labelSelectorAsMap,
  labelSelectorAsSelector,
  labelsString,
  newRequirement,
  nothing,
  parseInt64,
  parseSelector,
  requiresExactMatch,
  selectorAdd,
  selectorEmpty,
  selectorFromSet,
  selectorMatches,
  selectorString,
  validatedSelectorFromSet,
  type Requirement,
  type Selector,
  type SelectorResult,
} from './labels.ts';
import { isQualifiedName, isValidLabelValue } from './validation/names.ts';

function ok(r: SelectorResult): Selector {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
}
const err = (s: string): string | undefined => {
  const r = parseSelector(s);
  return 'error' in r ? r.error : undefined;
};
const req = (r: Requirement | { error: string }): Requirement => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('parseSelector errors, as the API server returns them', () => {
  // fixtures/golden/v1.37.2/api/crud.yaml and errors/not-found.yaml
  test.each([
    ['app===one', "unable to parse requirement: found '=', expected: identifier"],
    ['app notin two', "unable to parse requirement: found 'two' expected: '('"],
    ['Bad Key=x', "unable to parse requirement: found 'Key', expected: in, notin, =, ==, !=, gt, lt"],
    ['app in (a,b', "unable to parse requirement: found '', expected: ',' or ')'"],
  ])('golden: %s', (s, msg) => {
    expect(err(s)).toBe(msg);
  });

  // oracle runs recorded in the phase 05a research note §6.1
  test.each([
    ['a b', "unable to parse requirement: found 'b', expected: in, notin, =, ==, !=, gt, lt"],
    ['a=b,', "found '', expected: identifier after ','"],
    ['=b', "found '=', expected: !, identifier, or 'end of string'"],
    ['k>x', `unable to parse requirement: values[0]: Invalid value: "x": for 'Gt', 'Lt' operators, the value must be an integer`],
  ])('oracle: %s', (s, msg) => {
    expect(err(s)).toBe(msg);
  });

  test('a bad key is a field.Error on a nil path', () => {
    expect(err('-a')).toBe(`unable to parse requirement: <nil>: Invalid value: "-a": ${isQualifiedName('-a').join('; ')}`);
    expect(err('-a')).toMatch(/^unable to parse requirement: <nil>: Invalid value: "-a": name part must consist of/);
    // several IsLabelKey messages are joined with "; "
    const long = `${'a'.repeat(64)}-`;
    expect(isQualifiedName(long).length).toBe(2);
    expect(err(long)).toBe(`unable to parse requirement: <nil>: Invalid value: "${long}": ${isQualifiedName(long).join('; ')}`);
  });

  test('a bad value is reported at values[i][key]', () => {
    expect(err('k=v@l')).toBe(`unable to parse requirement: values[0][k]: Invalid value: "v@l": ${isValidLabelValue('v@l').join('; ')}`);
    // values are sorted before validation, so the index is the sorted position
    expect(err('k in (b@,a)')).toBe(`unable to parse requirement: values[1][k]: Invalid value: "b@": ${isValidLabelValue('b@').join('; ')}`);
    // a requirement with a Gt value that is neither an integer nor a label value gets both, aggregated
    expect(err('k>-x')).toBe(
      `unable to parse requirement: [values[0]: Invalid value: "-x": for 'Gt', 'Lt' operators, the value must be an integer, values[0][k]: Invalid value: "-x": ${isValidLabelValue('-x').join('; ')}]`,
    );
  });

  test('a path given with the option prefixes requirement errors and replaces <nil>', () => {
    const r = parseSelector('k=v@l', newPath('spec', 'selector'));
    expect('error' in r && r.error).toBe(`unable to parse requirement: spec.selector.values[0][k]: Invalid value: "v@l": ${isValidLabelValue('v@l').join('; ')}`);
    const k = parseSelector('-a', newPath('spec'));
    expect('error' in k && k.error).toMatch(/^unable to parse requirement: spec: Invalid value: "-a": /);
  });

  test('the other parser messages', () => {
    expect(err('x=a||y=b')).toBe(`unable to parse requirement: values[0][x]: Invalid value: "a||y": ${isValidLabelValue('a||y').join('; ')}`);
    expect(err('x==a==b')).toBe("found '==', expected: ',' or 'end of string'");
    expect(err('!x=a')).toBe("found '=', expected: ',' or 'end of string'");
    expect(err('x<a')).toBe(`unable to parse requirement: values[0]: Invalid value: "a": for 'Gt', 'Lt' operators, the value must be an integer`);
    expect(err('x in a')).toBe("unable to parse requirement: found 'a' expected: '('");
    expect(err('x in (=)')).toBe("unable to parse requirement: found '=', expected: ',', ')' or identifier");
    expect(err('x in (a b)')).toBe("unable to parse requirement: found 'b', expected: ',' or ')'");
    expect(err('x in (a,')).toBe("unable to parse requirement: found '', expected: ',', or identifier");
    expect(err('x in (a,=)')).toBe("unable to parse requirement: found '=', expected: ',', or identifier");
    expect(err('!')).toBe("unable to parse requirement: found '', expected: identifier");
    expect(err('!=a')).toBe("found '!=', expected: !, identifier, or 'end of string'");
    expect(err('x=(')).toBe("unable to parse requirement: found '(', expected: identifier");
    expect(err('x,,y')).toBe("found ',', expected: identifier after ','");
    expect(err(',x')).toBe("found ',', expected: !, identifier, or 'end of string'");
  });
});

describe('parseSelector results', () => {
  test('upstream TestSelectorParse good strings restring without spaces', () => {
    for (const s of ['x=a,y=b,z=c', '', 'x!=a,y=b', 'x=', 'x= ', 'x=,z= ', 'x= ,z= ', '!x', 'x>1', 'x>1,z<5']) {
      expect(selectorString(ok(parseSelector(s)))).toBe(s.replaceAll(' ', ''));
    }
  });

  test('requirements are sorted by key, values sorted and de-duplicated', () => {
    expect(selectorString(ok(parseSelector('x=a,a=x')))).toBe('a=x,x=a');
    expect(selectorString(ok(parseSelector('app in (two,three),!patched')))).toBe('app in (three,two),!patched');
    expect(ok(parseSelector('x in (abc,abc)')).requirements).toEqual([{ key: 'x', operator: 'in', values: ['abc'] }]);
    expect(selectorString(ok(parseSelector('x in (abc,)')))).toBe('x in (,abc)');
    expect(selectorString(ok(parseSelector('x in (,abc)')))).toBe('x in (,abc)');
    expect(selectorString(ok(parseSelector('x in (a,,b)')))).toBe('x in (,a,b)');
    expect(selectorString(ok(parseSelector('z notin ()')))).toBe('z notin ()');
    expect(ok(parseSelector('z notin ()')).requirements[0]?.values).toEqual(['']);
  });

  test('whitespace, keywords as keys and values, and the operator forms', () => {
    expect(ok(parseSelector('\rx')).requirements).toEqual([{ key: 'x', operator: 'exists', values: [] }]);
    expect(selectorString(ok(parseSelector('foo  in\t (abc)')))).toBe('foo in (abc)');
    expect(selectorString(ok(parseSelector('x notin\n (abc)')))).toBe('x notin (abc)');
    expect(selectorString(ok(parseSelector('0.1.2.domain/99 notin (10.10.100.1, tick.tack.clock)')))).toBe('0.1.2.domain/99 notin (10.10.100.1,tick.tack.clock)');
    expect(ok(parseSelector('notin=in')).requirements).toEqual([{ key: 'notin', operator: '=', values: ['in'] }]);
    expect(ok(parseSelector('x in (in,notin)')).requirements[0]?.values).toEqual(['in', 'notin']);
    expect(selectorString(ok(parseSelector('a==b,c!=d,e>1,f<2,!g,h')))).toBe('a==b,c!=d,e>1,f<2,!g,h');
    expect(ok(parseSelector('e>1')).requirements[0]?.operator).toBe('gt');
  });

  test('a NUL reads as Go reading byte 0: it ends an identifier, or the input between tokens', () => {
    expect(selectorString(ok(parseSelector('a\0,b')))).toBe('a,b');
    expect(selectorString(ok(parseSelector('\0a')))).toBe('');
  });

  test('an empty selector is Everything', () => {
    const s = ok(parseSelector(''));
    expect(selectorEmpty(s)).toBe(true);
    expect(selectorMatches(s, { x: 'y' })).toBe(true);
  });

  test('selectors are plain data', () => {
    const s = ok(parseSelector('a in (x,y),!b'));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('matching', () => {
  const m = (s: string, labels: Record<string, string>): boolean => selectorMatches(ok(parseSelector(s)), labels);
  test('upstream TestSelectorMatches', () => {
    expect(m('', { x: 'y' })).toBe(true);
    expect(m('x=y', { x: 'y' })).toBe(true);
    expect(m('x=y,z=w', { x: 'y', z: 'w' })).toBe(true);
    expect(m('x!=y,z!=w', { x: 'z', z: 'a' })).toBe(true);
    expect(m('notin=in', { notin: 'in' })).toBe(true);
    expect(m('x', { x: 'z' })).toBe(true);
    expect(m('!x', { y: 'z' })).toBe(true);
    expect(m('x>1', { x: '2' })).toBe(true);
    expect(m('x<1', { x: '0' })).toBe(true);
    expect(m('x=z', {})).toBe(false);
    expect(m('x=y', { x: 'z' })).toBe(false);
    expect(m('x=y,z=w', { x: 'w', z: 'w' })).toBe(false);
    expect(m('x!=y,z!=w', { x: 'z', z: 'w' })).toBe(false);
    expect(m('x', { y: 'z' })).toBe(false);
    expect(m('!x', { x: 'z' })).toBe(false);
    expect(m('x>1', { x: '0' })).toBe(false);
    expect(m('x<1', { x: '2' })).toBe(false);
  });

  test('set-based and the absent-versus-empty distinction', () => {
    expect(m('x in (a,b)', { x: 'b' })).toBe(true);
    expect(m('x in (a,b)', {})).toBe(false);
    expect(m('x notin (a,b)', {})).toBe(true);
    expect(m('x notin (a,b)', { x: 'a' })).toBe(false);
    expect(m('x=', { x: '' })).toBe(true);
    expect(m('x=', {})).toBe(false);
    expect(m('x in ()', { x: '' })).toBe(true);
    expect(m('x!=', {})).toBe(true);
    // inherited properties are not labels
    expect(m('constructor', {})).toBe(false);
    expect(m('toString=x', {})).toBe(false);
  });

  test('gt and lt parse both sides as int64 and compare strictly', () => {
    expect(m('x>1', { x: '1' })).toBe(false);
    expect(m('x>1', { x: 'abc' })).toBe(false);
    expect(m('x>1', {})).toBe(false);
    expect(m('x>9', { x: '10' })).toBe(true);
    expect(m('x<10', { x: '-5' })).toBe(true);
    expect(m('x>1', { x: '9223372036854775808' })).toBe(false); // out of int64 range: ParseInt fails
    expect(m('x>9223372036854775806', { x: '9223372036854775807' })).toBe(true);
  });

  test('Nothing matches nothing', () => {
    expect(selectorMatches(nothing(), {})).toBe(false);
    expect(selectorEmpty(nothing())).toBe(false);
    expect(selectorString(nothing())).toBe('');
    expect(selectorEmpty(everything())).toBe(true);
  });
});

describe('newRequirement', () => {
  test('requirement-level checks', () => {
    expect(newRequirement('x', 'in', [])).toEqual({ error: "values: Invalid value: []: for 'in', 'notin' operators, values set can't be empty" });
    expect(newRequirement('x', 'notin', null)).toEqual({ error: "values: Invalid value: null: for 'in', 'notin' operators, values set can't be empty" });
    expect(newRequirement('x', '=', ['bar', 'foo'])).toEqual({ error: 'values: Invalid value: ["bar","foo"]: exact-match compatibility requires one single value' });
    expect(newRequirement('x', 'exists', ['foo'])).toEqual({ error: 'values: Invalid value: ["foo"]: values set must be empty for exists and does not exist' });
    expect(newRequirement('x', 'gt', ['1', '2'])).toEqual({ error: `values: Invalid value: ["1","2"]: for 'Gt', 'Lt' operators, exactly one value is required` });
    expect(newRequirement('x', 'bogus', [])).toEqual({
      error: 'operator: Unsupported value: "bogus": supported values: "in", "notin", "=", "==", "!=", "gt", "lt", "exists", "!"',
    });
    expect(newRequirement('-x', '=', ['a'])).toEqual({ error: `key: Invalid value: "-x": ${isQualifiedName('-x').join('; ')}` });
    expect(newRequirement('x', '=', ['a'])).toEqual({ key: 'x', operator: '=', values: ['a'] });
  });

  test('String of hand-built selectors, upstream TestToString', () => {
    const sel = (...rs: Requirement[]): string => selectorString({ requirements: rs });
    expect(sel(req(newRequirement('x', 'in', ['abc', 'def'])), req(newRequirement('y', 'notin', ['jkl'])), req(newRequirement('z', 'exists', [])))).toBe('x in (abc,def),y notin (jkl),z');
    expect(sel(req(newRequirement('x', 'notin', ['def', 'abc'])), req(newRequirement('y', '!=', ['jkl'])), req(newRequirement('z', '!', [])))).toBe('x notin (abc,def),y!=jkl,!z');
    expect(sel(req(newRequirement('x', '=', ['abc'])), req(newRequirement('y', '==', ['jkl'])), req(newRequirement('z', '!=', ['a'])), req(newRequirement('z', 'exists', [])))).toBe('x=abc,y==jkl,z!=a,z');
    expect(sel(req(newRequirement('x', 'gt', ['2'])), req(newRequirement('y', 'lt', ['8'])))).toBe('x>2,y<8');
    // safeSort: sorted, duplicates kept
    expect(sel(req(newRequirement('x', 'in', ['foo', 'bar', 'foo', 'bar'])))).toBe('x in (bar,bar,foo,foo)');
  });
});

describe('selector helpers', () => {
  test('selectorFromSet sorts by key; null and empty sets are Everything', () => {
    expect(selectorString(selectorFromSet({ b: '2', a: '1' }))).toBe('a=1,b=2');
    expect(selectorEmpty(selectorFromSet(null))).toBe(true);
    expect(selectorEmpty(selectorFromSet({}))).toBe(true);
    // no validation
    expect(selectorString(selectorFromSet({ '-bad': 'v@l' }))).toBe('-bad=v@l');
    expect(validatedSelectorFromSet({ a: 'v@l' })).toEqual({ error: `values[0][a]: Invalid value: "v@l": ${isValidLabelValue('v@l').join('; ')}` });
    expect(selectorString(ok(validatedSelectorFromSet({ b: '2', a: '1' })))).toBe('a=1,b=2');
  });

  test('Set.String sorts whole k=v strings, not keys', () => {
    expect(labelsString({ a: '1', 'a.b': '2' })).toBe('a.b=2,a=1');
    expect(formatLabels({})).toBe('<none>');
    expect(formatLabels({ app: 'web' })).toBe('app=web');
  });

  test('selectorAdd sorts stably; Nothing stays Nothing', () => {
    const s = selectorAdd(ok(parseSelector('b=1')), req(newRequirement('a', 'exists', [])), req(newRequirement('b', '!=', ['2'])));
    expect(selectorString(s)).toBe('a,b=1,b!=2');
    expect(selectorAdd(nothing(), req(newRequirement('a', 'exists', [])))).toEqual(nothing());
  });

  test('requiresExactMatch looks at the first requirement on the label', () => {
    expect(requiresExactMatch(ok(parseSelector('a=1,b=2')), 'b')).toEqual({ value: '2' });
    expect(requiresExactMatch(ok(parseSelector('a in (1)')), 'a')).toEqual({ value: '1' });
    expect(requiresExactMatch(ok(parseSelector('a in (1,2)')), 'a')).toBeNull();
    expect(requiresExactMatch(ok(parseSelector('a!=1')), 'a')).toBeNull();
    expect(requiresExactMatch(ok(parseSelector('a')), 'b')).toBeNull();
  });

  test('parseInt64 is strconv.ParseInt(s, 10, 64)', () => {
    expect(parseInt64('+5')).toBe(5n);
    expect(parseInt64('-9223372036854775808')).toBe(-(2n ** 63n));
    expect(parseInt64('9223372036854775808')).toBeNull();
    expect(parseInt64('')).toBeNull();
    expect(parseInt64('1_000')).toBeNull();
    expect(parseInt64('0x10')).toBeNull();
  });

  test('compareGoStrings is byte order, not UTF-16 order', () => {
    expect(compareGoStrings('\u{ff61}', '\u{1f600}')).toBe(-1);
    expect('\u{ff61}' < '\u{1f600}').toBe(false);
    expect(compareGoStrings('a', 'ab')).toBe(-1);
    expect(compareGoStrings('b', 'b')).toBe(0);
  });
});

describe('metav1.LabelSelector', () => {
  test('nil selects nothing, empty selects everything', () => {
    expect(labelSelectorAsSelector(null)).toEqual(nothing());
    expect(labelSelectorAsSelector(undefined)).toEqual(nothing());
    expect(labelSelectorAsSelector({})).toEqual(everything());
    expect(labelSelectorAsSelector({ matchLabels: {}, matchExpressions: [] })).toEqual(everything());
  });

  test('matchLabels and matchExpressions become sorted requirements', () => {
    const s = ok(
      labelSelectorAsSelector({
        matchLabels: { tier: 'web', app: 'shop' },
        matchExpressions: [
          { key: 'env', operator: 'NotIn', values: ['prod', 'dev'] },
          { key: 'app', operator: 'Exists' },
          { key: 'gone', operator: 'DoesNotExist' },
          { key: 'zone', operator: 'In', values: ['b', 'a', 'b'] },
        ],
      }),
    );
    expect(selectorString(s)).toBe('app=shop,app,env notin (dev,prod),!gone,tier=web,zone in (a,b,b)');
    // values are kept as given (ValuesUnsorted)
    expect(s.requirements.find((r) => r.key === 'zone')?.values).toEqual(['b', 'a', 'b']);
    expect(selectorMatches(s, { app: 'shop', tier: 'web', zone: 'a' })).toBe(true);
    expect(selectorMatches(s, { app: 'shop', tier: 'web', zone: 'a', env: 'dev' })).toBe(false);
    expect(selectorMatches(s, { app: 'shop', tier: 'web', zone: 'a', gone: '' })).toBe(false);
  });

  test('errors (fixtures/golden/v1.37.2/api/validation.yaml "expr" selector)', () => {
    const sel = { matchExpressions: [{ key: 'app', operator: 'In' }, { key: 'tier', operator: 'Maybe', values: ['a'] }] };
    expect(labelSelectorAsSelector(sel)).toEqual({ error: "values: Invalid value: null: for 'in', 'notin' operators, values set can't be empty" });
    expect(labelSelectorAsSelector({ matchExpressions: [{ key: 'tier', operator: 'Maybe', values: ['a'] }] })).toEqual({ error: '"Maybe" is not a valid label selector operator' });
    // an empty values list is also nil after append([]string(nil), ...)
    expect(labelSelectorAsSelector({ matchExpressions: [{ key: 'app', operator: 'In', values: [] }] })).toEqual({ error: "values: Invalid value: null: for 'in', 'notin' operators, values set can't be empty" });
    expect(labelSelectorAsSelector({ matchExpressions: [{ key: 'app', operator: 'Exists', values: ['x'] }] })).toEqual({ error: 'values: Invalid value: ["x"]: values set must be empty for exists and does not exist' });
    expect(labelSelectorAsSelector({ matchLabels: { app: 'a b' } })).toEqual({ error: `values[0][app]: Invalid value: "a b": ${isValidLabelValue('a b').join('; ')}` });
  });

  test('LabelSelectorAsMap', () => {
    expect(labelSelectorAsMap(null)).toBeNull();
    expect(labelSelectorAsMap({ matchLabels: { a: '1' }, matchExpressions: [{ key: 'b', operator: 'In', values: ['2'] }] })).toEqual({ a: '1', b: '2' });
    expect(labelSelectorAsMap({ matchExpressions: [{ key: 'b', operator: 'In', values: ['2', '3'] }] })).toEqual({ error: 'operator "In" without a single value cannot be converted into the old label selector format' });
    expect(labelSelectorAsMap({ matchExpressions: [{ key: 'b', operator: 'Exists' }] })).toEqual({ error: 'operator "Exists" cannot be converted into the old label selector format' });
    expect(labelSelectorAsMap({ matchExpressions: [{ key: 'b', operator: 'Nope' }] })).toEqual({ error: '"Nope" is not a valid selector operator' });
  });

  test('FormatLabelSelector', () => {
    expect(formatLabelSelector({ matchLabels: { app: 'web' } })).toBe('app=web');
    expect(formatLabelSelector({})).toBe('<none>');
    expect(formatLabelSelector(null)).toBe('<none>');
    expect(formatLabelSelector({ matchExpressions: [{ key: 'a', operator: 'Maybe' }] })).toBe('<error>');
  });
});
