// Byte views of text, for the programs that count or cut bytes (`head -c`, `wc -c`, `cut -b`,
// `tr`). Stored text is Unicode; its bytes are its UTF-8 encoding. Bytes that do not form valid
// UTF-8 after a cut become U+FFFD (docs/FIDELITY.md DIV-002), which is what a terminal shows.

import { byteChar, decodeBytes } from '../../text/bytes.ts';

/** The UTF-8 encoding of `s`. */
export function toOctets(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Text whose UTF-8 encoding is `bytes`, invalid sequences as U+FFFD. */
export function fromOctets(bytes: readonly number[]): string {
  let s = '';
  for (const b of bytes) s += byteChar(b);
  return decodeBytes(s);
}

/** Length of the UTF-8 encoding of one character. */
export function charOctets(ch: string): number {
  const c = ch.codePointAt(0) as number;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

/**
 * Splits `s` after `n` bytes. A cut inside a character keeps the character's leading bytes on the
 * left and its trailing bytes on the right (each becomes U+FFFD).
 */
export function splitOctets(s: string, n: number): [string, string] {
  let bytes = 0;
  let i = 0;
  for (const ch of s) {
    const len = charOctets(ch);
    if (bytes + len > n) {
      if (bytes === n) return [s.slice(0, i), s.slice(i)];
      const enc = toOctets(ch);
      const k = n - bytes;
      return [s.slice(0, i) + fromOctets(enc.slice(0, k)), fromOctets(enc.slice(k)) + s.slice(i + ch.length)];
    }
    bytes += len;
    i += ch.length;
  }
  return [s, ''];
}
