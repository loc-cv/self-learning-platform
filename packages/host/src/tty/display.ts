// Where the prompt and the line being edited land on the screen, and the bytes that redraw them.
// The screen is the terminal's; the engine keeps none (docs/ARCHITECTURE.md §3.6). The editor knows
// what it drew last, so it can compute where the cursor is and redraw from the start of the line.
//   reference: readline 8.2 redisplay in bash 5.2.21, fixtures/reference/bash/readline.json
//   (the visible result is matched; readline's exact choice of cursor sequences is not)
//   docs: xterm ctlseqs (CUU `ESC [ n A`, CUD `ESC [ n B`, CUF `ESC [ n C`, EL `ESC [ K`, ED `ESC [ J`)

import { wcwidth } from '../programs/lib/wcwidth.ts';

export interface Pos {
  row: number;
  col: number;
}

/** A prompt split for display: lines before the last, and the last line raw and as seen. */
export interface PromptParts {
  /** Everything before the last line, with its newlines; drawn once per read. */
  head: string;
  /** The last line as written to the terminal (non-printing parts kept, markers removed). */
  raw: string;
  /** The last line's printing characters only, for widths. */
  plain: string;
}

/** Splits a prompt with readline's \x01…\x02 markers around non-printing parts. */
export function promptParts(prompt: string): PromptParts {
  const nl = prompt.lastIndexOf('\n');
  const head = nl < 0 ? '' : prompt.slice(0, nl + 1);
  const last = nl < 0 ? prompt : prompt.slice(nl + 1);
  let raw = '';
  let plain = '';
  let hidden = false;
  for (const ch of last) {
    if (ch === '\x01') hidden = true;
    else if (ch === '\x02') hidden = false;
    else {
      raw += ch;
      if (!hidden) plain += ch;
    }
  }
  return { head: head.split('\x01').join('').split('\x02').join(''), raw, plain };
}

/** How readline shows a character of the line: control characters as ^X, a tab as spaces. */
export function displayChar(ch: string, col: number): string {
  const c = ch.charCodeAt(0);
  if (ch === '\t') return ' '.repeat(8 - (col % 8));
  if (c === 0x7f) return '^?';
  if (c < 0x20 && ch !== '\n') return `^${String.fromCharCode(c + 0x40)}`;
  return ch;
}

export interface Layout {
  /** Start position of each UTF-16 index of the text; the entry at `text.length` is the end. */
  at: Pos[];
  /** What to write for the text, starting where the prompt ends. */
  out: string;
}

/**
 * Lays out prompt and text the way the terminal will place them: wrapping at the right margin
 * (a wide character that does not fit moves to the next row), a newline in the text starting a
 * row. A position whose column equals `cols` is the terminal's pending-wrap state.
 */
export function layout(promptPlain: string, text: string, cols: number, highlight?: [number, number]): Layout {
  let row = 0;
  let col = 0;
  const advance = (w: number): void => {
    if (col + w > cols) {
      row++;
      col = 0;
    }
    col += w;
  };
  for (const ch of promptPlain) advance(wcwidth(ch));
  const at: Pos[] = [];
  let out = '';
  let i = 0;
  for (const ch of text) {
    if (highlight && i === highlight[0] && highlight[1] > highlight[0]) out += '\x1b[7m';
    const here = normalize({ row, col }, cols);
    at[i] = here;
    if (ch.length === 2) at[i + 1] = here;
    if (ch === '\n') {
      out += '\r\n';
      row++;
      col = 0;
    } else {
      const shown = displayChar(ch, col);
      for (const d of shown) advance(wcwidth(d));
      out += shown;
    }
    i += ch.length;
    if (highlight && i === highlight[1] && highlight[1] > highlight[0]) out += '\x1b[27m';
  }
  at[i] = { row, col };
  return { at, out };
}

/** The cursor's real place for a layout position: past the margin means the next row. */
export function normalize(p: Pos, cols: number): Pos {
  return p.col >= cols ? { row: p.row + 1, col: 0 } : p;
}

/** Relative cursor movement from `a` to `b` (both normalized, `b` on a row already drawn). */
export function move(a: Pos, b: Pos): string {
  let out = '';
  if (b.row < a.row) out += b.row === a.row - 1 ? '\x1b[A' : `\x1b[${a.row - b.row}A`;
  else if (b.row > a.row) out += b.row === a.row + 1 ? '\x1b[B' : `\x1b[${b.row - a.row}B`;
  if (b.col === a.col) return out;
  if (b.col === 0) return `${out}\r`;
  if (b.col < a.col) return out + (a.col - b.col <= 4 ? '\b'.repeat(a.col - b.col) : `\x1b[${a.col - b.col}D`);
  return out + (b.col - a.col === 1 ? '\x1b[C' : `\x1b[${b.col - a.col}C`);
}
