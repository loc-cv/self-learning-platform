// Character classes and display widths of glibc's C.UTF-8 locale, as `wc` uses them.
//   docs: wcwidth(3), iswspace(3), iswprint(3); gnulib lib/c-ctype iswnbspace
//   reference: coreutils 9.4 wc under LANG=C.UTF-8, captured 2026-11-16 — word separators
//              U+0009–000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000 (not
//              U+2028, U+2029, U+0085, U+180E, U+FEFF, U+001C); `wc -L` of "e" U+0301 U+00AD U+200B "x" is
//              3 and of "日本😀" is 6.
// Widths follow Unicode's East Asian Width (W and F are 2) and general categories (nonspacing and
// enclosing marks and format characters are 0, except U+00AD); the wide ranges are the main
// blocks, not every code point of the Unicode tables.

const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const CONTROL = /^[\p{Cc}]$/u;

/** iswprint: false for control characters (C0, DEL, C1). */
export function isPrint(ch: string): boolean {
  return !CONTROL.test(ch);
}

/** wcwidth of a printable character. */
export function wcwidth(ch: string): number {
  const c = ch.codePointAt(0) as number;
  if (c === 0xad) return 1;
  if (ZERO.test(ch) || (c >= 0x1160 && c <= 0x11ff)) return 0;
  for (const [lo, hi] of WIDE) {
    if (c < lo) break;
    if (c <= hi) return 2;
  }
  return 1;
}

/** iswspace or iswnbspace: what ends a word for `wc -w`. */
export function isWordSpace(ch: string): boolean {
  const c = ch.codePointAt(0) as number;
  return (
    (c >= 9 && c <= 13) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}
