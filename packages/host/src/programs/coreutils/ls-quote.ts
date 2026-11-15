// File name quoting for ls: gnulib's quotearg_buffer_restyled with every quoting style ls offers,
// the extra characters ls asks to quote, the ? replacement of -q, and display widths.
//   upstream: gnulib lib/quotearg.c quotearg_buffer_restyled; coreutils src/ls.c quote_name_buf
//   reference: coreutils 9.4 ls with each --quoting-style, -b, -Q, -N, -q on names with spaces,
//              quotes, backslashes, control and multibyte characters, captured 2026-11-16
//              (packages/host/transcripts/coreutils/ls-quoting.t)
// Names are JavaScript strings whose characters stand for their UTF-8 encoding; octal escapes of
// unprintable characters write those bytes.

export type QuotingStyle =
  | 'literal'
  | 'shell'
  | 'shell-always'
  | 'shell-escape'
  | 'shell-escape-always'
  | 'c'
  | 'c-maybe'
  | 'escape'
  | 'locale'
  | 'clocale';

export const QUOTING_STYLES: readonly QuotingStyle[] = [
  'literal',
  'shell',
  'shell-always',
  'shell-escape',
  'shell-escape-always',
  'c',
  'c-maybe',
  'escape',
  'locale',
  'clocale',
];

export interface QuotingOptions {
  style: QuotingStyle;
  /** Characters to quote in addition to the style's own (set_char_quoting). */
  extra?: string;
}

type Internal = 'shell-always' | 'shell-escape-always' | 'c' | 'escape' | 'locale' | 'literal' | 'shell' | 'shell-escape' | 'c-maybe' | 'clocale';

const SAFE = /^[%+,\-./0-9:A-Z\]_a-z]$/;

function utf8(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
}

/** Whether a character is printable in C.UTF-8 (c32isprint): not a control, separator or unassigned. */
export function isPrintable(ch: string): boolean {
  return !/[\p{Cc}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u.test(ch);
}

class Restart {
  readonly style: Internal;
  constructor(style: Internal) {
    this.style = style;
  }
}

function restyled(arg: string, style0: Internal, elide0: boolean, extra: string | undefined): string {
  let style: Internal = style0;
  let elide = elide0;
  let backslashEscapes = false;
  let quoteString = '';
  let out = '';
  let encounteredSingleQuote = false;
  let allCompat = true;
  let pendingShellEscapeEnd = false;

  switch (style) {
    case 'c-maybe':
    case 'c':
      if (style === 'c-maybe') {
        style = 'c';
        elide = true;
      }
      if (!elide) out += '"';
      backslashEscapes = true;
      quoteString = '"';
      break;
    case 'escape':
      backslashEscapes = true;
      elide = false;
      break;
    case 'locale':
    case 'clocale':
      // gettext_quote in a UTF-8 locale: U+2018 and U+2019.
      if (!elide) out += '‘';
      backslashEscapes = true;
      quoteString = '’';
      break;
    case 'shell-escape':
      backslashEscapes = true;
      elide = true;
      style = 'shell-always';
      quoteString = "'";
      break;
    case 'shell':
      elide = true;
      style = 'shell-always';
      quoteString = "'";
      break;
    case 'shell-escape-always':
      if (!elide) backslashEscapes = true;
      style = 'shell-always';
      if (!elide) out += "'";
      quoteString = "'";
      break;
    case 'shell-always':
      if (!elide) out += "'";
      quoteString = "'";
      break;
    case 'literal':
      elide = false;
      break;
  }

  const force = (): never => {
    throw new Restart(style === 'shell-always' && backslashEscapes ? 'shell-escape-always' : style);
  };
  const chars = [...arg];
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i] as string;
    let escaping = false;
    let compat = false;
    let isRightQuote = false;
    let store = '';
    const startEsc = (): void => {
      if (elide) force();
      escaping = true;
      if (style === 'shell-always' && !pendingShellEscapeEnd) {
        store += "'$'";
        pendingShellEscapeEnd = true;
      }
      store += '\\';
    };

    if (backslashEscapes && style !== 'shell-always' && quoteString !== '' && c === quoteString) {
      if (elide) force();
      isRightQuote = true;
    }

    let action: 'store' | 'escape' | 'check' = 'check';
    const cEscape = (esc: string): void => {
      if (backslashEscapes) {
        c = esc;
        action = 'escape';
      }
    };
    switch (c) {
      case '\0':
        if (backslashEscapes) {
          startEsc();
          c = '0';
        }
        break;
      case '?':
        if (style === 'shell-always' && elide) force();
        break;
      case '\x07':
        cEscape('a');
        break;
      case '\b':
        cEscape('b');
        break;
      case '\f':
        cEscape('f');
        break;
      case '\v':
        cEscape('v');
        break;
      case '\n':
      case '\r':
      case '\t':
        if (style === 'shell-always' && elide) force();
        cEscape(c === '\n' ? 'n' : c === '\r' ? 'r' : 't');
        break;
      case '\\':
        if (style === 'shell-always') {
          if (elide) force();
          action = 'store';
          break;
        }
        if (backslashEscapes && elide && quoteString !== '') {
          action = 'store';
          break;
        }
        cEscape('\\');
        break;
      case '{':
      case '}':
      case '#':
      case '~':
      case ' ':
      case '!':
      case '"':
      case '$':
      case '&':
      case '(':
      case ')':
      case '*':
      case ';':
      case '<':
      case '=':
      case '>':
      case '[':
      case '^':
      case '`':
      case '|': {
        // `{` and `}` are special only as the whole name, `#` and `~` only at the start.
        const special =
          c === '{' || c === '}' ? chars.length === 1 : c === '#' || c === '~' ? i === 0 : true;
        if (!special) break;
        if (c === ' ' || c === '{' || c === '}' || c === '#' || c === '~') compat = true;
        if (style === 'shell-always' && elide) force();
        break;
      }
      case "'":
        encounteredSingleQuote = true;
        compat = true;
        if (style === 'shell-always') {
          if (elide) force();
          store += "'\\'";
        }
        break;
      default:
        if (SAFE.test(c)) {
          compat = true;
          break;
        }
        {
          const cp = c.codePointAt(0) as number;
          const printable = isPrintable(c);
          compat = printable;
          const bytes = utf8(cp);
          if (bytes.length > 1 || (backslashEscapes && !printable)) {
            if (backslashEscapes && !printable) {
              // Every byte as an octal escape; they reach store_c as one unit.
              let digits = '';
              for (const b of bytes) {
                store += digits;
                startEsc();
                store += String((b >> 6) & 7) + String((b >> 3) & 7);
                digits = String(b & 7);
              }
              c = digits;
            } else if (isRightQuote) {
              store += '\\';
              isRightQuote = false;
            }
            action = 'store';
          }
        }
    }

    if (action === 'check') {
      const inExtra = extra !== undefined && extra.includes(c);
      if (!((((backslashEscapes && style !== 'shell-always') || elide) && inExtra) || isRightQuote)) action = 'store';
      else action = 'escape';
    }
    if (action === 'escape') startEsc();
    // store_c: what the case stored, END_ESC, the character.
    if (!compat) allCompat = false;
    out += store;
    if (pendingShellEscapeEnd && !escaping) {
      out += "''";
      pendingShellEscapeEnd = false;
    }
    out += c;
  }

  if (out === '' && style === 'shell-always' && elide) force();
  if (style === 'shell-always' && !elide && encounteredSingleQuote && allCompat) return restyled(arg, 'c', false, extra);
  if (quoteString !== '' && !elide) out += quoteString;
  return out;
}

/** quotearg_buffer: `name` quoted in the given style. */
export function quotearg(name: string, opts: QuotingOptions): string {
  let style: Internal = opts.style;
  let elide = false;
  let extra = opts.extra;
  for (;;) {
    try {
      return restyled(name, style, elide, extra);
    } catch (e) {
      if (!(e instanceof Restart)) throw e;
      // force_outer_quoting_style: quote the whole name, without the extra characters.
      style = e.style;
      elide = false;
      extra = undefined;
    }
  }
}

/** Display width of a character (wcwidth): 0 for combining marks, 2 for East Asian wide ones. */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) as number;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (/[\p{Mn}\p{Me}]/u.test(ch) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x1160 && cp <= 0x11ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** mbsnwidth: the columns a string takes; control characters take none. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Bytes of a string in UTF-8. */
export function byteLength(s: string): number {
  let n = 0;
  for (const ch of s) n += utf8(ch.codePointAt(0) as number).length;
  return n;
}

/**
 * -q: each unprintable character becomes `?` (quote_name_buf). It applies after quoting in the
 * styles that cannot escape characters themselves.
 */
export function hideControlChars(s: string): string {
  let out = '';
  for (const ch of s) out += isPrintable(ch) ? ch : '?';
  return out;
}
