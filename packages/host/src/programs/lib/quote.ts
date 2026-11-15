// How GNU coreutils 9.4 quotes file names and arguments in messages, in the C.UTF-8 locale.
//   upstream: gnulib quotearg.c (shell_escape_quoting_style, locale_quoting_style, gettext_quote)
//   reference: coreutils 9.4 messages, captured 2026-11-16 — `cat: 'a b': No such file or
//              directory`, `cat: "it's": …`, `ls: invalid argument ‘x’ for ‘--color’`

/** Characters after which a name needs quoting in the shell-escape style. */
const NEEDS_QUOTES = new Set([...' \t\n\v\f\r!"$&\'()*;<=>?[\\]^`{|}']);

const needsQuoting = (s: string): boolean =>
  s === '' || [...s].some((c, i) => NEEDS_QUOTES.has(c) || ((c === '#' || c === '~') && i === 0) || c < ' ' || c === '\x7f');

/** Control characters as $'…' escapes, the way the shell-escape style writes them. */
function escapeControl(c: string): string {
  const named: Record<string, string> = { '\n': 'n', '\t': 't', '\r': 'r', '\v': 'v', '\f': 'f', '\b': 'b', '\x07': 'a' };
  return named[c] !== undefined ? `\\${named[c]}` : `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`;
}

function shellEscape(s: string, always: boolean): string {
  if (!always && !needsQuoting(s)) return s;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for
  if (/[\x00-\x1f\x7f]/.test(s)) {
    // 'a'$'\n''b': quoted runs, with control characters in ANSI-C segments.
    let out = '';
    let run = '';
    const flush = () => {
      if (run !== '') out += `'${run.replace(/'/g, "'\\''")}'`;
      run = '';
    };
    for (const c of s) {
      if (c < ' ' || c === '\x7f') {
        flush();
        out += `$'${escapeControl(c)}'`;
      } else run += c;
    }
    flush();
    return out;
  }
  if (!s.includes("'")) return `'${s}'`;
  // A single quote and nothing that is special inside double quotes: "it's".
  if (!/[\\"$`!]/.test(s)) return `"${s}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** quotef: a file name, quoted only when needed (`cat: nope: …`, `cat: 'a b': …`). */
export function quotef(s: string): string {
  return shellEscape(s, false);
}

/** quoteaf: always quoted (`ls: cannot access 'nope': …`). */
export function quoteaf(s: string): string {
  return shellEscape(s, true);
}

/** quote: the locale's quotation marks, ‘…’ in a UTF-8 locale (`invalid argument ‘x’ for ‘--color’`). */
export function quote(s: string): string {
  return `‘${s}’`;
}
