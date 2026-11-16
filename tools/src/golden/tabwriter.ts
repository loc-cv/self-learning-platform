// kubectl's column alignment and its inverse.
//
// kubectl aligns tables with a tab writer: `get` with github.com/liggitt/tabwriter (a fork of Go's
// text/tabwriter that adds RememberWidths), `describe` with Go's text/tabwriter. A column's width
// depends on every value in it, so replacing a volatile value with a token changes the layout.
// Normalization therefore splits captured text back into cells, replaces values cell by cell, and
// renders the cells again with the same algorithm: as if the real tab writer had printed tokens.
//
// upstream: staging/src/k8s.io/cli-runtime/pkg/printers/tabwriter.go GetNewTabWriter
//   (minwidth 6, tabwidth 4, padding 3, ' ', RememberWidths)
// upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go tabbedString (0, 8, 2, ' ', 0)
// upstream: github.com/liggitt/tabwriter@v0.0.0-20181228230101-89fcab3d43de tabwriter.go
//   Writer.format, Writer.writeLines, Writer.Write (a line with one cell flushes)
//
// The writer itself is the engine's (packages/k8s/src/kubectl/printers/tabwriter.ts): kubectl
// prints through it, normalization re-renders with it. This file adds the inverse, `parse`.
//
// RememberWidths only shows when one writer is flushed several times (kubectl get --watch, or a
// table of more than 100 rows). `kubectl get` resets the remembered widths when it moves to the
// next resource (get.go Run: SetRememberedWidths(nil)): in a captured `kubectl get all` the second
// table is narrower than the first (fixtures/golden/v1.37.2/deployments/create-and-read.yaml). A
// captured output is re-rendered in one flush, so the parameters for captured tables leave it off.

import { render, type Cells, type TabWriterParams } from '@simlab/k8s';

export { render, type Cells };

export interface TabParams extends TabWriterParams {
  /**
   * Every table starts with a header row whose cells start where the columns start (kubectl get).
   * Rows are then cut at those positions, which keeps empty cells (SUBOBJECT in events -o wide).
   */
  headerColumns: boolean;
}

export const GET_TABLE: TabParams = { minwidth: 6, padding: 3, rememberWidths: false, headerColumns: true };
export const DESCRIBE: TabParams = { minwidth: 0, padding: 2, rememberWidths: false, headerColumns: false };

const width = (s: string) => [...s].length;

interface Run {
  /** Spaces before the text. */
  lead: number;
  text: string;
}

/** Splits a line at runs of at least `sep` spaces. */
function runs(line: string, sep: number): { lead: number; parts: Run[]; trail: number } {
  const lead = /^ */.exec(line)?.[0].length ?? 0;
  const body = line.slice(lead);
  const trail = /( *)$/.exec(body)?.[1]?.length ?? 0;
  const core = body.slice(0, body.length - trail);
  const parts: Run[] = [];
  const re = new RegExp(` {${sep},}`, 'g');
  let last = 0;
  let gap = 0;
  for (const m of core.matchAll(re)) {
    parts.push({ lead: gap, text: core.slice(last, m.index) });
    gap = m[0].length;
    last = m.index + m[0].length;
  }
  if (core !== '' || parts.length > 0) parts.push({ lead: gap, text: core.slice(last) });
  return { lead, parts, trail };
}

/**
 * Splits text printed by a tab writer back into cells. Cells are separated by runs of at least
 * `padding` spaces. Leading spaces are an indent of the first cell, unless the text after them
 * starts exactly where the previous line's second cell starts: then the first cell is empty (a
 * continuation line, such as a second label under `Labels:`). A trailing run of at least
 * `padding` spaces ends a padded cell followed by an empty last cell.
 *
 * This is a model, not an inverse: `parse` returns undefined when rendering its result does not
 * reproduce the text exactly, and the caller must then not re-align that output.
 */
export function parse(text: string, p: TabParams): Cells[] | undefined {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const { lines, starts } = split(text, p);
  if (render(lines, p) === body + '\n') return lines;
  // A format like "%v \t%v \n" (describe's Conditions) puts spaces at the end of a cell's text,
  // which splitting cannot see: give a column block's cells the width its layout shows.
  restoreTrailingSpaces(lines, starts, p, 0, lines.length, 0);
  return render(lines, p) === body + '\n' ? lines : undefined;
}

/** Walks column blocks as Writer.format does; widens cells whose block is wider than they explain. */
function restoreTrailingSpaces(lines: Cells[], starts: number[][], p: TabParams, line0: number, line1: number, column: number): void {
  for (let i = line0; i < line1; i++) {
    if (column >= (lines[i] as Cells).length - 1 || (lines[i] as Cells).length === 1) continue;
    const b0 = i;
    while (i < line1 && column < (lines[i] as Cells).length - 1 && (lines[i] as Cells).length > 1) i++;
    let shown = 0;
    let widest = 0;
    for (let k = b0; k < i; k++) {
      const at = starts[k] as number[];
      shown = Math.max(shown, (at[column + 1] as number) - (at[column] as number));
      widest = Math.max(widest, width((lines[k] as Cells)[column] as string));
    }
    const extra = shown - widest - p.padding;
    if (extra > 0 && shown > p.minwidth) for (let k = b0; k < i; k++) (lines[k] as Cells)[column] += ' '.repeat(extra);
    restoreTrailingSpaces(lines, starts, p, b0, i, column + 1);
    i--;
  }
}

/** The splitting step of `parse`, without the check. */
export function splitCells(text: string, p: TabParams): Cells[] {
  return split(text, p).lines;
}

/** Cuts each table's rows at the columns its header row shows; tables are separated by blank lines. */
function splitByHeader(body: string, p: TabParams): { lines: Cells[]; starts: number[][] } {
  const lines: Cells[] = [];
  const starts: number[][] = [];
  let cols: number[] | undefined;
  for (const line of body.split('\n')) {
    if (line.trim() === '') {
      cols = undefined;
      lines.push([line]);
      starts.push([0]);
      continue;
    }
    if (!cols) {
      const { parts } = runs(line, p.padding);
      cols = [];
      let at = 0;
      for (const r of parts) {
        at += r.lead;
        cols.push(at);
        at += width(r.text);
      }
    }
    const chars = [...line];
    const cells = cols.map((c, k) => {
      const end = k + 1 < (cols as number[]).length ? (cols as number[])[k + 1] : chars.length;
      const cell = chars.slice(c, end).join('');
      return k + 1 < (cols as number[]).length ? cell.replace(/ +$/, '') : cell;
    });
    lines.push(cells);
    starts.push(cols);
  }
  return { lines, starts };
}

function split(text: string, p: TabParams): { lines: Cells[]; starts: number[][] } {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (p.headerColumns) return splitByHeader(body, p);
  const lines: Cells[] = [];
  const starts: number[][] = []; // column where each cell's text starts
  for (const line of body.split('\n')) {
    const { lead, parts, trail } = runs(line, p.padding);
    const cells: string[] = [];
    const at: number[] = [];
    let col = 0;
    const prevStarts = starts[starts.length - 1];
    if (lead > 0 && parts.length > 0 && prevStarts !== undefined && prevStarts.length > 1 && prevStarts[1] === lead) {
      cells.push('');
      at.push(0);
    }
    parts.forEach((r, k) => {
      col += r.lead;
      if (k === 0 && cells.length === 0) {
        cells.push(' '.repeat(lead) + r.text);
        at.push(0);
        col += lead + width(r.text);
      } else {
        if (k === 0) col += lead;
        cells.push(r.text);
        at.push(col);
        col += width(r.text);
      }
    });
    if (parts.length === 0) {
      cells.push(' '.repeat(lead + trail));
      at.push(0);
    } else if (trail >= p.padding) {
      cells.push('');
      at.push(col + trail);
    } else if (trail > 0) cells[cells.length - 1] += ' '.repeat(trail);
    lines.push(cells);
    starts.push(at);
  }
  return { lines, starts };
}
