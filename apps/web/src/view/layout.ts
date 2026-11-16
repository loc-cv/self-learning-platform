// Layout of a view model (docs/DESIGN.md §6): our own code, deterministic, and stable. A pure
// function of the model, a width and a memory of where each entity sat, so an entity keeps its
// place while others come and go. It knows the shapes of the view contract and nothing of any
// domain.
//
// The picture reads top to bottom: scopes with their declarations, then the entities whose kind
// normally sits in a container but has none (a lane per kind), then the hosts side by side with
// what runs on them, then anything else at the top level.

import type { Shape, ViewEntity, ViewKind, ViewModel } from '@simlab/kernel';

/** Leaf cards: a fixed height, a width between these that fills the container's columns. */
export const CARD = { min: 140, max: 210, h: 46 } as const;
export const GAP = 8;
/** One line of facts under a card's status, or under a container's header (figures show facts). */
export const FACT_LINE = 14;
/** At most this many entries of one list fact are drawn; the rest are counted on one more line. */
const MAX_ENTRIES = 3;
const BAND_GAP = 16;
const PAD = { host: { top: 34, side: 8, bottom: 8 }, scope: { top: 30, side: 10, bottom: 10 }, lane: { top: 28, side: 10, bottom: 10 } } as const;
/** Containers inside a host: a header and a thinner frame. */
const NESTED_PAD = { top: 32, side: 6, bottom: 6 } as const;

export type BoxShape = Shape;

/** A line of facts as drawn: a label, a value, or (side by side) both. */
export interface FactLine {
  label: string;
  text: string;
}

/** Estimated widths of the facts' type (--fs-xs): the label's sans face and the value's code face. */
export const FACT_CHAR = { label: 6, value: 6.6 } as const;
/** A value column narrower than this many characters puts each label on a line of its own. */
const MIN_VALUE_CHARS = 16;

/** A value cut into lines of at most `cap` characters, after a `=`, `:`, `/`, `,` or space where it can. */
export function wrapValue(text: string, cap: number, maxLines = 3): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > cap && out.length < maxLines - 1) {
    let cut = -1;
    for (let i = Math.min(cap, rest.length - 1); i >= Math.ceil(cap / 2); i--) {
      if ('=:/, '.includes(rest.charAt(i - 1))) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = cap;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

export interface FactLayout {
  /** Width of the label column when labels sit beside their values; 0 when they stand above. */
  labelW: number;
  lines: FactLine[];
}

/**
 * The lines an entity's facts take in `width`: one per entry of a list fact (a few at most), one per
 * other fact. Labels sit in a column of their own when the values keep room enough beside it;
 * otherwise each label takes a line above its values.
 */
export function factLayout(e: ViewEntity, width: number): FactLayout {
  if (e.facts.length === 0) return { labelW: 0, lines: [] };
  const labelW = Math.max(...e.facts.map((f) => f.label.length)) * FACT_CHAR.label + 8;
  const beside = (width - labelW) / FACT_CHAR.value >= MIN_VALUE_CHARS;
  const cap = Math.max(4, Math.floor((width - (beside ? labelW : 0)) / FACT_CHAR.value));
  const lines: FactLine[] = [];
  for (const f of e.facts) {
    const entries = f.items ?? [f.value];
    const shown = entries.slice(0, MAX_ENTRIES);
    if (entries.length > MAX_ENTRIES) shown.push(`+${entries.length - MAX_ENTRIES} more`);
    if (!beside) lines.push({ label: f.label, text: '' });
    shown.forEach((t, i) => wrapValue(t, cap).forEach((piece, j) => lines.push({ label: beside && i === 0 && j === 0 ? f.label : '', text: piece })));
  }
  return { labelW: beside ? labelW : 0, lines };
}

/** Room the facts leave on a card or under a header: the width minus the inset they are drawn at. */
export const factWidth = (shape: Shape, w: number, container: boolean): number => w - (container ? 24 : shape === 'endpoint' ? 52 : 28);

export interface Box {
  id: string;
  entity: ViewEntity;
  shape: BoxShape;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Containment depth: 0 at the top level. */
  depth: number;
  /** Drawn while it fades out; it keeps its slot until then. */
  leaving: boolean;
}

/** A caption over a group of top-level entities (the unplaced lane). */
export interface Lane {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  boxes: Box[];
  lanes: Lane[];
  width: number;
  height: number;
}

/** Where each entity sat: per container (or lane), the ids in slot order; null is a free slot. */
export interface Memory {
  slots: Record<string, (string | null)[]>;
}

export const emptyMemory = (): Memory => ({ slots: {} });

const isContainer = (s: Shape): boolean => s === 'host' || s === 'scope';

/** Shapes inside a container, in drawing order: nested containers first, then the leaves. */
const LEAF_ORDER: Shape[] = ['workload', 'endpoint', 'process', 'store', 'rule'];

/**
 * Puts `ids` into the remembered slots of `key`: an id keeps its slot, a new id takes the first
 * free one (in the given order), an id that is gone frees its slot. The array never shrinks while
 * the memory lives, so nothing moves up when something leaves.
 */
export function assignSlots(memory: Memory, key: string, ids: readonly string[]): (string | null)[] {
  const prev = memory.slots[key] ?? [];
  const want = new Set(ids);
  const slots = prev.map((id) => (id !== null && want.has(id) ? id : null));
  const placed = new Set(slots.filter((x): x is string => x !== null));
  for (const id of ids) {
    if (placed.has(id)) continue;
    const free = slots.indexOf(null);
    if (free >= 0) slots[free] = id;
    else slots.push(id);
    placed.add(id);
  }
  memory.slots[key] = slots;
  return slots;
}

export interface LayoutInput {
  model: ViewModel;
  /** Entities that left the model and are still fading out, by id. */
  leaving?: ReadonlyMap<string, ViewEntity>;
  /** The entities to draw (after filtering); leaving ones are added. */
  visible: (e: ViewEntity) => boolean;
  width: number;
  /** Draw the entities' facts (figures); the live view shows them on selection instead. */
  facts?: boolean;
}

interface Item {
  e: ViewEntity;
  shape: Shape;
  leaving: boolean;
  kids: Item[];
}

export function layout(input: LayoutInput, memory: Memory): Layout {
  const kinds = new Map<string, ViewKind>(input.model.kinds.map((k) => [k.kind, k]));
  const shapeOf = (e: ViewEntity): Shape => kinds.get(e.kind)?.shape ?? 'process';
  const all: ViewEntity[] = input.model.entities.filter(input.visible);
  const leaving = new Set<string>();
  const present = new Set(all.map((e) => e.id));
  for (const [id, e] of input.leaving ?? []) {
    if (present.has(id)) continue;
    all.push(e);
    leaving.add(id);
  }
  const items = new Map<string, Item>();
  for (const e of all) items.set(e.id, { e, shape: shapeOf(e), leaving: leaving.has(e.id), kids: [] });
  const top: Item[] = [];
  for (const n of items.values()) {
    const parent = n.e.container === undefined ? undefined : items.get(n.e.container);
    if (parent && isContainer(parent.shape)) parent.kids.push(n);
    else top.push(n);
  }

  const boxes: Box[] = [];
  const lanes: Lane[] = [];
  const extra = (e: ViewEntity, shape: Shape, w: number, container = false): number => (input.facts ? factLayout(e, factWidth(shape, w, container)).lines.length * FACT_LINE : 0);
  const W = Math.max(input.width, CARD.min + 2 * PAD.lane.side);

  /** Columns of leaf cards that fit an inner width, and their width. */
  const cols = (inner: number): number => Math.max(1, Math.floor((inner + GAP) / (CARD.min + GAP)));
  const cardW = (inner: number, c: number): number => Math.max(CARD.min, Math.min(CARD.max, Math.floor((inner - (c - 1) * GAP) / c)));

  /**
   * Lays out the children of a container inside `inner` width at (x, y); returns the height used.
   * Nested containers stack at full width, then the leaves fill a grid of remembered slots.
   */
  const place = (key: string, kids: Item[], x: number, y: number, inner: number, depth: number): number => {
    const containers = kids.filter((k) => isContainer(k.shape));
    const leaves = kids.filter((k) => !isContainer(k.shape));
    let h = 0;
    const cslots = assignSlots(memory, `${key}#c`, containers.map((k) => k.e.id));
    for (const id of cslots) {
      const k = id === null ? undefined : containers.find((c) => c.e.id === id);
      if (!k) continue;
      if (h > 0) h += GAP;
      h += box(k, x, y + h, inner, depth, true);
    }
    const order = (n: Item): number => LEAF_ORDER.indexOf(n.shape);
    const sorted = [...leaves].sort((a, b) => order(a) - order(b));
    const lslots = assignSlots(memory, `${key}#l`, sorted.map((k) => k.e.id));
    if (lslots.length > 0) {
      if (h > 0) h += GAP;
      const c = cols(inner);
      const cw = cardW(inner, c);
      const rows = Math.ceil(lslots.length / c);
      const items = lslots.map((id) => (id === null ? undefined : leaves.find((l) => l.e.id === id)));
      // A row is as tall as its tallest card (cards with facts are taller).
      const rowH = Array.from({ length: rows }, (_, r) => Math.max(CARD.h, ...items.slice(r * c, (r + 1) * c).map((k) => (k ? CARD.h + extra(k.e, k.shape, cw) : 0))));
      let ry = y + h;
      rowH.forEach((rh, r) => {
        items.slice(r * c, (r + 1) * c).forEach((k, j) => {
          if (!k) return;
          boxes.push({ id: k.e.id, entity: k.e, shape: k.shape, x: x + j * (cw + GAP), y: ry, w: cw, h: CARD.h + extra(k.e, k.shape, cw), depth: depth + 1, leaving: k.leaving });
        });
        ry += rh + GAP;
      });
      h += rowH.reduce((a, b) => a + b, 0) + (rows - 1) * GAP;
    }
    return h;
  };

  /** A container box with its children; returns its height. */
  const box = (n: Item, x: number, y: number, w: number, depth: number, nested: boolean): number => {
    const base = nested && n.shape === 'host' ? NESTED_PAD : n.shape === 'host' ? PAD.host : PAD.scope;
    // Facts sit under the header, before the children.
    const facts = extra(n.e, n.shape, w, true);
    const pad = { ...base, top: base.top + (facts > 0 ? facts + 4 : 0) };
    const b: Box = { id: n.e.id, entity: n.e, shape: n.shape, x, y, w, h: 0, depth, leaving: n.leaving };
    boxes.push(b);
    const inner = w - 2 * pad.side;
    const used = place(n.e.id, n.kids, x + pad.side, y + pad.top, inner, depth);
    b.h = pad.top + (used > 0 ? used + pad.bottom : 0);
    if (used === 0) b.h = pad.top + (facts > 0 ? base.bottom : 0);
    return b.h;
  };

  let y = 0;
  const band = (h: number): void => {
    if (h > 0) y += h + BAND_GAP;
  };

  // 1. Scopes, stacked at full width.
  const scopes = top.filter((n) => n.shape === 'scope');
  {
    const slots = assignSlots(memory, 'band:scopes', scopes.map((n) => n.e.id));
    let h = 0;
    for (const id of slots) {
      const n = id === null ? undefined : scopes.find((s) => s.e.id === id);
      if (!n) continue;
      if (h > 0) h += GAP;
      h += box(n, 0, y + h, W, 0, false);
    }
    band(h);
  }

  // 2. Entities without the container their kind sits in: a lane per kind.
  const unplaced = top.filter((n) => !isContainer(n.shape) && kinds.get(n.e.kind)?.placedIn !== undefined);
  const laneKinds = [...new Set(unplaced.map((n) => n.e.kind))].sort();
  for (const kind of laneKinds) {
    const k = kinds.get(kind) as ViewKind;
    const lane: Lane = { id: `lane:${kind}`, label: k.unplaced ?? k.plural, x: 0, y, w: W, h: 0 };
    lanes.push(lane);
    const used = place(lane.id, unplaced.filter((n) => n.e.kind === kind), PAD.lane.side, y + PAD.lane.top, W - 2 * PAD.lane.side, 0);
    lane.h = PAD.lane.top + used + PAD.lane.bottom;
    band(lane.h);
  }

  // 3. Hosts side by side, wrapping to more rows when they do not fit.
  const hosts = top.filter((n) => n.shape === 'host');
  {
    const slots = assignSlots(memory, 'band:hosts', hosts.map((n) => n.e.id)).filter((id): id is string => id !== null);
    const list = slots.map((id) => hosts.find((h) => h.e.id === id) as Item).filter(Boolean);
    const minW = CARD.min + 2 * PAD.host.side + 2 * NESTED_PAD.side;
    const perRow = Math.max(1, Math.min(list.length, Math.floor((W + GAP) / (minW + GAP))));
    const hw = (W - (perRow - 1) * GAP) / perRow;
    let h = 0;
    for (let r = 0; r * perRow < list.length; r++) {
      let rowH = 0;
      const rowBoxes: Box[] = [];
      list.slice(r * perRow, (r + 1) * perRow).forEach((n, i) => {
        const before = boxes.length;
        rowH = Math.max(rowH, box(n, i * (hw + GAP), y + h, hw, 0, false));
        rowBoxes.push(boxes[before] as Box);
      });
      // Hosts in a row share its height, so the row reads as one shelf.
      for (const b of rowBoxes) b.h = rowH;
      h += rowH + GAP;
    }
    band(h > 0 ? h - GAP : 0);
  }

  // 4. Anything else at the top level, in a grid.
  const rest = top.filter((n) => !isContainer(n.shape) && kinds.get(n.e.kind)?.placedIn === undefined);
  if (rest.length > 0) band(place('band:rest', rest, 0, y, W, -1));

  return { boxes, lanes, width: W, height: Math.max(0, y - BAND_GAP) };
}

/** Middle ellipsis: keeps the start and the end, where generated names differ. */
export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
