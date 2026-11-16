// Go's filepath.Match table, run against the port.
//   upstream: .upstream/go src/path/filepath/match_test.go matchTests (go1.23.11)

import { describe, expect, test } from 'vitest';
import { cleanPath, extOf, joinPath, matchPath } from './glob.ts';

/** pattern, name, match, ErrBadPattern */
const MATCH_TESTS: [string, string, boolean, boolean][] = [
  ["abc", "abc", true, false],
  ["*", "abc", true, false],
  ["*c", "abc", true, false],
  ["a*", "a", true, false],
  ["a*", "abc", true, false],
  ["a*", "ab/c", false, false],
  ["a*/b", "abc/b", true, false],
  ["a*/b", "a/c/b", false, false],
  ["a*b*c*d*e*/f", "axbxcxdxe/f", true, false],
  ["a*b*c*d*e*/f", "axbxcxdxexxx/f", true, false],
  ["a*b*c*d*e*/f", "axbxcxdxe/xxx/f", false, false],
  ["a*b*c*d*e*/f", "axbxcxdxexxx/fff", false, false],
  ["a*b?c*x", "abxbbxdbxebxczzx", true, false],
  ["a*b?c*x", "abxbbxdbxebxczzy", false, false],
  ["ab[c]", "abc", true, false],
  ["ab[b-d]", "abc", true, false],
  ["ab[e-g]", "abc", false, false],
  ["ab[^c]", "abc", false, false],
  ["ab[^b-d]", "abc", false, false],
  ["ab[^e-g]", "abc", true, false],
  ["a\\*b", "a*b", true, false],
  ["a\\*b", "ab", false, false],
  ["a?b", "a☺b", true, false],
  ["a[^a]b", "a☺b", true, false],
  ["a???b", "a☺b", false, false],
  ["a[^a][^a][^a]b", "a☺b", false, false],
  ["[a-ζ]*", "α", true, false],
  ["*[a-ζ]", "A", false, false],
  ["a?b", "a/b", false, false],
  ["a*b", "a/b", false, false],
  ["[\\]a]", "]", true, false],
  ["[\\-]", "-", true, false],
  ["[x\\-]", "x", true, false],
  ["[x\\-]", "-", true, false],
  ["[x\\-]", "z", false, false],
  ["[\\-x]", "x", true, false],
  ["[\\-x]", "-", true, false],
  ["[\\-x]", "a", false, false],
  ["[]a]", "]", false, true],
  ["[-]", "-", false, true],
  ["[x-]", "x", false, true],
  ["[x-]", "-", false, true],
  ["[x-]", "z", false, true],
  ["[-x]", "x", false, true],
  ["[-x]", "-", false, true],
  ["[-x]", "a", false, true],
  ["\\", "a", false, true],
  ["[a-b-c]", "a", false, true],
  ["[", "a", false, true],
  ["[^", "a", false, true],
  ["[^bc", "a", false, true],
  ["a[", "a", false, true],
  ["a[", "ab", false, true],
  ["a[", "x", false, true],
  ["a/b[", "x", false, true],
  ["*x", "xxx", true, false],
];

describe('filepath.Match', () => {
  test.each(MATCH_TESTS)('%s against %s', (pattern, name, match, bad) => {
    expect(matchPath(pattern, name)).toEqual(bad ? { error: 'syntax error in pattern' } : match);
  });
});

describe('Clean, Join, Ext', () => {
  test('as Go cleans and joins paths', () => {
    expect(cleanPath('dir/')).toBe('dir');
    expect(cleanPath('./a/../b//c')).toBe('b/c');
    expect(cleanPath('/../x')).toBe('/x');
    expect(cleanPath('')).toBe('.');
    expect(joinPath('dir/', 'a.yaml')).toBe('dir/a.yaml');
    expect(joinPath('.', 'a.yaml')).toBe('a.yaml');
    expect(extOf('dir.d/a.tar.yml')).toBe('.yml');
    expect(extOf('dir.d/readme')).toBe('');
  });
});
