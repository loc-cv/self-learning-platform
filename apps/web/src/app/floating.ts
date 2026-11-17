// Geometry of a panel that floats over the workspace (the X-ray, docs/DESIGN.md §7): moving it,
// resizing it from an edge or a corner, and keeping all of it inside the box it floats in.
// Positions are CSS pixels from the top-left corner of that box. Plain functions, no DOM.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** The edges and corners a floating panel is resized from, as compass points. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Smaller than this the X-ray's header no longer holds its tools. */
export const FLOAT_MIN: Size = { w: 320, h: 240 };
/** One press of an arrow key moves or resizes by this much. */
export const FLOAT_STEP = 24;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * The rectangle as it can be shown inside `bounds`: no larger than the box (and no smaller than
 * `min` while the box allows that), then moved until all of it is inside.
 */
export function clampRect(r: Rect, bounds: Size, min: Size = FLOAT_MIN): Rect {
  const w = Math.round(clamp(r.w, Math.min(min.w, bounds.w), bounds.w));
  const h = Math.round(clamp(r.h, Math.min(min.h, bounds.h), bounds.h));
  return { x: Math.round(clamp(r.x, 0, bounds.w - w)), y: Math.round(clamp(r.y, 0, bounds.h - h)), w, h };
}

export function moveRect(r: Rect, dx: number, dy: number, bounds: Size, min: Size = FLOAT_MIN): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, bounds, min);
}

/** Drags `edge` by (dx, dy). The opposite edge stays where it is; the dragged one stops at the box and at the minimum size. */
export function resizeRect(r: Rect, edge: Edge, dx: number, dy: number, bounds: Size, min: Size = FLOAT_MIN): Rect {
  let { x, y, w, h } = clampRect(r, bounds, min);
  const minW = Math.min(min.w, bounds.w);
  const minH = Math.min(min.h, bounds.h);
  if (edge.includes('e')) w = clamp(w + dx, minW, bounds.w - x);
  if (edge.includes('s')) h = clamp(h + dy, minH, bounds.h - y);
  if (edge.includes('w')) {
    const right = x + w;
    x = clamp(x + dx, 0, right - minW);
    w = right - x;
  }
  if (edge.includes('n')) {
    const bottom = y + h;
    y = clamp(y + dy, 0, bottom - minH);
    h = bottom - y;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Where the panel floats the first time: the lower right of the box, over the terminal's empty rows. */
export function defaultFloat(bounds: Size): Rect {
  const margin = 24;
  const w = Math.min(560, bounds.w - 2 * margin);
  const h = Math.min(440, bounds.h - 2 * margin);
  return clampRect({ x: bounds.w - w - margin, y: bounds.h - h - margin, w, h }, bounds);
}
