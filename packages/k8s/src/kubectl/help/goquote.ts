// Go's %q and %#q of strings, which kubectl's and cobra's messages use for arguments.
// upstream: .upstream/go (go1.23.11) src/strconv/quote.go Quote, appendEscapedRune, CanBackquote;
// fmt's %#q backquotes when CanBackquote allows it (fmt/format.go fmtQ). kubectl v1.37.2 is built
// with Go 1.26.10 (.go-version); the outputs of `kubectl help` with a backquote, a tab and a quote
// in the topic were compared with the real binary.

/** strconv.IsPrint: letters, marks, numbers, punctuation, symbols and the ASCII space. */
function isPrint(ch: string): boolean {
  return ch === ' ' || /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(ch);
}

const ESCAPES: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };

/** strconv.Quote: a double-quoted Go string literal. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\ufffd'; // a lone surrogate is not valid UTF-8
    else if (isPrint(ch)) out += ch;
    else if (ESCAPES[ch] !== undefined) out += ESCAPES[ch];
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return out + '"';
}

/** strconv.CanBackquote */
function canBackquote(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0xfeff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    if ((cp < 0x20 && ch !== '\t') || ch === '`' || cp === 0x7f) return false;
  }
  return true;
}

/** fmt's %#q of a string: backquoted when it can be, else %q. */
export function goSharpQuote(s: string): string {
  return canBackquote(s) ? `\`${s}\`` : goQuote(s);
}

/** fmt's %#q of a []string: "[" elements joined by spaces "]". */
export function goSharpQuoteSlice(xs: readonly string[]): string {
  return `[${xs.map(goSharpQuote).join(' ')}]`;
}
