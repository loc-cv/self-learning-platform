// []byte fields: their JSON form is standard base64 (Go's encoding/json with
// base64.StdEncoding). Bytes are held as a binary string, one char per byte (0-255).
// upstream: Go src/encoding/base64/base64.go (StdEncoding; Decode skips '\r' and '\n').

import { base64Error } from './gojson.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Go's []byte(s): UTF-8, a lone surrogate becoming U+FFFD as Go's decoder makes it. */
export function utf8Bytes(s: string): string {
  let out = '';
  for (const ch of s) {
    let c = ch.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0x800) out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/** base64.StdEncoding.EncodeToString of a binary string. */
export function encodeBase64(bytes: string): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes.charCodeAt(i);
    const b1 = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(n >> 18) & 63] as string;
    out += ALPHABET[(n >> 12) & 63] as string;
    out += i + 1 < bytes.length ? (ALPHABET[(n >> 6) & 63] as string) : '=';
    out += i + 2 < bytes.length ? (ALPHABET[n & 63] as string) : '=';
  }
  return out;
}

/** base64.StdEncoding.DecodeString to a binary string; undefined when Go would fail. */
export function decodeBase64(s: string): string | undefined {
  if (base64Error(s) !== undefined) return undefined;
  const clean = s.replace(/[\r\n]/g, '').replace(/=+$/, '');
  let out = '';
  let acc = 0;
  let nbits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | ALPHABET.indexOf(ch);
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      out += String.fromCharCode((acc >> nbits) & 0xff);
    }
  }
  return out;
}

/** The decoded length of a valid base64 value (len of the []byte). */
export function decodedLength(s: string): number {
  const clean = s.replace(/[\r\n]/g, '').replace(/=+$/, '');
  return Math.floor((clean.length * 6) / 8);
}
