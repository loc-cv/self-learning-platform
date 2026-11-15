// Stream and file contents are text: JavaScript strings of Unicode characters, which the simulator
// treats as their UTF-8 encoding. Escapes that produce single bytes (printf '\xc3\xa9', $'\351')
// are carried as placeholder characters and decoded here, so a byte sequence that is valid UTF-8
// becomes the character it encodes. A sequence that is not valid UTF-8 becomes U+FFFD: raw binary
// data is not representable (docs/FIDELITY.md DIV-002).

const BASE = 0xf700;

/** A placeholder for byte `b` (0x80–0xff); bytes below 0x80 are their ASCII character. */
export function byteChar(b: number): string {
  return b < 0x80 ? String.fromCharCode(b) : String.fromCharCode(BASE + b);
}

const isByte = (c: number): boolean => c >= BASE + 0x80 && c <= BASE + 0xff;

/** Replaces runs of placeholder bytes by the characters their UTF-8 encoding spells. */
export function decodeBytes(s: string): string {
  if (!/[-]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (!isByte(c)) {
      out += s[i++];
      continue;
    }
    const b0 = c - BASE;
    const need = b0 >= 0xf0 && b0 < 0xf8 ? 3 : b0 >= 0xe0 ? 2 : b0 >= 0xc2 ? 1 : 0;
    let cp = need === 3 ? b0 & 7 : need === 2 ? b0 & 15 : b0 & 31;
    let ok = need > 0;
    for (let k = 1; ok && k <= need; k++) {
      const n = s.charCodeAt(i + k);
      if (!isByte(n) || ((n - BASE) & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | ((n - BASE) & 63);
    }
    if (ok && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      out += String.fromCodePoint(cp);
      i += need + 1;
    } else {
      out += '�';
      i++;
    }
  }
  return out;
}
