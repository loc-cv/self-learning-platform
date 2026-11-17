// The renderer (PLAN.md §6.5, docs/DESIGN.md §6): one SVG drawing of any view model, by our own
// code. Containers hold their children; relations are links; state is styling from the tokens;
// change is motion. Every entity is a <g> keyed by its id and placed by a CSS transform, so a
// move, a resize or a change of state is a CSS transition the browser runs, and nothing that did
// not change moves. Entering entities fade in, leaving ones fade out in place (they keep their
// slot until then). With reduced motion every change is instant.
//
// It names no domain: it reads shapes, states and relation types from the view contract.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RelationType, ViewEntity, ViewModel, ViewRelation, ViewState } from '@simlab/kernel';
import { CARD, emptyMemory, FACT_CHAR, FACT_LINE, factLayout, factWidth, fit, layout, type Box, type Layout, type Memory } from './layout.ts';
import { visibility, type ScopeFilter } from './filter.ts';

/** How long a leaving entity stays to fade out (ms); matches --motion-exit in styles.css. */
export const EXIT_MS = 320;
/** How long an arriving entity takes to fade in (ms): --motion-enter. */
export const ENTER_MS = 280;
const MARGIN = 12;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

export interface ViewBoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasHandle {
  fitAll(): void;
  focusSelected(): void;
  zoom(factor: number): void;
}

/** How an entity differs from the other drawing of a pair. */
export type ChangeMark = 'added' | 'removed' | 'changed';

/** What a figure points at: entities to outline, numbered notes, and the differences of a pair. */
export interface CanvasMarks {
  highlight?: readonly string[];
  /** Entity id → the numbers of the notes on it. */
  notes?: Readonly<Record<string, readonly number[]>>;
  changes?: Readonly<Record<string, ChangeMark>>;
}

export interface ViewCanvasProps {
  model: ViewModel;
  filter: ScopeFilter;
  selected?: string;
  onSelect?(id: string | undefined): void;
  reducedMotion: boolean;
  /** Called once with the handle for the toolbar's buttons. */
  handle?(h: CanvasHandle): void;
  label: string;
  /**
   * A still drawing (a figure): as tall as its content at the pane's width, the entities' facts
   * drawn on them, no zoom, pan or selection. Changes of the model still animate (a scene).
   */
  still?: boolean;
  marks?: CanvasMarks;
  /**
   * Causes that travelled from one entity to another, from the trace (a frame's `links`, a
   * selected event's): each is drawn as a mark along the relation that joins the two, or straight
   * across when none does, and travels once along it when it appears, unless motion is reduced
   * (PLAN.md §6.5: motion along a relation is a recorded cause, never decoration).
   */
  links?: readonly { from: string; to: string }[];
  /** Changes when the links appear anew (the next frame), so they travel again. */
  linksKey?: string | number;
}

const CHANGE_GLYPH: Record<ChangeMark, string> = { added: '+', removed: '−', changed: '•' };

const STATE_WORD: Record<ViewState, string> = { healthy: 'healthy', progressing: 'progressing', degraded: 'degraded', failed: 'failed', unknown: 'unknown' };

/** A state glyph, so a state reads without its color (docs/DESIGN.md §5). */
export function Glyph({ state, x, y }: { state: ViewState; x: number; y: number }) {
  const t = `translate(${x} ${y})`;
  switch (state) {
    case 'healthy':
      return <circle className="vglyph" transform={t} r={4} />;
    case 'progressing':
      return <path className="vglyph vglyph-line" transform={t} d="M 0 -4 A 4 4 0 1 1 -4 0" />;
    case 'degraded':
      return <path className="vglyph" transform={t} d="M 0 -4.5 L 4.5 3.5 L -4.5 3.5 Z" />;
    case 'failed':
      return <path className="vglyph vglyph-line" transform={t} d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" />;
    default:
      return <path className="vglyph vglyph-line" transform={t} d="M -3 -2 A 3 3 0 1 1 0.5 1 L 0 2.4 M 0 4.6 L 0 4.8" />;
  }
}

/** The outline of a leaf card by shape: the shape vocabulary's silhouettes. */
function outline(shape: Box['shape'], w: number, h: number): string {
  const r = 7;
  switch (shape) {
    case 'endpoint': {
      // A pill: round ends of a plain card's height; a card made taller by facts keeps them.
      const e = Math.min(h, CARD.h) / 2;
      return `M ${e} 0 H ${w - e} A ${e} ${e} 0 0 1 ${w} ${e} V ${h - e} A ${e} ${e} 0 0 1 ${w - e} ${h} H ${e} A ${e} ${e} 0 0 1 0 ${h - e} V ${e} A ${e} ${e} 0 0 1 ${e} 0 Z`;
    }
    case 'store':
      return `M 0 6 Q 0 0 ${w / 2} 0 Q ${w} 0 ${w} 6 V ${h - 4} Q ${w} ${h} ${w - 4} ${h} H 4 Q 0 ${h} 0 ${h - 4} Z`;
    case 'rule':
      return `M 10 0 H ${w} V ${h - r} Q ${w} ${h} ${w - r} ${h} H 0 V 10 Z`;
    default:
      return `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
  }
}

/**
 * What a container's header line can hold at its width: the label first, then the status, then
 * the kind's name. Widths are estimates from the font size (no text measurement in a layout pass).
 */
function header(w: number, size: number, label: string, status: string, kind: string): { label: string; status: string; kind: string } {
  const avail = w - 38;
  const lw = label.length * size * 0.56;
  const sw = status === '' ? 0 : status.length * 11 * 0.58 + 8;
  const kw = kind === '' ? 0 : kind.length * 9.5 * 0.72 + 8;
  if (lw + sw + kw <= avail) return { label, status, kind };
  if (lw + sw <= avail) return { label, status, kind: '' };
  const left = Math.max(4, Math.floor((avail - sw) / (size * 0.56)));
  return { label: fit(label, left), status, kind: '' };
}

/** A card's second line at its width: the status first, then the kind's name if it still fits. */
function subline(avail: number, status: string, kind: string): { status: string; kind: string } {
  const sw = status.length * 11 * 0.58;
  const kw = kind === '' ? 0 : kind.length * 9.5 * 0.72 + 6;
  if (sw + kw <= avail) return { status, kind };
  return { status: fit(status, Math.floor(avail / (11 * 0.58))), kind: '' };
}

const relKey = (r: ViewRelation): string => `${r.type}:${r.from}>${r.to}`;

/** A link from the bottom of the upper box to the top of the lower one (or side to side). */
function linkPath(a: Box, b: Box): string {
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  if (a.y + a.h <= b.y) {
    const y1 = a.y + a.h;
    const y2 = b.y;
    const m = (y2 - y1) / 2;
    return `M ${ax} ${y1} C ${ax} ${y1 + m} ${bx} ${y2 - m} ${bx} ${y2}`;
  }
  if (b.y + b.h <= a.y) {
    const y1 = a.y;
    const y2 = b.y + b.h;
    const m = (y1 - y2) / 2;
    return `M ${ax} ${y1} C ${ax} ${y1 - m} ${bx} ${y2 + m} ${bx} ${y2}`;
  }
  const left = a.x < b.x;
  const x1 = left ? a.x + a.w : a.x;
  const x2 = left ? b.x : b.x + b.w;
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  const m = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + m} ${y1} ${x2 - m} ${y2} ${x2} ${y2}`;
}

/** Selects and routes to the same target: one link, drawn as a route. */
function links(relations: readonly ViewRelation[]): { r: ViewRelation; type: RelationType | 'selectsOnly' }[] {
  const routed = new Set(relations.filter((r) => r.type === 'routesTo').map((r) => `${r.from}>${r.to}`));
  return relations.filter((r) => !(r.type === 'selects' && routed.has(`${r.from}>${r.to}`))).map((r) => ({ r, type: r.type === 'selects' ? 'selectsOnly' : r.type }));
}

function useWidth(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * Facts as lines, the value in code type and middle-shortened to fit: the label in a column of its
 * own when there is room, otherwise on a line above its values (layout.ts factLayout).
 */
function Facts({ b, x, y, container }: { b: Box; x: number; y: number; container: boolean }) {
  const width = factWidth(b.shape, b.w, container);
  const { labelW, lines } = factLayout(b.entity, width);
  if (lines.length === 0) return null;
  const chars = Math.max(4, Math.floor((width - labelW) / FACT_CHAR.value));
  return (
    <g className="vfacts" transform={`translate(${x} ${y})`}>
      {lines.map((l, i) => (
        <text key={i} className="vfact" y={(i + 1) * FACT_LINE - 3}>
          {l.label ? <tspan className="vfact-label">{l.label}</tspan> : null}
          {l.text ? (
            <tspan className="vfact-value" x={labelW}>
              {fit(l.text, chars)}
            </tspan>
          ) : null}
        </text>
      ))}
    </g>
  );
}

/** The path a cause travels from `a` to `b`: from a container's header down to what it holds, else as a relation is drawn. */
function causePath(a: Box, b: Box): string {
  const inside = (x: Box, y: Box): boolean => x.x >= y.x && x.y >= y.y && x.x + x.w <= y.x + y.w && x.y + x.h <= y.y + y.h;
  if (inside(b, a) || inside(a, b)) {
    const [outer, inner] = inside(b, a) ? [a, b] : [b, a];
    const from = { x: outer.x + outer.w / 2, y: outer.y + 14 };
    const to = { x: inner.x + inner.w / 2, y: inner.y };
    const [p, q] = outer === a ? [from, to] : [{ x: inner.x + inner.w / 2, y: inner.y }, { x: outer.x + outer.w / 2, y: outer.y + 14 }];
    return `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
  }
  return linkPath(a, b);
}

/**
 * Causes along their pairs: a static mark with an arrow at the end, and a stroke that travels it
 * once. Drawn with the relations, behind the cards, so a cause never hides what it reached.
 */
function Causes({ links, byId, arrow }: { links: readonly { from: string; to: string }[]; byId: Map<string, Box>; arrow: string }) {
  const drawn = links.filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);
  if (drawn.length === 0) return null;
  return (
    <g className="vlayer-causes" aria-hidden="true">
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path className="vcause-arrow" d="M 0 0 L 8 4 L 0 8 Z" />
        </marker>
      </defs>
      {drawn.map((l) => {
        const d = causePath(byId.get(l.from) as Box, byId.get(l.to) as Box);
        return (
          <g key={`${l.from}>${l.to}`} className="vcause">
            <path className="vcause-path" d={d} markerEnd={`url(#${arrow})`} />
            <path className="vcause-comet" d={d} pathLength={1} />
          </g>
        );
      })}
    </g>
  );
}

/** Outlines, note numbers and change glyphs, over everything, placed like the boxes they mark. */
function Marks({ boxes, marks }: { boxes: readonly Box[]; marks: CanvasMarks }) {
  const hl = new Set(marks.highlight ?? []);
  return (
    <g className="vlayer-marks" aria-hidden="true">
      {boxes.map((b) => {
        const notes = marks.notes?.[b.id] ?? [];
        const change = marks.changes?.[b.id];
        if (!hl.has(b.id) && notes.length === 0 && !change) return null;
        return (
          <g key={b.id} className="vmark" style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
            {hl.has(b.id) ? <rect className="vmark-highlight" x={-3} y={-3} width={b.w + 6} height={b.h + 6} rx={b.shape === 'endpoint' ? (Math.min(b.h, CARD.h) + 6) / 2 : 12} /> : null}
            {change ? (
              <g className={`vmark-change is-${change}`} transform="translate(0 0)">
                <circle r={8} />
                <text textAnchor="middle" y={4}>
                  {CHANGE_GLYPH[change]}
                </text>
              </g>
            ) : null}
            {notes.map((n, i) => (
              <g key={n} className="vmark-note" transform={`translate(${b.w - 4 - i * 20} 0)`}>
                <circle r={9} />
                <text textAnchor="middle" y={4}>
                  {n}
                </text>
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}

/**
 * The drawing. Memoized: the pages around it render on every message of the worker (the clock,
 * the attempt's log), and a drawing whose props did not change has nothing to redraw.
 */
export const ViewCanvas = memo(function ViewCanvas(props: ViewCanvasProps) {
  const { model, filter, reducedMotion, still = false, marks } = props;
  const arrowId = `vcause-${useId().replace(/[^\w-]/g, '')}`;
  const selected = still ? undefined : props.selected;
  const onSelect = (id: string | undefined): void => props.onSelect?.(id);
  const wrap = useRef<HTMLDivElement>(null);
  const size = useWidth(wrap);
  const memory = useRef<Memory>(emptyMemory());
  const memoryKey = useRef('');
  /** Entities that left, with the real time they go. */
  const [leaving, setLeaving] = useState<Map<string, { e: ViewEntity; until: number }>>(new Map());
  const prev = useRef<Map<string, ViewEntity>>(new Map());
  /** Ids drawn before: only later arrivals animate in. */
  const seen = useRef<Set<string> | undefined>(undefined);
  const visible = useMemo(() => visibility(model, filter), [model, filter]);

  // Entities that disappeared since the last model fade out where they were.
  useEffect(() => {
    const now = performance.now();
    const ids = new Set(model.entities.map((e) => e.id));
    const gone = [...prev.current.values()].filter((e) => !ids.has(e.id) && visible(e));
    prev.current = new Map(model.entities.map((e) => [e.id, e]));
    if (gone.length === 0 || reducedMotion) return;
    setLeaving((l) => {
      const next = new Map(l);
      for (const e of gone) next.set(e.id, { e, until: now + EXIT_MS });
      for (const id of ids) next.delete(id);
      return next;
    });
  }, [model, visible, reducedMotion]);
  useEffect(() => {
    if (leaving.size === 0) return;
    const next = Math.min(...[...leaving.values()].map((x) => x.until));
    const timer = setTimeout(() => {
      const now = performance.now();
      setLeaving((l) => new Map([...l].filter(([, x]) => x.until > now + 5)));
    }, Math.max(0, next - performance.now()));
    return () => clearTimeout(timer);
  }, [leaving]);

  const width = Math.max(0, size.w - 2 * MARGIN);
  // A new filter or width lays everything out afresh; otherwise slots are remembered.
  const key = `${JSON.stringify(filter)}|${Math.round(width / 40)}`;
  if (key !== memoryKey.current) {
    memory.current = emptyMemory();
    memoryKey.current = key;
  }
  // A layout made afresh is drawn where it lies: only a change of the world moves things
  // (docs/DESIGN.md §4), and a pane that got its width, or a new filter, is not one.
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    if (settled === key) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(key));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [key, settled]);
  const lay: Layout = useMemo(
    () => layout({ model, visible, width, facts: still, leaving: new Map([...leaving].map(([id, x]) => [id, x.e])) }, memory.current),
    // memoryKey changes reset the memory above; the layout depends on it through `width` and `filter`.
    [model, visible, width, leaving, still],
  );
  // A still drawing never shrinks while it is shown at one width, so stepping through a scene does
  // not make the page jump. Before the pane has a width there is nothing to measure.
  const stillHeight = useRef({ key: '', h: 0 });
  if (still && size.w > 0) {
    if (stillHeight.current.key !== memoryKey.current) stillHeight.current = { key: memoryKey.current, h: 0 };
    stillHeight.current.h = Math.max(stillHeight.current.h, lay.height + 2 * MARGIN);
  }
  const stillH = stillHeight.current.h;
  const byId = useMemo(() => new Map(lay.boxes.map((b) => [b.id, b])), [lay]);
  if (seen.current === undefined && lay.boxes.length > 0) seen.current = new Set(lay.boxes.map((b) => b.id));
  // Arrivals fade and grow in, with the Web Animations API: a class would be dropped by the next
  // model before its animation ends.
  useLayoutEffect(() => {
    const s = seen.current;
    if (!s) return;
    for (const b of lay.boxes) {
      if (s.has(b.id)) continue;
      s.add(b.id);
      if (reducedMotion || b.leaving) continue;
      const el = wrap.current?.querySelector<SVGGElement>(`[data-id="${CSS.escape(b.id)}"]`);
      el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
  }, [lay, reducedMotion]);

  // The visible part of the drawing (zoom and pan).
  const [vb, setVb] = useState<ViewBoxRect | undefined>(undefined);
  // The stored box gives the corner and the zoom (its width); the height follows the pane as it is
  // now. A pane that changes height (the facts of a selection take more room than the legend) then
  // shows more or less at the bottom, and nothing moves or rescales.
  const view: ViewBoxRect = still
    ? { x: -MARGIN, y: -MARGIN, w: Math.max(1, size.w), h: Math.max(1, stillH) }
    : vb && size.w > 0
      ? { x: vb.x, y: vb.y, w: vb.w, h: Math.max(1, (vb.w * size.h) / size.w) }
      : { x: -MARGIN, y: -MARGIN, w: Math.max(1, size.w), h: Math.max(1, size.h) };
  const zoomOf = (r: ViewBoxRect): number => (size.w > 0 ? size.w / r.w : 1);
  const clampVb = useCallback(
    (r: ViewBoxRect): ViewBoxRect => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, size.w > 0 ? size.w / r.w : 1));
      const w = size.w / z;
      const h = size.h / z;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    },
    [size.w, size.h],
  );
  // A resized pane keeps the zoom it had and refits its width when unzoomed.
  useEffect(() => setVb(undefined), [size.w]);

  const fitAll = useCallback(() => {
    if (size.w === 0) return;
    const w = lay.width + 2 * MARGIN;
    const h = lay.height + 2 * MARGIN;
    const z = Math.min(1, size.w / w, size.h / h);
    setVb({ x: -MARGIN - (size.w / z - w) / 2, y: -MARGIN, w: size.w / z, h: size.h / z });
  }, [lay.width, lay.height, size.w, size.h]);
  const focusSelected = useCallback(() => {
    const b = selected === undefined ? undefined : byId.get(selected);
    if (!b) return;
    const pad = 40;
    const z = Math.min(1.6, size.w / (b.w + 2 * pad), size.h / (b.h + 2 * pad));
    setVb(clampVb({ x: b.x + b.w / 2 - size.w / z / 2, y: b.y + b.h / 2 - size.h / z / 2, w: size.w / z, h: size.h / z }));
  }, [selected, byId, size.w, size.h, clampVb]);
  const zoom = useCallback((f: number) => setVb((r) => clampVb((() => {
    const cur = r ?? view;
    const w = cur.w / f;
    const h = cur.h / f;
    return { x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.h - h) / 2, w, h };
  })())), [clampVb, view]);
  useEffect(() => props.handle?.({ fitAll, focusSelected, zoom }), [props, fitAll, focusSelected, zoom]);

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      return;
    }
    const cur = view;
    const maxY = Math.max(-MARGIN, lay.height + MARGIN - cur.h);
    const y = Math.min(maxY, Math.max(-MARGIN, cur.y + e.deltaY / zoomOf(cur)));
    const maxX = Math.max(-MARGIN, lay.width + MARGIN - cur.w);
    const x = Math.min(maxX, Math.max(-MARGIN - Math.max(0, cur.w - lay.width - 2 * MARGIN), cur.x + e.deltaX / zoomOf(cur)));
    setVb({ ...cur, x, y });
  };
  const drag = useRef<{ x: number; y: number; vb: ViewBoxRect; moved: boolean } | undefined>(undefined);
  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vb: view, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    const z = zoomOf(d.vb);
    setVb({ ...d.vb, x: d.vb.x - dx / z, y: d.vb.y - dy / z });
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current;
    drag.current = undefined;
    if (d && !d.moved && e.target === e.currentTarget) onSelect(undefined);
  };

  // Related entities of the selection are highlighted, the rest recede.
  const related = useMemo(() => {
    if (selected === undefined) return undefined;
    const s = new Set<string>([selected]);
    for (const r of model.relations) {
      if (r.from === selected) s.add(r.to);
      if (r.to === selected) s.add(r.from);
    }
    for (let c = byId.get(selected)?.entity.container; c !== undefined; c = byId.get(c)?.entity.container) s.add(c);
    return s;
  }, [selected, model.relations, byId]);

  /** Arrow keys move the selection to the nearest entity in that direction. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (d) {
      e.preventDefault();
      const cur = selected === undefined ? undefined : byId.get(selected);
      const pool = lay.boxes.filter((b) => !b.leaving && b.id !== selected);
      let best: Box | undefined;
      let bestScore = Infinity;
      for (const b of pool) {
        if (!cur) {
          const s = b.y * 10_000 + b.x;
          if (s < bestScore) [best, bestScore] = [b, s];
          continue;
        }
        const dx = b.x + b.w / 2 - (cur.x + cur.w / 2);
        const dy = b.y + b.h / 2 - (cur.y + cur.h / 2);
        const along = dx * d[0] + dy * d[1];
        if (along <= 1) continue;
        const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
        const s = along + 2 * across;
        if (s < bestScore) [best, bestScore] = [b, s];
      }
      if (best) {
        onSelect(best.id);
        wrap.current?.querySelector<SVGGElement>(`[data-id="${CSS.escape(best.id)}"]`)?.focus({ preventScroll: true });
      }
      return;
    }
    if (e.key === 'Escape' && selected !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(undefined);
    } else if (e.key === '+' || e.key === '=') zoom(1.2);
    else if (e.key === '-') zoom(1 / 1.2);
    else if (e.key === '0') fitAll();
    else if (e.key === 'f' || e.key === 'F') focusSelected();
  };

  const containers = lay.boxes.filter((b) => b.shape === 'host' || b.shape === 'scope').sort((a, b) => a.depth - b.depth);
  const leaves = lay.boxes.filter((b) => b.shape !== 'host' && b.shape !== 'scope');
  const kinds = useMemo(() => new Map(model.kinds.map((k) => [k.kind, k])), [model.kinds]);
  const drawnLinks = links(model.relations).filter(({ r }) => byId.has(r.from) && byId.has(r.to));
  const dim = (id: string): string => (related && !related.has(id) ? ' is-dim' : '');
  const charsFor = (w: number, size: number): number => Math.floor(w / (size * 0.6));

  const entityLabel = (b: Box): string => {
    const k = kinds.get(b.entity.kind);
    return `${k?.label ?? b.entity.kind} ${b.entity.label}: ${b.entity.status ?? STATE_WORD[b.entity.state]}${b.entity.status ? `, ${STATE_WORD[b.entity.state]}` : ''}`;
  };
  const changeClass = (id: string): string => {
    const c = marks?.changes?.[id];
    return c ? ` is-${c}` : '';
  };
  /** A live view's entities are buttons; a still drawing's are parts of one image. */
  const interactive = (b: Box) =>
    still
      ? {}
      : {
          tabIndex: b.leaving ? -1 : 0,
          role: 'button',
          'aria-pressed': selected === b.id,
          'aria-label': entityLabel(b),
          onClick: choose(b.id),
          onKeyDown: choose(b.id),
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        };
  const choose = (id: string) => (e: React.MouseEvent | React.KeyboardEvent) => {
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(selected === id ? undefined : id);
  };

  return (
    <div ref={wrap} className={`vcanvas${still ? ' is-still' : ''}${reducedMotion ? ' motion-reduced' : ''}${settled === key ? '' : ' is-afresh'}`} onKeyDown={still ? undefined : onKeyDown} style={still ? { height: stillH } : undefined}>
      <svg
        role={still ? 'img' : 'group'}
        aria-label={props.label}
        width={size.w}
        height={still ? stillH : size.h}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        {...(still ? {} : { onWheel, onPointerDown, onPointerMove, onPointerUp })}
      >
        <g className="vlayer-lanes">
          {lay.lanes.map((l) => (
            <g key={l.id} className="vlane" style={{ transform: `translate(${l.x}px, ${l.y}px)` }}>
              <rect className="vlane-frame" style={{ width: l.w, height: l.h }} rx={10} />
              <text className="vlane-label" x={12} y={18}>
                {l.label}
              </text>
            </g>
          ))}
        </g>
        <g className="vlayer-containers">
          {containers.map((b) => {
            const k = kinds.get(b.entity.kind);
            const nested = b.depth > 0;
            const head = header(b.w, nested ? 12 : 13, b.entity.label, b.entity.status ?? '', k?.label ?? '');
            return (
              <g
                key={b.id}
                data-id={b.id}
                className={`vbox vbox-${b.shape}${nested ? ' is-nested' : ''} state-${b.entity.state}${b.entity.muted ? ' is-muted' : ''}${b.leaving ? ' is-leaving' : ''}${selected === b.id ? ' is-selected' : ''}${changeClass(b.id)}${dim(b.id)}`}
                style={{ transform: `translate(${b.x}px, ${b.y}px)` }}
                {...interactive(b)}
              >
                <rect className="vbox-frame" style={{ width: b.w, height: b.h }} rx={b.shape === 'host' ? (nested ? 8 : 12) : 10} />
                {b.shape === 'host' ? <rect className="vbox-head" style={{ width: b.w, height: nested ? 26 : 28 }} rx={nested ? 8 : 12} /> : null}
                <Glyph state={b.entity.state} x={14} y={nested ? 13 : 15} />
                <text className="vbox-title" x={26} y={nested ? 17 : 19}>
                  {head.label}
                </text>
                <text className="vbox-kind" x={b.w - 12} y={nested ? 17 : 19} textAnchor="end">
                  {head.status ? <tspan className="vbox-status">{head.status}</tspan> : null}
                  {head.kind ? (
                    <tspan className="vbox-kindname" dx={head.status ? 8 : 0}>
                      {head.kind}
                    </tspan>
                  ) : null}
                </text>
                {still ? <Facts b={b} x={12} y={(nested ? 26 : 28) + 4} container /> : null}
              </g>
            );
          })}
        </g>
        <g className="vlayer-links" aria-hidden="true">
          {drawnLinks.map(({ r, type }) => {
            const a = byId.get(r.from) as Box;
            const b = byId.get(r.to) as Box;
            const hot = selected !== undefined && (r.from === selected || r.to === selected);
            return <path key={relKey(r)} className={`vlink vlink-${type}${hot ? ' is-hot' : ''}${related && !hot ? ' is-dim' : ''}${a.leaving || b.leaving ? ' is-leaving' : ''}`} style={{ d: `path("${linkPath(a, b)}")` } as React.CSSProperties} />;
          })}
        </g>
        {props.links && props.links.length > 0 ? <Causes links={props.links} byId={byId} arrow={arrowId} key={`${props.linksKey ?? ''}|${props.links.map((l) => `${l.from}>${l.to}`).join(',')}`} /> : null}
        <g className="vlayer-leaves">
          {leaves.map((b) => {
            const k = kinds.get(b.entity.kind);
            // The live view shows the first fact when there is no status; a still one draws its facts below.
            const first = still ? undefined : b.entity.facts[0];
            const line = subline(b.w - (b.shape === 'endpoint' ? 52 : 36), b.entity.status ?? (first ? `${first.label} ${first.value}` : ''), k?.label ?? '');
            return (
              <g
                key={b.id}
                data-id={b.id}
                className={`vbox vcard vbox-${b.shape} state-${b.entity.state}${b.entity.muted ? ' is-muted' : ''}${b.leaving ? ' is-leaving' : ''}${selected === b.id ? ' is-selected' : ''}${changeClass(b.id)}${dim(b.id)}`}
                style={{ transform: `translate(${b.x}px, ${b.y}px)` }}
                {...interactive(b)}
              >
                <g className="vcard-body">
                  {b.shape === 'workload' ? <path className="vcard-stack" d={outline('workload', b.w - 8, b.h)} transform="translate(4 -4)" /> : null}
                  <path className="vcard-frame" d={outline(b.shape, b.w, b.h)} />
                  <rect className="vcard-accent" x={b.shape === 'endpoint' ? 14 : 0} y={b.shape === 'endpoint' ? 14 : 8} width={3} height={b.shape === 'endpoint' ? CARD.h - 28 : b.h - 16} rx={1.5} />
                  <Glyph state={b.entity.state} x={b.shape === 'endpoint' ? 28 : 16} y={17} />
                  <text className="vcard-title" x={b.shape === 'endpoint' ? 40 : 28} y={21}>
                    {fit(b.entity.label, charsFor(b.w - (b.shape === 'endpoint' ? 52 : 36), 12))}
                  </text>
                  <text className="vcard-sub" x={b.shape === 'endpoint' ? 40 : 28} y={36}>
                    <tspan className="vcard-status">{line.status}</tspan>
                    {line.kind ? (
                      <tspan className="vcard-kind" dx={6}>
                        {line.kind}
                      </tspan>
                    ) : null}
                  </text>
                  {still ? <Facts b={b} x={b.shape === 'endpoint' ? 40 : 16} y={CARD.h - 6} container={false} /> : null}
                </g>
              </g>
            );
          })}
        </g>
        {marks ? <Marks boxes={lay.boxes} marks={marks} /> : null}
      </svg>
    </div>
  );
});
