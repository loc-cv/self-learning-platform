// UTF-8 encoding of stream and file contents (text/bytes.ts explains the text model). The engine's
// lib has no TextEncoder, and the decoding has to follow the simulator's rule for invalid input.

import { byteChar, decodeBytes } from './bytes.ts';

/** UTF-8 bytes of one character (one code point). */
export function utf8Bytes(ch: string): number[] {
  const c = ch.codePointAt(0) as number;
  if (c < 0x80) return [c];
  if (c < 0x800) return [0xc0 | (c >> 6), 0x80 | (c & 63)];
  if (c < 0x10000) return [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
  return [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
}

/** UTF-8 bytes of a string. */
export function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(...utf8Bytes(ch));
  return out;
}

/** Number of bytes of a string in UTF-8. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Text from bytes; a sequence that is not valid UTF-8 becomes U+FFFD (docs/FIDELITY.md DIV-002). */
export function utf8Decode(bytes: readonly number[]): string {
  let s = '';
  for (const b of bytes) s += byteChar(b);
  return decodeBytes(s);
}
