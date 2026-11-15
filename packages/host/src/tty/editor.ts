// The line editor: readline's emacs mode as a state machine over plain data (docs/ARCHITECTURE.md
// §3.6). The terminal actor runs it while a program reads a line with editing; each key changes
// the state and produces the bytes that redraw the line. Nothing here keeps a frame, so a shell at
// its prompt stays quiescent.
//
// Ground truth: readline 8.2 in bash 5.2.21 without an inputrc, captured key by key in
// fixtures/reference/bash/readline.json (the differential test is editor.reference.test.ts); key
// bindings from fixtures/reference/bash/bind-p.txt (bindings.ts); behaviour from readline(3).
// Commands readline binds that are not implemented print a `[sim]` notice, never a guess.

import type { EditRequest, LineEditorState } from '../proc/types.ts';
import { BINDINGS } from './bindings.ts';
import { commonPrefix, findWord, printablePart, quoteMatch, textWidth, type CompletionResult } from './complete.ts';
import { layout, move, normalize, promptParts, type Pos } from './display.ts';
import { keyName, splitKeys } from './keys.ts';

export interface EditorIo {
  cols: number;
  rows: number;
  /** State that outlives one line (the kill ring, the last search string); updated in place. */
  readline: { kill: string; lastSearch: string };
  /** The matches for the word at `point`, from the reader's completer. */
  complete(line: string, point: number, word: { start: number; word: string; quote?: "'" | '"' }): CompletionResult | undefined;
  /** Records a gap and returns the notice text to show (`[sim] …` lines, styled for a terminal). */
  unsupported(what: string): string;
}

export interface EditorStep {
  state: LineEditorState;
  out: string;
  /** Input left after the line was completed: typeahead for the next reader. */
  rest: string;
}

/** completion-query-items (bind -v: 100): at or above it, listing asks first. */
const QUERY_ITEMS = 100;

/** Commands that make consecutive kills accumulate in one kill-ring entry. */
const KILLS = new Set(['kill-line', 'unix-line-discard', 'unix-word-rubout', 'kill-word', 'backward-kill-word', 'backward-kill-line']);

type S = { -readonly [K in keyof LineEditorState]: LineEditorState[K] };

export function startEditor(req: EditRequest, pid: string, typeahead: string, io: EditorIo): EditorStep {
  const s: S = { pid, prompt: req.prompt, buffer: '', cursor: 0, history: req.history, hist: req.history.length, edits: {}, keys: '' };
  if (req.completer) s.completer = req.completer;
  const parts = promptParts(s.prompt);
  let out = parts.head.replace(/\n/g, '\r\n') + parts.raw;
  const fed = feed(s, typeahead, io);
  out += fed.out;
  return { state: fed.state, out, rest: fed.rest };
}

/** Feeds input bytes to the editor. */
export function feed(state: LineEditorState, data: string, io: EditorIo): EditorStep {
  const s: S = { ...state, edits: { ...state.edits } };
  const ed = new Run(s, io);
  const { keys, rest } = splitKeys(s.keys + data);
  s.keys = '';
  for (let i = 0; i < keys.length; i++) {
    if (s.done) {
      return { state: freeze(s), out: ed.out, rest: keys.slice(i).join('') + rest };
    }
    let key = keys[i] as string;
    // Ctrl-X is a prefix (bind -p: \C-x\C-e, \C-x\C-u, …): it takes the next key with it.
    if (key === '\x18') {
      const next = keys[i + 1];
      if (next === undefined) {
        s.keys = key + rest;
        return { state: freeze(s), out: ed.out, rest: '' };
      }
      key += next;
      i++;
    }
    const again = ed.key(key);
    if (again !== '') {
      const more = splitKeys(again);
      keys.splice(i + 1, 0, ...more.keys);
    }
  }
  if (s.done) return { state: freeze(s), out: ed.out, rest };
  s.keys = rest;
  return { state: freeze(s), out: ed.out, rest: '' };
}

/**
 * Ctrl-C while editing: readline echoes `^C` where the cursor is (echo-control-characters on) and
 * bash starts a new line; the line is discarded. The caller sends SIGINT.
 */
export function interrupt(): string {
  return '^C\r\n';
}

/** Redraws after a change of terminal width (readline does this on SIGWINCH). */
export function resize(state: LineEditorState, oldCols: number, io: EditorIo): EditorStep {
  const s: S = { ...state };
  const ed = new Run(s, { ...io, cols: oldCols });
  const from = ed.cursorPos();
  ed.io = io;
  ed.out += move(from, { row: 0, col: from.col }) + '\r';
  ed.drawFrom0();
  return { state: freeze(s), out: ed.out, rest: '' };
}

function freeze(s: S): LineEditorState {
  return s as LineEditorState;
}

const hasControl = (t: string): boolean => Array.from(t).some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\x7f');
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n';

/** Code point boundaries: the previous and next positions from `i`. */
function prevIndex(s: string, i: number): number {
  if (i <= 0) return 0;
  const c = s.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}
function nextIndex(s: string, i: number): number {
  if (i >= s.length) return s.length;
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? i + 2 : i + 1;
}

/** The words of a history line for yank-last-arg: blanks separate words, quotes keep them together. */
function historyWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) {
      cur += ch;
      if (ch === q) q = undefined;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[++i];
    } else if (isSpace(ch)) {
      if (cur !== '') words.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') words.push(cur);
  return words;
}

class Run {
  out = '';
  s: S;
  io: EditorIo;
  constructor(s: S, io: EditorIo) {
    this.s = s;
    this.io = io;
  }

  // ---- display ---------------------------------------------------------------------------------

  private view(): { plain: string; raw: string; highlight?: [number, number] } {
    const s = this.s;
    if (s.search) {
      const p = `(${s.search.failed ? 'failed ' : ''}reverse-i-search)\`${s.search.query}': `;
      if (!s.search.failed && s.search.query !== '') {
        return { plain: p, raw: p, highlight: [s.search.pos, s.search.pos + s.search.query.length] };
      }
      return { plain: p, raw: p };
    }
    const parts = promptParts(s.prompt);
    return { plain: parts.plain, raw: parts.raw };
  }

  cursorPos(): Pos {
    const v = this.view();
    const l = layout(v.plain, this.s.buffer, this.io.cols);
    return normalize(l.at[this.s.cursor] as Pos, this.io.cols);
  }

  /** Writes prompt and line with the cursor at the start of the prompt's last line, then places the cursor. */
  drawFrom0(): void {
    const v = this.view();
    const l = layout(v.plain, this.s.buffer, this.io.cols, v.highlight);
    const end = l.at[this.s.buffer.length] as Pos;
    this.out += v.raw + l.out;
    let at = end;
    if (end.col >= this.io.cols) {
      // At the right margin the terminal waits to wrap; readline writes a space and a carriage
      // return to move the cursor onto the next row (captured: `wrap-exact`).
      this.out += ' \r';
      at = { row: end.row + 1, col: 0 };
    }
    this.out += '\x1b[J';
    this.out += move(at, normalize(l.at[this.s.cursor] as Pos, this.io.cols));
  }

  /** Redraws after a change: from where the cursor was to the start of the line, then everything. */
  private redraw(from: Pos): void {
    this.out += move(from, { row: 0, col: from.col });
    if (from.col !== 0) this.out += '\r';
    this.drawFrom0();
  }

  /** Applies a change to buffer and cursor and redraws as little as is simple. */
  private change(buffer: string, cursor: number): void {
    const s = this.s;
    const from = this.cursorPos();
    const oldBuffer = s.buffer;
    const oldCursor = s.cursor;
    s.buffer = buffer;
    s.cursor = cursor;
    if (buffer === oldBuffer) {
      this.out += move(from, this.cursorPos());
      return;
    }
    // Typing at the end of the line: just the new characters.
    if (oldCursor === oldBuffer.length && cursor === buffer.length && buffer.startsWith(oldBuffer) && !hasControl(buffer.slice(oldBuffer.length))) {
      const v = this.view();
      const l = layout(v.plain, buffer, this.io.cols);
      const end = l.at[buffer.length] as Pos;
      this.out += buffer.slice(oldBuffer.length);
      if (end.col >= this.io.cols) this.out += ' \r';
      return;
    }
    this.redraw(from);
  }

  private bell(): void {
    this.out += '\x07';
  }

  /** Shows text below the line (a list, a notice), then draws the prompt and line again. */
  private below(text: string, redraw = true): void {
    this.out += move(this.cursorPos(), this.endPos());
    this.out += '\r\n' + text.replace(/\r?\n/g, '\r\n');
    if (redraw) {
      this.out += '\r\n';
      this.drawFrom0();
    }
  }

  private endPos(): Pos {
    const v = this.view();
    const l = layout(v.plain, this.s.buffer, this.io.cols);
    return normalize(l.at[this.s.buffer.length] as Pos, this.io.cols);
  }

  // ---- history --------------------------------------------------------------------------------

  private lineAt(h: number): string {
    const e = this.s.edits[String(h)];
    if (e !== undefined) return e;
    return h >= this.s.history.length ? '' : (this.s.history[h] as string);
  }

  /** Moves to history line `h`, keeping an edit of the line it leaves (readline's undo lists do the same). */
  private gotoHistory(h: number, cursor?: number): void {
    const s = this.s;
    if (s.buffer !== this.original(s.hist)) s.edits[String(s.hist)] = s.buffer;
    else delete s.edits[String(s.hist)];
    const from = this.cursorPos();
    s.hist = h;
    s.buffer = this.lineAt(h);
    s.cursor = cursor ?? s.buffer.length;
    this.redraw(from);
  }

  private original(h: number): string {
    return h >= this.s.history.length ? '' : (this.s.history[h] as string);
  }

  // ---- keys -----------------------------------------------------------------------------------

  /** Handles one key sequence. Returns bytes to process again as new keys (an unbound sequence's tail). */
  key(key: string): string {
    const s = this.s;
    if (s.ask) {
      this.answer(key);
      return '';
    }
    if (s.search) {
      const handled = this.searchKey(key);
      if (handled) return '';
    }
    const fn = BINDINGS[key];
    if (fn === undefined) {
      if (Array.from(key).length === 1 && key.charCodeAt(0) >= 0x20 && key !== '\x7f') {
        this.run('self-insert', key);
        return '';
      }
      // Unbound: readline rings the bell at the first byte that no binding continues, drops the
      // bytes read so far, and reads what follows as new keys (captured: `\e[4~` inserts `~`).
      let p = 0;
      for (let n = key.length - 1; n > 0; n--) {
        const prefix = key.slice(0, n);
        if (Object.keys(BINDINGS).some((b) => b.startsWith(prefix))) {
          p = n;
          break;
        }
      }
      this.bell();
      s.last = 'unbound';
      return key.slice(p + 1);
    }
    this.run(fn, key);
    return '';
  }

  private run(fn: string, key: string): void {
    const s = this.s;
    const b = s.buffer;
    const c = s.cursor;
    const last = s.last;
    s.last = fn;
    if (fn !== 'yank-last-arg' && fn !== 'insert-last-argument') delete s.lastArg;
    switch (fn) {
      case 'self-insert':
        this.change(b.slice(0, c) + key + b.slice(c), c + key.length);
        return;
      case 'accept-line':
        this.out += move(this.cursorPos(), this.endPos()) + '\r\n';
        s.done = { line: `${b}\n` };
        return;
      case 'beginning-of-line':
        this.change(b, 0);
        return;
      case 'end-of-line':
        this.change(b, b.length);
        return;
      case 'backward-char':
        if (c === 0) this.bell();
        else this.change(b, prevIndex(b, c));
        return;
      case 'forward-char':
        if (c >= b.length) this.bell();
        else this.change(b, nextIndex(b, c));
        return;
      case 'backward-word':
        this.change(b, this.wordStart(c));
        return;
      case 'forward-word':
        this.change(b, this.wordEnd(c));
        return;
      case 'backward-delete-char':
        if (c === 0) this.bell();
        else this.change(b.slice(0, prevIndex(b, c)) + b.slice(c), prevIndex(b, c));
        return;
      case 'delete-char':
        if (b === '' && key === '\x04') {
          // Ctrl-D on an empty line is end of file; bash then prints `logout` or `exit`.
          this.out += '\r\n';
          s.done = { line: null };
        } else if (c >= b.length) this.bell();
        else this.change(b.slice(0, c) + b.slice(nextIndex(b, c)), c);
        return;
      case 'unix-line-discard':
        this.kill(b.slice(0, c), last, 'back');
        this.change(b.slice(c), 0);
        return;
      case 'kill-line':
        this.kill(b.slice(c), last, 'forward');
        this.change(b.slice(0, c), c);
        return;
      case 'backward-kill-line':
        this.kill(b.slice(0, c), last, 'back');
        this.change(b.slice(c), 0);
        return;
      case 'unix-word-rubout': {
        let i = c;
        while (i > 0 && isSpace(b[i - 1])) i--;
        while (i > 0 && !isSpace(b[i - 1])) i--;
        this.kill(b.slice(i, c), last, 'back');
        this.change(b.slice(0, i) + b.slice(c), i);
        return;
      }
      case 'backward-kill-word': {
        const i = this.wordStart(c);
        this.kill(b.slice(i, c), last, 'back');
        this.change(b.slice(0, i) + b.slice(c), i);
        return;
      }
      case 'kill-word': {
        const i = this.wordEnd(c);
        this.kill(b.slice(c, i), last, 'forward');
        this.change(b.slice(0, c) + b.slice(i), c);
        return;
      }
      case 'yank': {
        const k = this.io.readline.kill;
        if (k === '') this.bell();
        else this.change(b.slice(0, c) + k + b.slice(c), c + k.length);
        return;
      }
      case 'transpose-chars': {
        if (c === 0 || b.length < 2) {
          this.bell();
          return;
        }
        const at = c >= b.length ? prevIndex(b, c) : c;
        const before = prevIndex(b, at);
        const after = nextIndex(b, at);
        this.change(b.slice(0, before) + b.slice(at, after) + b.slice(before, at) + b.slice(after), after);
        return;
      }
      case 'clear-screen': {
        const parts = promptParts(s.prompt);
        this.out += '\x1b[H\x1b[2J';
        if (!s.search) this.out += parts.head.replace(/\n/g, '\r\n');
        this.drawFrom0();
        return;
      }
      case 'previous-history':
        if (s.hist === 0) this.bell();
        else this.gotoHistory(s.hist - 1);
        return;
      case 'next-history':
        if (s.hist >= s.history.length) this.bell();
        else this.gotoHistory(s.hist + 1);
        return;
      case 'beginning-of-history':
        if (s.history.length > 0) this.gotoHistory(0);
        return;
      case 'end-of-history':
        this.gotoHistory(s.history.length);
        return;
      case 'history-search-backward':
      case 'history-search-forward': {
        const prefix = b.slice(0, c);
        const step = fn === 'history-search-backward' ? -1 : 1;
        for (let h = s.hist + step; h >= 0 && h <= s.history.length; h += step) {
          const line = this.lineAt(h);
          if (line.startsWith(prefix) && line !== b && (h < s.history.length || prefix === '')) {
            this.gotoHistory(h, c);
            return;
          }
        }
        this.bell();
        return;
      }
      case 'reverse-search-history':
        s.search = { query: '', failed: false, hist: s.hist, pos: c, saved: { buffer: b, cursor: c, hist: s.hist } };
        this.redraw(this.cursorPosWith(false));
        return;
      case 'yank-last-arg':
      case 'insert-last-argument':
        this.yankLastArg();
        return;
      case 'complete':
        this.complete(last);
        return;
      case 'possible-completions':
        this.listCompletions();
        return;
      case 'abort':
        this.bell();
        return;
      default:
        this.unsupported(fn, key);
    }
  }

  private cursorPosWith(search: boolean): Pos {
    const saved = this.s.search;
    if (!search) delete this.s.search;
    const p = this.cursorPos();
    if (saved) this.s.search = saved;
    return p;
  }

  private unsupported(fn: string, key: string): void {
    this.below(this.io.unsupported(`the readline command ${fn} (${keyName(key)})`).replace(/\n$/, ''));
  }

  private kill(text: string, last: string | undefined, dir: 'back' | 'forward'): void {
    if (text === '') return;
    const rl = this.io.readline;
    if (last !== undefined && KILLS.has(last)) rl.kill = dir === 'back' ? text + rl.kill : rl.kill + text;
    else rl.kill = text;
  }

  /** backward-word: to the start of this or the previous word (letters and digits). */
  private wordStart(c: number): number {
    const b = this.s.buffer;
    let i = c;
    while (i > 0 && !isWordChar(b[i - 1])) i--;
    while (i > 0 && isWordChar(b[i - 1])) i--;
    return i;
  }

  private wordEnd(c: number): number {
    const b = this.s.buffer;
    let i = c;
    while (i < b.length && !isWordChar(b[i])) i++;
    while (i < b.length && isWordChar(b[i])) i++;
    return i;
  }

  /** M-. : the last word of the previous history line; again, of the line before, replacing it. */
  private yankLastArg(): void {
    const s = this.s;
    const back = s.lastArg ? s.lastArg.back + 1 : 1;
    const h = s.history.length - back;
    if (h < 0) {
      this.bell();
      return;
    }
    const words = historyWords(this.lineAt(h));
    const word = words[words.length - 1] ?? '';
    let b = s.buffer;
    let start = s.cursor;
    if (s.lastArg) {
      b = b.slice(0, s.lastArg.start) + b.slice(s.lastArg.end);
      start = s.lastArg.start;
    }
    this.change(b.slice(0, start) + word + b.slice(start), start + word.length);
    s.lastArg = { back, start, end: start + word.length };
    s.last = 'yank-last-arg';
  }

  // ---- incremental search (Ctrl-R) --------------------------------------------------------------

  /** Returns true when the key was consumed by the search; false to leave the search and run it normally. */
  private searchKey(key: string): boolean {
    const s = this.s;
    const se = s.search;
    if (!se) return false;
    const fn = BINDINGS[key];
    const printable = Array.from(key).length === 1 && key.charCodeAt(0) >= 0x20 && key !== '\x7f';
    if (printable) {
      const query = se.query + key;
      this.searchFrom(query, se.hist, se.pos);
      return true;
    }
    if (fn === 'reverse-search-history') {
      let query = se.query;
      if (query === '') query = this.io.readline.lastSearch;
      if (query === '') {
        this.bell();
        return true;
      }
      // The next match: earlier in this line, then in older lines.
      this.searchFrom(query, se.hist, se.pos - 1);
      return true;
    }
    if (fn === 'backward-delete-char') {
      if (se.query === '') {
        this.bell();
        return true;
      }
      const query = se.query.slice(0, -1);
      if (query === '') {
        const from = this.cursorPos();
        this.bell();
        this.bell();
        s.search = { ...se, query: '', failed: true, hist: se.saved.hist, pos: se.saved.cursor };
        s.buffer = se.saved.buffer;
        s.cursor = se.saved.cursor;
        s.hist = se.saved.hist;
        this.redraw(from);
        return true;
      }
      this.searchFrom(query, se.saved.hist, se.saved.cursor);
      return true;
    }
    if (fn === 'abort') {
      // Ctrl-G: back to the line as it was before the search.
      const from = this.cursorPos();
      delete s.search;
      s.buffer = se.saved.buffer;
      s.cursor = se.saved.cursor;
      s.hist = se.saved.hist;
      this.redraw(from);
      return true;
    }
    // Any other key ends the search on the found line and then does what it always does.
    const from = this.cursorPos();
    if (se.query !== '') this.io.readline.lastSearch = se.query;
    delete s.search;
    this.redraw(from);
    return false;
  }

  /** The text a search looks at for history position `h`: the typed line for the newest. */
  private searchLine(h: number): string {
    const se = this.s.search;
    if (se && h === se.saved.hist) return se.saved.buffer;
    return this.lineAt(h);
  }

  /**
   * Searches backward for `query`: in line `hist` at positions from `pos` down, then in each older
   * line from its end. A miss keeps the line shown and marks the search failed.
   */
  private searchFrom(query: string, hist: number, pos: number): void {
    const s = this.s;
    const se = s.search;
    if (!se) return;
    const from = this.cursorPos();
    let found: { h: number; at: number } | undefined;
    for (let h = hist; h >= 0 && !found; h--) {
      const line = this.searchLine(h);
      const start = h === hist ? Math.min(pos, line.length - query.length) : line.length - query.length;
      for (let i = start; i >= 0; i--) {
        if (line.startsWith(query, i)) {
          found = { h, at: i };
          break;
        }
      }
    }
    if (!found) {
      this.bell();
      s.search = { ...se, query, failed: true };
      this.redraw(from);
      return;
    }
    s.hist = found.h;
    s.buffer = this.searchLine(found.h);
    s.cursor = found.at;
    s.search = { ...se, query, failed: false, hist: found.h, pos: found.at };
    this.redraw(from);
  }

  // ---- completion -----------------------------------------------------------------------------

  private complete(last: string | undefined): void {
    const s = this.s;
    // A second Tab that follows a Tab which changed nothing lists the matches (readline's
    // rl_complete: rl_last_func == rl_complete && !completion_changed_buffer).
    if (last === 'complete') {
      this.listCompletions();
      s.last = 'complete';
      return;
    }
    const word = findWord(s.buffer, s.cursor);
    const r = this.io.complete(s.buffer, s.cursor, word);
    if (!r || r.matches.length === 0) {
      this.bell();
      s.last = 'complete';
      return;
    }
    const filenames = r.filenames ?? false;
    const b = s.buffer;
    const before = b.slice(0, word.start);
    const after = b.slice(s.cursor);
    const current = b.slice(word.start, s.cursor);
    if (r.matches.length === 1) {
      const m = r.matches[0] as string;
      const dir = r.dirs?.[0] ?? false;
      let ins = quoteMatch(m, word.quote, filenames);
      if (filenames && dir) {
        if (after[0] !== '/') ins += '/';
      } else {
        if (word.quote && filenames) ins += word.quote;
        if (!r.nospace && after === '') ins += ' ';
      }
      this.change(before + ins + after, before.length + ins.length);
      s.last = 'complete-changed';
      return;
    }
    const lcd = commonPrefix(r.matches);
    const ins = quoteMatch(lcd, word.quote, filenames);
    if (lcd.length >= word.word.length && ins !== current && ins.length > 0) {
      this.change(before + ins + after, before.length + ins.length);
      this.bell();
      s.last = 'complete-changed';
      return;
    }
    this.bell();
    s.last = 'complete';
  }

  private listCompletions(): void {
    const s = this.s;
    const word = findWord(s.buffer, s.cursor);
    const r = this.io.complete(s.buffer, s.cursor, word);
    if (!r || r.matches.length === 0) {
      this.bell();
      return;
    }
    const items = r.matches;
    const dirs = r.dirs ?? items.map(() => false);
    if (items.length >= QUERY_ITEMS) {
      this.below(`Display all ${items.length} possibilities? (y or n)`, false);
      s.ask = { kind: 'display', items, dirs, filenames: r.filenames ?? false };
      return;
    }
    this.out += move(this.cursorPos(), this.endPos()) + '\r\n';
    this.printList(items, dirs, r.filenames ?? false);
  }

  /** Prints a list of matches (readline's rl_display_match_list), paging with --More-- if long. */
  private printList(items: readonly string[], dirs: readonly boolean[], filenames: boolean): void {
    const shown = items.map((m, i) => {
      const t = printablePart(m, filenames);
      return { text: t + (filenames && dirs[i] ? '/' : ''), w: textWidth(t) };
    });
    const max = Math.max(...shown.map((x) => x.w)) + 2;
    let limit = Math.floor(this.io.cols / max);
    if (limit !== 1 && limit * max === this.io.cols) limit--;
    if (limit <= 0) limit = 1;
    const count = Math.ceil(shown.length / limit);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      let line = '';
      for (let j = 0; j < limit; j++) {
        const item = shown[i + j * count];
        if (item === undefined) break;
        line += item.text;
        if (j + 1 < limit) {
          const printed = textWidth(item.text);
          line += max <= printed ? ' ' : ' '.repeat(max - printed);
        }
      }
      lines.push(line);
    }
    this.pageLines(lines, 0, 0);
  }

  /** Prints `lines` from `next`; with page-completions on, stops at a screenful with --More--. */
  private pageLines(lines: readonly string[], next: number, shownOnPage: number): void {
    let n = shownOnPage;
    for (let i = next; i < lines.length; i++) {
      if (n >= this.io.rows - 1) {
        this.out += '--More--';
        this.s.ask = { kind: 'more', lines: [...lines], next: i };
        return;
      }
      this.out += `${lines[i] as string}\r\n`;
      n++;
    }
    delete this.s.ask;
    this.drawFrom0();
  }

  /** A key typed while readline asks "Display all …? (y or n)" or shows --More--. */
  private answer(key: string): void {
    const s = this.s;
    const ask = s.ask;
    if (!ask) return;
    const fn = BINDINGS[key];
    if (fn === 'abort') {
      delete s.ask;
      this.out += '\r\n';
      this.bell();
      this.drawFrom0();
      return;
    }
    if (ask.kind === 'display') {
      if (key === 'y' || key === 'Y' || key === ' ') {
        delete s.ask;
        this.out += '\r\n';
        this.printList(ask.items, ask.dirs, ask.filenames);
      } else if (key === 'n' || key === 'N' || key === '\x7f') {
        delete s.ask;
        this.out += '\r\n';
        this.drawFrom0();
      } else this.bell();
      return;
    }
    // --More--: space or y shows a page, Enter one more line, q or n stops.
    const erase = '\r\x1b[K\r';
    if (key === 'y' || key === 'Y' || key === ' ') {
      this.out += erase;
      this.pageLines(ask.lines, ask.next, 0);
    } else if (key === '\r' || key === '\n') {
      this.out += erase;
      this.pageLines(ask.lines, ask.next, this.io.rows - 2);
    } else if (key === 'q' || key === 'Q' || key === 'n' || key === 'N' || key === '\x7f') {
      this.out += erase;
      delete s.ask;
      this.drawFrom0();
    } else this.bell();
  }
}
