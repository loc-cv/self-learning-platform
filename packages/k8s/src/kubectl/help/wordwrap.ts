// The word wrapping kubectl applies to help on a terminal.
// upstream: vendor/github.com/mitchellh/go-wordwrap/wordwrap.go WrapString (v1.0.1), ported
// line by line: lengths count runes, a word longer than the limit is never broken, and the
// spaces at a break are dropped.

const NBSP = 0xa0;

/** Go's unicode.IsSpace: Latin-1 spaces plus the White_Space property above it. */
export function isSpace(cp: number): boolean {
  if (cp <= 0xff) return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0xa0;
  return cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/**
 * `s` wrapped at whitespace so lines stay within `lim` runes where words allow. A `lim` of
 * Infinity leaves the text as it is (kubectl's uint underflow of 0 - 10 when not on a terminal).
 */
export function wrapString(s: string, lim: number): string {
  let buf = '';
  let current = 0;
  let word = '';
  let space = '';
  let wordLen = 0;
  let spaceLen = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '\n') {
      // go-wordwrap also adds to `current` here, but sets it to 0 after the newline anyway
      if (word === '') {
        if (current + spaceLen <= lim) buf += space;
      } else buf += space + word;
      space = '';
      spaceLen = 0;
      word = '';
      wordLen = 0;
      buf += ch;
      current = 0;
    } else if (isSpace(cp) && cp !== NBSP) {
      if (space === '' || word !== '') {
        current += spaceLen + wordLen;
        buf += space + word;
        space = '';
        spaceLen = 0;
        word = '';
        wordLen = 0;
      }
      space += ch;
      spaceLen++;
    } else {
      word += ch;
      wordLen++;
      if (current + wordLen + spaceLen > lim && wordLen < lim) {
        buf += '\n';
        current = 0;
        space = '';
        spaceLen = 0;
      }
    }
  }
  if (word === '') {
    if (current + spaceLen <= lim) buf += space;
  } else buf += space + word;
  return buf;
}

/**
 * The line width kubectl wraps help to on a terminal of `cols` columns, or 0 for no wrapping.
 * upstream: staging/src/k8s.io/kubectl/pkg/util/term/term_writer.go getTerminalLimitWidth
 */
export function terminalLimit(cols: number | undefined): number {
  if (cols === undefined) return 0;
  if (cols >= 120) return 120;
  if (cols >= 100) return 100;
  if (cols >= 80) return 80;
  return 0;
}

/**
 * What one Write through kubectl's responsive writer puts on the stream: wrapped at the limit, or
 * unchanged when the limit is 0. upstream: term_writer.go wordWrapWriter.Write
 */
export function writeWrapped(chunk: string, limit: number): string {
  return limit === 0 ? chunk : wrapString(chunk, limit);
}
