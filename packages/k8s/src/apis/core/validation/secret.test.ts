// Secret defaulting (type, stringData) and validation rules beyond the fixtures. Messages
// checked against the v1.37.2 oracle.

import { describe, expect, test } from 'vitest';
import { aggregate } from '../../../apimachinery/field.ts';
import { encodeBase64, utf8Bytes } from '../../../apimachinery/base64.ts';
import type { FieldError } from '../../../apimachinery/field.ts';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { convertSecretStringData, setObjectDefaultsSecret } from '../v1/defaults/secret.ts';
import { validateSecret, validateSecretUpdate } from './secret.ts';

const b64 = (s: string): string => encodeBase64(utf8Bytes(s));
const secret = (extra: JsonObject): JsonObject => ({ metadata: { name: 's', namespace: 'default' }, type: 'Opaque', ...extra });
const all = (errs: FieldError[]): string => (errs.length === 0 ? '' : aggregate(errs));
const msg = (o: JsonObject): string => all(validateSecret(o));

describe('defaults and stringData', () => {
  test('type defaults to Opaque', () => {
    const s: JsonObject = {};
    setObjectDefaultsSecret(s);
    expect(s.type).toBe('Opaque');
  });

  test('stringData overwrites data as UTF-8 base64, keys sorted, stringData removed', () => {
    // checked against the v1.37.2 oracle: {b: "héllo ☃", a: "x"} over data {b, c}.
    const s: JsonObject = { stringData: { b: 'héllo ☃', a: 'x' }, data: { b: 'YWRtaW4=', c: 'Yw==' } };
    convertSecretStringData(s);
    expect(s).toEqual({ data: { a: 'eA==', b: 'aMOpbGxvIOKYgw==', c: 'Yw==' } });
    expect(Object.keys(s.data as JsonObject)).toEqual(['a', 'b', 'c']);
  });

  test('an empty stringData leaves data alone', () => {
    const s: JsonObject = { stringData: {} };
    convertSecretStringData(s);
    expect(s).toEqual({});
  });
});

describe('validateSecret', () => {
  test('type-specific required keys', () => {
    expect(msg(secret({ type: 'kubernetes.io/tls', data: {} }))).toBe('[data[tls.crt]: Required value, data[tls.key]: Required value]');
    expect(msg(secret({ type: 'kubernetes.io/basic-auth', data: { x: 'eA==' } }))).toBe('[data[username]: Required value, data[password]: Required value]');
    expect(msg(secret({ type: 'kubernetes.io/basic-auth', data: { password: '' } }))).toBe('');
    expect(msg(secret({ type: 'kubernetes.io/ssh-auth', data: { 'ssh-privatekey': '' } }))).toBe('data[ssh-privatekey]: Required value');
    expect(msg(secret({ type: 'kubernetes.io/service-account-token' }))).toBe('metadata.annotations[kubernetes.io/service-account.name]: Required value');
    expect(msg(secret({ type: 'kubernetes.io/dockercfg', data: { x: 'eA==' } }))).toBe('data[.dockercfg]: Required value');
    expect(msg(secret({ type: 'example.com/custom', data: {} }))).toBe('');
  });

  test('docker config contents must be a JSON object', () => {
    const docker = (json: string): string => msg(secret({ type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': b64(json) } }));
    const prefix = 'data[.dockerconfigjson]: Invalid value: "<secret contents redacted>": ';
    expect(docker('{"auths":{}}')).toBe('');
    expect(docker('null')).toBe('');
    expect(docker('{"a":1')).toBe(`${prefix}unexpected end of JSON input`);
    expect(docker('[1]')).toBe(`${prefix}json: cannot unmarshal array into Go value of type map[string]interface {}`);
    expect(docker('"s"')).toBe(`${prefix}json: cannot unmarshal string into Go value of type map[string]interface {}`);
    expect(docker('xyz')).toBe(`${prefix}invalid character 'x' looking for beginning of value`);
    expect(docker('{"a" 1}')).toBe(`${prefix}invalid character '1' after object key`);
    expect(docker('{"a":1} x')).toBe(`${prefix}invalid character 'x' after top-level value`);
    expect(docker('{"a":tru}')).toBe(`${prefix}invalid character '}' in literal true (expecting 'e')`);
  });

  test('key names and total size', () => {
    expect(msg(secret({ data: { 'a/b': 'eA==' } }))).toBe(
      "data[a/b]: Invalid value: \"a/b\": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')",
    );
    const big = 'A'.repeat(((1024 * 1024) / 3) * 4 + 4);
    expect(msg(secret({ data: { a: big } }))).toBe('data: Too long: may not be more than 1048576 bytes');
  });
});

describe('validateSecretUpdate', () => {
  test('type is immutable; immutable Secrets keep their data and flag', () => {
    const old = secret({ metadata: { name: 's', namespace: 'default', resourceVersion: '1' }, immutable: true, data: { a: 'eA==' } });
    const next = secret({ metadata: { name: 's', namespace: 'default', resourceVersion: '1' }, type: 'kubernetes.io/tls', data: { a: 'eQ==' } });
    expect(all(validateSecretUpdate(next, old))).toBe(
      '[type: Invalid value: "kubernetes.io/tls": field is immutable, immutable: Forbidden: field is immutable when `immutable` is set, data: Forbidden: field is immutable when `immutable` is set, data[tls.crt]: Required value, data[tls.key]: Required value]',
    );
  });
});
