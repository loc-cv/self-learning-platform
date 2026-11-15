// A minimal terminal screen: what an xterm shows after receiving some bytes. Tests compare the
// screen the simulator's output produces with the screen real bash's output produces, and script
// mode (`npm run sim`) prints it. It is not part of the engine's behavior: nothing in the engine
// reads terminal output back (docs/ARCHITECTURE.md §3.6).
//
// Covered: printable characters with wide characters and xterm's deferred wrap at the right margin,
// CR, LF, BS, BEL, TAB, CSI cursor movement (A B C D G H f d), erase in line and display (K J),
// insert and delete characters (@ P),
// scrolling at the bottom, and scrollback (lines that scroll off the top are kept). SGR, mode
// changes (`?2004h`), OSC strings (window titles) and other sequences are consumed and ignored.
//   docs: xterm ctlseqs, https://invisible-island.net/xterm/ctlseqs/ctlseqs.html

import { wcwidth } from '../programs/lib/wcwidth.ts';

export interface Screen {
  /** Feeds output bytes. */
  write(data: string): void;
  /** Visible rows, trailing spaces removed. */
  lines(): string[];
  /** Scrollback and visible rows, trailing spaces and trailing empty rows removed. */
  text(): string;
  readonly cursor: { row: number; col: number };
  /** Bell characters received. */
  readonly bells: number;
  resize(cols: number, rows: number): void;
}

const WIDE_PAD = '\u0000';

export function createScreen(cols = 80, rows = 24): Screen {
  let width = cols;
  let height = rows;
  const blank = (): string[] => Array.from({ length: width }, () => ' ');
  let grid: string[][] = Array.from({ length: height }, blank);
  const scrollback: string[] = [];
  let row = 0;
  let col = 0;
  /** xterm's deferred wrap: the last column was written and the next printable wraps first. */
  let pending = false;
  let bells = 0;
  let esc = '';

  const lineText = (cells: string[]): string => cells.filter((c) => c !== WIDE_PAD).join('').replace(/ +$/, '');

  const scroll = (): void => {
    scrollback.push(lineText(grid.shift() as string[]));
    grid.push(blank());
  };
  const lineFeed = (): void => {
    if (row === height - 1) scroll();
    else row++;
  };
  const put = (ch: string): void => {
    const w = wcwidth(ch);
    if (w === 0) return;
    if (pending || col + w > width) {
      col = 0;
      lineFeed();
      pending = false;
    }
    const r = grid[row] as string[];
    r[col] = ch;
    if (w === 2 && col + 1 < width) r[col + 1] = WIDE_PAD;
    col += w;
    if (col >= width) {
      col = width - 1;
      pending = true;
    }
  };
  const clamp = (): void => {
    row = Math.max(0, Math.min(height - 1, row));
    col = Math.max(0, Math.min(width - 1, col));
    pending = false;
  };
  const eraseLine = (from: number, to: number): void => {
    const r = grid[row] as string[];
    for (let c = from; c < to; c++) r[c] = ' ';
  };

  const csi = (seq: string): void => {
    const final = seq[seq.length - 1] as string;
    const body = seq.slice(0, -1);
    if (body.startsWith('?') || body.startsWith('>') || body.startsWith('=')) return; // modes
    const args = body.split(';').map((a) => (a === '' ? undefined : Number(a)));
    const n = (i: number, d = 1): number => {
      const v = args[i];
      return v === undefined || Number.isNaN(v) || v === 0 ? d : v;
    };
    switch (final) {
      case 'A':
        row -= n(0);
        clamp();
        return;
      case 'B':
        row += n(0);
        clamp();
        return;
      case 'C':
        col += n(0);
        clamp();
        return;
      case 'D':
        col -= n(0);
        clamp();
        return;
      case 'G':
        col = n(0) - 1;
        clamp();
        return;
      case 'd':
        row = n(0) - 1;
        clamp();
        return;
      case 'H':
      case 'f':
        row = n(0) - 1;
        col = n(1) - 1;
        clamp();
        return;
      case '@': {
        // ICH: insert blanks at the cursor, shifting the rest of the row right.
        const r = grid[row] as string[];
        const k = Math.min(n(0), width - col);
        r.splice(col, 0, ...Array.from({ length: k }, () => ' '));
        r.length = width;
        pending = false;
        return;
      }
      case 'P': {
        // DCH: delete characters at the cursor, shifting the rest of the row left.
        const r = grid[row] as string[];
        const k = Math.min(n(0), width - col);
        r.splice(col, k);
        while (r.length < width) r.push(' ');
        pending = false;
        return;
      }
      case 'K': {
        const mode = args[0] ?? 0;
        if (mode === 0) eraseLine(col, width);
        else if (mode === 1) eraseLine(0, col + 1);
        else eraseLine(0, width);
        pending = false;
        return;
      }
      case 'J': {
        const mode = args[0] ?? 0;
        if (mode === 0) {
          eraseLine(col, width);
          for (let r = row + 1; r < height; r++) grid[r] = blank();
        } else if (mode === 1) {
          eraseLine(0, col + 1);
          for (let r = 0; r < row; r++) grid[r] = blank();
        } else if (mode === 2) {
          grid = Array.from({ length: height }, blank);
        } else if (mode === 3) {
          scrollback.length = 0;
        }
        pending = false;
        return;
      }
      default:
        return; // SGR and everything else: no effect on the text
    }
  };

  const write = (data: string): void => {
    for (const ch of data) {
      if (esc !== '') {
        esc += ch;
        if (esc === '\x1b[') continue;
        if (esc.startsWith('\x1b]')) {
          // OSC: ends with BEL or ST (ESC \)
          if (ch === '\x07' || esc.endsWith('\x1b\\')) esc = '';
          continue;
        }
        if (esc.startsWith('\x1b[')) {
          const c = ch.charCodeAt(0);
          if (c >= 0x40 && c <= 0x7e) {
            csi(esc.slice(2));
            esc = '';
          }
          continue;
        }
        if (esc.length === 2) {
          if (ch === ']' || ch === '[') continue;
          if (ch === '(' || ch === ')' || ch === '#') continue; // charset designation: one more byte
          esc = '';
          continue;
        }
        esc = ''; // the byte after a charset designation
        continue;
      }
      switch (ch) {
        case '\x1b':
          esc = ch;
          continue;
        case '\r':
          col = 0;
          pending = false;
          continue;
        case '\n':
        case '\x0b':
        case '\x0c':
          lineFeed();
          pending = false;
          continue;
        case '\b':
          // From the pending-wrap state the cursor is on the last column, and moves left of it.
          pending = false;
          if (col > 0) col--;
          continue;
        case '\x07':
          bells++;
          continue;
        case '\t': {
          const next = Math.min(width - 1, (Math.floor(col / 8) + 1) * 8);
          col = next;
          pending = false;
          continue;
        }
        default:
          if (ch.charCodeAt(0) < 0x20 || ch === '\x7f') continue;
          put(ch);
      }
    }
  };

  return {
    write,
    lines: () => grid.map(lineText),
    text() {
      const all = [...scrollback, ...grid.map(lineText)];
      while (all.length > 0 && all[all.length - 1] === '') all.pop();
      return all.join('\n');
    },
    get cursor() {
      return { row, col: pending ? width : col };
    },
    get bells() {
      return bells;
    },
    resize(c, r) {
      const next: string[][] = [];
      for (let i = 0; i < r; i++) {
        const old = grid[i + Math.max(0, height - r)] ?? blank();
        next.push(Array.from({ length: c }, (_, j) => old[j] ?? ' '));
      }
      if (r < height) {
        for (let i = 0; i < height - r; i++) scrollback.push(lineText(grid[i] as string[]));
        row = Math.max(0, row - (height - r));
      }
      width = c;
      height = r;
      grid = next;
      clamp();
    },
  };
}
