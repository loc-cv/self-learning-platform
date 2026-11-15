// Character classes of glibc's C.UTF-8 locale as JavaScript regular expression fragments (used
// with the `u` flag). glibc generates the locale's LC_CTYPE from Unicode data:
//   upstream: glibc localedata/unicode-gen/unicode_utils.py (is_alpha, is_upper, is_space, …)
//   reference: grep 3.11 in C.UTF-8 on this workstation, captured 2026-11-16 — é ß Ω ж 中 are alpha,
//              ٣ (an Arabic-Indic digit) is alpha but not digit, Ⅻ is alpha and upper, ǅ is upper
//              and lower, ½ ² _ ‿ are punct, U+00A0 is neither space nor blank, U+3000 is both.
// The Unicode version of the JavaScript engine is not glibc's; code points assigned in between
// can classify differently.

/** Whitespace: the C locale's six plus the Unicode separators that are not no-break spaces. */
const SPACE = '\\t\\n\\v\\f\\r \\u1680\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000';
const BLANK = '\\t \\u1680\\u2000-\\u2006\\u2008-\\u200a\\u205f\\u3000';
/** alnum: letters (Alphabetic) and every decimal digit; non-ASCII digits count as alpha. */
const ALNUM = '\\p{Alphabetic}\\p{Nd}';

/**
 * A class either fits inside a JavaScript character class (`set`) or needs a whole expression
 * that matches one character (`expr`).
 */
export type ClassFragment = { set: string } | { expr: string };

export const CLASSES: Readonly<Record<string, ClassFragment>> = {
  alpha: { expr: `(?![0-9])[${ALNUM}]` },
  upper: { set: '\\p{Changes_When_Lowercased}' },
  lower: { set: '\\p{Changes_When_Uppercased}' },
  digit: { set: '0-9' },
  xdigit: { set: '0-9A-Fa-f' },
  space: { set: SPACE },
  blank: { set: BLANK },
  alnum: { set: ALNUM },
  cntrl: { set: '\\p{Cc}\\u2028\\u2029' },
  print: { expr: '[^\\p{Cc}\\p{Cn}\\u2028\\u2029]' },
  graph: { expr: `(?![${SPACE}])[^\\p{Cc}\\p{Cn}]` },
  punct: { expr: `(?![${ALNUM}${SPACE}])[^\\p{Cc}\\p{Cn}]` },
};

/** Word constituents of `\w`, `\<`, `\b` and -w: alnum and the underscore. upstream: glibc regcomp.c init_word_char, grep searchutils.c wordchar */
export const WORD = `[${ALNUM}_]`;
export const NOT_WORD = `[^${ALNUM}_]`;
export const SPACE_CLASS = `[${SPACE}]`;
export const NOT_SPACE_CLASS = `[^${SPACE}]`;
