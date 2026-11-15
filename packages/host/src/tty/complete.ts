// Tab completion, readline's half: finding the word to complete, quoting what is inserted, the
// common prefix of several matches, and the layout of a list of matches. What the matches are is
// the program's half (bash's completer in shell/complete.ts, a program's own `complete`).
//   docs: readline(3) "Completing"; bash(1) READLINE "Completing", "Programmable Completion"
//   reference: bash 5.2.21 / readline 8.2 behaviour captured in fixtures/reference/bash/readline.json

import type { Ctx, Json } from '@simlab/kernel';
import type { Contribution } from '@simlab/kernel';
import { wcwidth } from '../programs/lib/wcwidth.ts';

/** Registry kind of completers: what Tab asks for the matches of the word at the cursor. */
export const COMPLETION = 'completion';

export interface CompletionRequest {
  ctx: Ctx;
  machine: string;
  /** The process reading the line: its credentials, working directory and environment apply. */
  pid: string;
  line: string;
  /** Cursor position in `line`. */
  point: number;
  /** Where the word being completed starts, and the word with its quoting removed. */
  start: number;
  word: string;
  /** The quote the word opened and did not close, if any. */
  quote?: "'" | '"';
  /** What the reading program put in its edit request. */
  data: Json;
}

export interface CompletionResult {
  /** Complete words, without quoting, in the order to show them. */
  matches: string[];
  /** The matches are file names: quote them when inserted, mark directories with `/`, list base names. */
  filenames?: boolean;
  /** Parallel to `matches`: which ones are directories (with `filenames`). */
  dirs?: boolean[];
  /** Do not append a space after a single match. */
  nospace?: boolean;
}

export interface CompleterSpec extends Contribution {
  complete(req: CompletionRequest): CompletionResult;
}

/**
 * Characters that end a word for completion, outside quotes.
 * reference: bash 5.2.21 `COMP_WORDBREAKS` default and bash's rl_completer_word_break_characters
 * (bashline.c), checked with `echo "$COMP_WORDBREAKS"` on the workstation, 2026-11-16.
 */
const WORD_BREAKS = ' \t\n"\'@><=;|&(:';

/** Finds the word that ends at `point`, the way readline's _rl_find_completion_word does. */
export function findWord(line: string, point: number): { start: number; word: string; quote?: "'" | '"' } {
  let quote: "'" | '"' | undefined;
  let quoteAt = -1;
  let start = 0;
  for (let i = 0; i < point; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && ch === '\\') i++;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoteAt = i;
      continue;
    }
    if (WORD_BREAKS.includes(ch)) start = i + 1;
  }
  if (quote) start = quoteAt;
  const raw = line.slice(start, point);
  return quote ? { start, word: dequote(raw), quote } : { start, word: dequote(raw) };
}

/** Removes backslashes and quotes, as the shell's quote removal would. */
export function dequote(s: string): string {
  let out = '';
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (q) {
      if (ch === q) q = undefined;
      else if (q === '"' && ch === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1] as string)) out += s[++i];
      else out += ch;
    } else if (ch === '\\' && i + 1 < s.length) out += s[++i];
    else if (ch === "'" || ch === '"') q = ch;
    else out += ch;
  }
  return out;
}

/**
 * Characters bash quotes with a backslash in a completed file name.
 * reference: bash 5.2.21 bashline.c default_filename_quote_characters (observed: `cat my<Tab>`
 * gives `my\ file`, fixtures/reference/bash/readline.json `complete-space-in-name`).
 */
const QUOTE_CHARS = ' \t\n\\"\'@<>=;|&()#$`?*[!:{~';

/** Quotes a match for insertion: inside the user's open quote, or with backslashes. */
export function quoteMatch(text: string, quote: "'" | '"' | undefined, filenames: boolean): string {
  if (!filenames) return text;
  if (quote === "'") return `'${text.replace(/'/g, "'\\''")}`;
  if (quote === '"') return `"${text.replace(/(["$`\\])/g, '\\$1')}`;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    // A leading tilde stays unquoted so that it still expands (bash_quote_filename).
    if (ch === '~' && i === 0) out += ch;
    else out += QUOTE_CHARS.includes(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** The longest common prefix of the matches (readline's lowest common denominator). */
export function commonPrefix(matches: readonly string[]): string {
  if (matches.length === 0) return '';
  let p = matches[0] as string;
  for (const m of matches) {
    let i = 0;
    while (i < p.length && i < m.length && p[i] === m[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) < 0x20 || ch === '\x7f' ? 2 : wcwidth(ch);
  return w;
}

/** What a list shows for a match: the part after the last slash for file names. */
export function printablePart(match: string, filenames: boolean): string {
  if (!filenames) return match;
  const t = match.endsWith('/') ? match.slice(0, -1) : match;
  const i = t.lastIndexOf('/');
  return i < 0 ? match : match.slice(i + 1);
}
