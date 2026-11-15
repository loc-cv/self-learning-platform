// IP and CIDR parsing (sloppy and strict), RFC 5952 formatting, the CIDR warnings, Go's JSON
// syntax errors and the PEM stage of tls.X509KeyPair.

import { describe, expect, test } from 'vitest';
import { encodeBase64 } from './base64.ts';
import { newPath } from './field.ts';
import { goJsonSyntaxError, unmarshalMapError } from './gojsonsyntax.ts';
import { addrString, ipString, isDualStackCIDRStrings, parseAddr, parseCIDRSloppy, parseIPSloppy, parsePrefix, prefixIsMasked } from './net.ts';
import { pemDecode, x509KeyPairPem } from './pem.ts';
import { getWarningsForCIDR, isValidCIDR, isValidIP } from './validation/ip.ts';

describe('net', () => {
  test('sloppy parsing accepts leading zeros, strict parsing does not', () => {
    expect(parseIPSloppy('010.001.2.3')?.slice(12)).toEqual([10, 1, 2, 3]);
    expect(parseAddr('010.001.2.3')).toBeUndefined();
    expect(parseIPSloppy('1.2.3')).toBeUndefined();
    expect(parseIPSloppy('fe80::1%eth0')).toBeUndefined();
    expect(parseAddr('fe80::1%eth0')?.zone).toBe('eth0');
    expect(parseIPSloppy('::ffff:1.2.3.4')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
  });

  test('RFC 5952 formatting', () => {
    expect(ipString(parseIPSloppy('2001:0DB8:0:0:1:0:0:1') as number[])).toBe('2001:db8::1:0:0:1');
    expect(ipString(parseIPSloppy('::ffff:1.2.3.4') as number[])).toBe('1.2.3.4');
    expect(addrString(parseAddr('::ffff:1.2.3.4') as never)).toBe('::ffff:1.2.3.4');
    expect(ipString(parseIPSloppy('1:0:2:3:4:5:6:7') as number[])).toBe('1:0:2:3:4:5:6:7');
  });

  test('CIDRs', () => {
    const r = parseCIDRSloppy('10.244.9.1/024');
    expect('net' in r && r.net).toEqual({ ip: [10, 244, 9, 0], ones: 24, bits: 32 });
    expect(parseCIDRSloppy('x')).toEqual({ error: 'invalid CIDR address: x' });
    expect(parsePrefix('10.1.0.0/024')).toBeUndefined();
    expect(prefixIsMasked(parsePrefix('10.244.9.1/24') as never)).toBe(false);
    expect(prefixIsMasked(parsePrefix('fd00::/64') as never)).toBe(true);
    expect(isDualStackCIDRStrings(['10.1.0.0/24', 'fd00::/64'])).toEqual({ dualStack: true });
    expect(isDualStackCIDRStrings(['10.1.0.0/24', '10.2.0.0/24'])).toEqual({ dualStack: false });
  });

  test('validation messages and warnings', () => {
    const p = newPath('spec', 'podCIDRs').index(1);
    // checked against the v1.37.2 oracle (a Node with podCIDRs ["10.244.9.0/24", "FD00:0::/64"]).
    expect(getWarningsForCIDR(p, 'FD00:0::/64')).toEqual(['spec.podCIDRs[1]: IPv6 CIDR value "FD00:0::/64" should be in RFC 5952 canonical format ("fd00::/64")']);
    expect(getWarningsForCIDR(p, '10.1.0.0/24')).toEqual([]);
    expect(isValidCIDR(p, '10.1.0.0/24')).toEqual([]);
    expect(isValidIP(p, '1.2.3.4')).toEqual([]);
    expect(isValidIP(p, 'FE80::1').map((e) => e.detail)).toEqual(['must be in canonical form ("fe80::1")']);
  });
});

describe("Go's JSON syntax errors", () => {
  test('scanner messages', () => {
    // checked against the v1.37.2 oracle (the v1 scanner; Go 1.27's default jsonv2 words these differently).
    expect(goJsonSyntaxError('"\\q"')).toBe("invalid character 'q' in string escape code");
    expect(goJsonSyntaxError('1.e')).toBe("invalid character 'e' after decimal point in numeric literal");
    expect(goJsonSyntaxError('{"a":"\x01"}')).toBe("invalid character '\\x01' in string literal");
    expect(goJsonSyntaxError('\xc3')).toBe("invalid character 'Ã' looking for beginning of value");
    expect(goJsonSyntaxError('{"a":[1,2]}')).toBeUndefined();
    expect(goJsonSyntaxError('')).toBe('unexpected end of JSON input');
    expect(goJsonSyntaxError('{"a":1,}')).toBe("invalid character '}' looking for beginning of object key string");
    expect(goJsonSyntaxError('[1 2]')).toBe("invalid character '2' after array element");
    expect(goJsonSyntaxError('{"a":1 "b"}')).toBe("invalid character '\"' after object key:value pair");
    expect(goJsonSyntaxError('"\\q"')).toBe("invalid character 'q' in string escape code");
    expect(goJsonSyntaxError('01')).toBe("invalid character '1' after top-level value");
    expect(goJsonSyntaxError('1.e')).toBe("invalid character 'e' after decimal point in numeric literal");
    expect(goJsonSyntaxError("'a'")).toBe("invalid character '\\'' looking for beginning of value");
    expect(unmarshalMapError(' 12 ')).toBe('json: cannot unmarshal number into Go value of type map[string]interface {}');
    expect(unmarshalMapError('true')).toBe('json: cannot unmarshal bool into Go value of type map[string]interface {}');
  });
});

describe('PEM', () => {
  const block = (type: string, body = 'AAAA'): string => `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;

  test('pem.Decode finds blocks and skips garbage', () => {
    const d = pemDecode(`junk\n${block('CERTIFICATE')}rest`);
    expect(d?.block).toEqual({ type: 'CERTIFICATE', bytes: '\0\0\0' });
    expect(d?.rest).toBe('rest');
    expect(pemDecode('-----BEGIN X-----\nAAAA\n-----END Y-----\n')).toBeUndefined();
    expect(pemDecode(block('CERTIFICATE', '!!!!'))).toBeUndefined();
  });

  test('the PEM errors of tls.X509KeyPair', () => {
    expect(x509KeyPairPem('cert', 'key')).toEqual({ error: 'tls: failed to find any PEM data in certificate input' });
    expect(x509KeyPairPem(block('PRIVATE KEY'), block('PRIVATE KEY'))).toEqual({
      error: 'tls: failed to find certificate PEM data in certificate input, but did find a private key; PEM inputs may have been switched',
    });
    expect(x509KeyPairPem(block('X'), '')).toEqual({ error: 'tls: failed to find "CERTIFICATE" PEM block in certificate input after skipping PEM blocks of the following types: [X]' });
    expect(x509KeyPairPem(block('CERTIFICATE'), 'key')).toEqual({ error: 'tls: failed to find any PEM data in key input' });
    expect(x509KeyPairPem(block('CERTIFICATE'), block('CERTIFICATE'))).toEqual({ error: 'tls: found a certificate rather than a key in the PEM for the private key' });
    expect(x509KeyPairPem(block('CERTIFICATE'), block('A') + block('B'))).toEqual({
      error: 'tls: failed to find PEM block with type ending in "PRIVATE KEY" in key input after skipping PEM blocks of the following types: [A B]',
    });
    expect(x509KeyPairPem(block('CERTIFICATE'), block('EC PRIVATE KEY'))).toEqual({ cert: '\0\0\0', key: '\0\0\0' });
    expect(encodeBase64('\0\0\0')).toBe('AAAA');
  });
});
