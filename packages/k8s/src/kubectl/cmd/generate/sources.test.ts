import { describe, expect, test } from 'vitest';
import { encodeBase64 } from '../../../apimachinery/base64.ts';
import { sha256Hex } from './sha256.ts';
import { configMapAdder, configMapHash, envFileLine, parseFileSource, parseLiteralSource, pathBase, scanLines, secretAdder, secretHash } from './sources.ts';

describe('sha256', () => {
  // FIPS 180-4 example vectors
  test.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('%j', (input, hex) => {
    expect(sha256Hex(input)).toBe(hex);
  });

  test('a message of 64 bytes and more spans blocks', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
});

describe('--append-hash', () => {
  // Names the real kubectl printed (fixtures/golden/v1.37.2/generate/client.yaml and the workstation's
  // v1.37.2 binary: `create configmap c --from-literal=a=b --append-hash --dry-run=client -o name`).
  test('ConfigMapHash', () => {
    expect(configMapHash({ name: 'c', data: { a: 'b' } })).toBe('m4h6ctkgb2');
    expect(configMapHash({ name: 'c', data: {} })).toBe('94b26g54cg');
    expect(configMapHash({ name: 'hashed', data: { a: '1', b: '2' } })).toBe('b8cfdm67ft');
  });

  test('SecretHash', () => {
    expect(secretHash({ name: 's', type: '', data: { a: encodeBase64('b') } })).toBe('7fd2tm89d8');
    expect(secretHash({ name: 's', type: '', data: {} })).toBe('6cmg28h685');
  });
});

describe('sources', () => {
  test('ParseFileSource', () => {
    expect(parseFileSource('dir/app.properties')).toEqual({ key: 'app.properties', path: 'dir/app.properties' });
    expect(parseFileSource('conf/')).toEqual({ key: 'conf', path: 'conf/' });
    expect(parseFileSource('k=dir/x')).toEqual({ key: 'k', path: 'dir/x' });
    expect(parseFileSource('=x')).toEqual({ error: 'key name for file path x missing' });
    expect(parseFileSource('k=')).toEqual({ error: 'file path for key name k missing' });
    expect(parseFileSource('a=b=c')).toEqual({ error: "key names or file paths cannot contain '='" });
  });

  test('path.Base', () => {
    expect(pathBase('')).toBe('.');
    expect(pathBase('///')).toBe('/');
    expect(pathBase('a/b//')).toBe('b');
  });

  test('ParseLiteralSource keeps everything after the first =', () => {
    expect(parseLiteralSource('url=http://x?a=b')).toEqual({ key: 'url', value: 'http://x?a=b' });
    expect(parseLiteralSource('empty=')).toEqual({ key: 'empty', value: '' });
    expect(parseLiteralSource('none')).toEqual({ error: 'invalid literal source none, expected key=value' });
    expect(parseLiteralSource('=v')).toEqual({ error: 'invalid literal source =v, expected key=value' });
  });

  test('bufio.ScanLines: a last line without a newline counts, a trailing \\r is dropped', () => {
    expect(scanLines('a\r\nb\n\nc')).toEqual(['a', 'b', '', 'c']);
    expect(scanLines('')).toEqual([]);
    expect(scanLines('\n')).toEqual(['']);
  });

  test('processEnvFileLine', () => {
    const env = { SET: 'from-env' };
    expect(envFileLine('﻿A=1', 0, env)).toEqual({ key: 'A', value: '1' });
    expect(envFileLine('﻿A=1', 1, env)).toMatchObject({ error: expect.stringContaining('"﻿A" is not a valid key name') });
    expect(envFileLine('  \tB=two words ', 3, env)).toEqual({ key: 'B', value: 'two words ' });
    expect(envFileLine('   # comment', 2, env)).toBeUndefined();
    expect(envFileLine('', 2, env)).toBeUndefined();
    expect(envFileLine('SET', 2, env)).toEqual({ key: 'SET', value: 'from-env' });
    expect(envFileLine('UNSET', 2, env)).toEqual({ key: 'UNSET', value: '' });
    expect(envFileLine('B =x', 2, env)).toMatchObject({ error: expect.stringMatching(/^"B " is not a valid key name: a valid environment variable name/) });
  });

  test('a ConfigMap and a Secret word their key errors differently', () => {
    const cm = { name: 'x', data: {} as Record<string, string> };
    const addCm = configMapAdder(cm);
    expect(addCm('a', '1')).toBeUndefined();
    expect(addCm('a', '2')).toEqual({ error: 'cannot add key "a", another key by that name already exists in Data for ConfigMap "x"' });
    expect(addCm('a b', '2')?.error).toMatch(/^"a b" is not a valid key name for a ConfigMap: a valid config key/);
    const s = { name: 'x', type: '', data: {} as Record<string, string> };
    const addS = secretAdder(s);
    expect(addS('a', 'é')).toBeUndefined();
    expect(s.data.a).toBe('w6k=');
    expect(addS('a', '2')).toEqual({ error: 'cannot add key a, another key by that name already exists' });
    expect(addS('a b', '2')?.error).toMatch(/^"a b" is not valid key name for a Secret a valid config key/);
  });
});
