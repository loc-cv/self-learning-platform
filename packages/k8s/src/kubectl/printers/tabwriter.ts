// kubectl's column alignment: github.com/liggitt/tabwriter, a fork of Go's text/tabwriter that
// adds RememberWidths, ported as a writer whose state is plain data (a `kubectl get -w` keeps one
// writer across events, and a process's state must survive a snapshot).
//
// upstream: vendor/github.com/liggitt/tabwriter/tabwriter.go Writer.Write, Writer.flush,
//   Writer.format, Writer.writeLines, Writer.SetRememberedWidths (flags 0 or RememberWidths;
//   no FilterHTML, StripEscape, AlignRight, DiscardEmptyColumns, TabIndent, Debug)
// upstream: staging/src/k8s.io/cli-runtime/pkg/printers/tabwriter.go GetNewTabWriter
//   (minwidth 6, tabwidth 4, padding 3, ' ', RememberWidths)
// upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go tabbedString (0, 8, 2, ' ', 0)
//
// Text is cells terminated by '\t' or '\v' and lines terminated by '\n' or '\f'. A column block
// is a run of lines that have a cell in that column (the last cell of a line, the text before
// its newline, is in no column); its width is the widest cell (in runes) plus padding, at least
// minwidth. A line with a single cell, and '\f', flush what is buffered: the next lines start
// new blocks. With RememberWidths a column never gets narrower than in an earlier flush.
// The Escape character (0xff) cannot occur in a UTF-8 string and is not handled.

export type TabWriterParams = {
  minwidth: number;
  padding: number;
  rememberWidths: boolean;
};

/** The writer `kubectl get` prints tables through. */
export const GET_TABWRITER: TabWriterParams = { minwidth: 6, padding: 3, rememberWidths: true };
/** The writer `kubectl describe` prints through. */
export const DESCRIBE_TABWRITER: TabWriterParams = { minwidth: 0, padding: 2, rememberWidths: false };

type Cell = { text: string; width: number };

export type TabWriterState = {
  params: TabWriterParams;
  /** Lines buffered since the last flush; the last one is the line being written. */
  lines: Cell[][];
  /** The cell being written. */
  cell: string;
  /** Remembered column widths (RememberWidths). */
  maxwidths: number[];
};

export function newTabWriter(params: TabWriterParams): TabWriterState {
  return { params: { ...params }, lines: [[]], cell: '', maxwidths: [] };
}

/** utf8.RuneCount. */
const runes = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

function terminateCell(w: TabWriterState): number {
  const line = w.lines[w.lines.length - 1] as Cell[];
  line.push({ text: w.cell, width: runes(w.cell) });
  w.cell = '';
  return line.length;
}

/** Writes text; returns what the writer emitted (output appears at flushes only). */
export function tabWrite(w: TabWriterState, text: string): string {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\t' && ch !== '\v' && ch !== '\n' && ch !== '\f') continue;
    w.cell += text.slice(start, i);
    start = i + 1;
    const ncells = terminateCell(w);
    if (ch === '\n' || ch === '\f') {
      w.lines.push([]);
      if (ch === '\f' || ncells === 1) out += tabFlush(w);
    }
  }
  w.cell += text.slice(start);
  return out;
}

/** Flush: formats and emits everything buffered, the unterminated last line without a newline. */
export function tabFlush(w: TabWriterState): string {
  if (w.cell.length > 0) terminateCell(w);
  const out = format(w);
  w.lines = [[]];
  w.cell = '';
  return out;
}

/** SetRememberedWidths: `kubectl get` resets them (nil) when it moves to another resource. */
export function setRememberedWidths(w: TabWriterState, widths: readonly number[] | null): void {
  w.maxwidths = widths ? [...widths] : [];
}

function format(w: TabWriterState): string {
  const p = w.params;
  const lines = w.lines;
  const widths: number[] = [];
  let out = '';

  const writeLines = (line0: number, line1: number) => {
    for (let i = line0; i < line1; i++) {
      const line = lines[i] as Cell[];
      line.forEach((c, j) => {
        out += c.text;
        if (j < widths.length) out += ' '.repeat((widths[j] as number) - c.width);
      });
      // The last buffered line is the unterminated one: its pending cell was terminated by flush.
      if (i + 1 < lines.length) out += '\n';
    }
  };

  const fmt = (line0: number, line1: number) => {
    const column = widths.length;
    for (let self = line0; self < line1; self++) {
      if (column >= (lines[self] as Cell[]).length - 1) continue;
      // A block of lines with a cell in this column starts here.
      writeLines(line0, self);
      line0 = self;
      let width = p.minwidth;
      for (; self < line1; self++) {
        const line = lines[self] as Cell[];
        if (column >= line.length - 1) break;
        const cw = (line[column] as Cell).width + p.padding;
        if (cw > width) width = cw;
      }
      if (p.rememberWidths) {
        if (w.maxwidths.length < widths.length) w.maxwidths.push(...widths.slice(w.maxwidths.length));
        if (w.maxwidths.length === widths.length) w.maxwidths.push(width);
        else if ((w.maxwidths[widths.length] as number) > width) width = w.maxwidths[widths.length] as number;
        else if ((w.maxwidths[widths.length] as number) < width) w.maxwidths[widths.length] = width;
      }
      widths.push(width);
      fmt(line0, self);
      widths.pop();
      line0 = self;
    }
    writeLines(line0, line1);
  };

  fmt(0, lines.length);
  return out;
}

/** A line is its cells; the last cell is the text before the newline and is never padded. */
export type Cells = string[];

/** Renders whole lines of cells through a fresh writer, as one flush (each line ends with a newline). */
export function render(lines: readonly Cells[], p: TabWriterParams): string {
  const w = newTabWriter(p);
  let out = '';
  for (const l of lines) out += tabWrite(w, `${l.join('\t')}\n`);
  return out + tabFlush(w);
}
