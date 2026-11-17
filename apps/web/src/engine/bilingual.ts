// Content text in two languages (docs/LEARNING_MODEL.md §4, PLAN.md §5 "Languages"). The engine
// resolves an item three times with the same seed: as written, with its current Vietnamese in
// place (`localize`), and with every text replaced by its unit key (`tagUnits`). The three have
// the same shape, so a text's translation and its state are found by position.

import { renderFigure, unitKeyOf, type Figure, type Lab, type SidecarResolution, type UnitState, type VariantBlock } from '@simlab/learn';
import type { PBlock, Text } from '../protocol.ts';

export interface Three<V> {
  en: V;
  vi?: V;
  tag?: V;
}

export type UnitStates = ReadonlyMap<string, UnitState>;

/** The same part of each of the three. */
export function three<V, W>(v: Three<V>, part: (x: V) => W): Three<W> {
  const out: Three<W> = { en: part(v.en) };
  if (v.vi !== undefined) out.vi = part(v.vi);
  if (v.tag !== undefined) out.tag = part(v.tag);
  return out;
}

export function unitStates(r: SidecarResolution | undefined): UnitStates | undefined {
  return r ? new Map(r.units.map((u) => [u.key, u.state])) : undefined;
}

export function translationOf(r: SidecarResolution | undefined): 'none' | 'partial' | 'full' {
  if (!r) return 'none';
  return r.counts.missing + r.counts.outdated === 0 ? 'full' : 'partial';
}

/** A text with its Vietnamese when that is current; for an item with a sidecar, why not otherwise. */
export function textOf(states: UnitStates | undefined, en: string, vi: string | undefined, tag: string | undefined): Text {
  if (!states) return { en };
  const state = states.get(unitKeyOf(tag ?? '') ?? '') ?? 'missing';
  if (state === 'current' && vi !== undefined) return { en, vi };
  return { en, gap: state === 'outdated' ? 'outdated' : 'missing' };
}

/** The units of one figure: every key under its caption's parent (`ticket.1.caption` → `ticket.1.`). */
function figureStates(states: UnitStates, tagged: Figure): UnitState[] {
  const prefix = (unitKeyOf(tagged.caption) ?? '').replace(/caption$/, '');
  return prefix === '' ? [] : [...states].filter(([k]) => k.startsWith(prefix)).map(([, s]) => s);
}

/** A figure with no world behind it: a diagram is drawn from the figure alone. */
function drawDiagram(fig: Figure): PBlock {
  const failed = (problems: string[]): PBlock => ({ failed: { caption: fig.caption, alt: fig.alt, problems } });
  if (fig.kind !== 'diagram') return failed(['this figure shows a world, and the card has none']);
  // A diagram reads neither worlds nor the registry (packages/learn/src/figure/render.ts renderDiagram).
  const r = renderFigure(fig, undefined as never, undefined as never);
  return r.figure && r.problems.length === 0 ? { figure: r.figure } : failed(r.problems);
}

/**
 * A figure drawn from the English item, and once more with its Vietnamese texts when at least one
 * of them is current. Both drawings show the same world; only captions, notes and labels differ.
 */
export function figureBlock(lab: Lab | undefined, states: UnitStates | undefined, en: Figure, vi: Figure | undefined, tag: Figure | undefined): PBlock {
  const draw = (f: Figure): PBlock => (lab ? (lab.render([{ figure: f }])[0] as PBlock) : drawDiagram(f));
  const block = draw(en);
  if (!('figure' in block) || !states || !vi || !tag) return block;
  const units = figureStates(states, tag);
  if (units.includes('current')) {
    const other = draw(vi);
    if ('figure' in other) block.vi = other.figure;
  }
  if (units.includes('missing')) block.gap = 'missing';
  else if (units.includes('outdated')) block.gap = 'outdated';
  return block;
}

/** Prose and figures of a ticket or a debrief. */
export function blocksOf(lab: Lab, states: UnitStates | undefined, b: Three<VariantBlock[]>): PBlock[] {
  return b.en.map((block, i): PBlock => {
    const vi = b.vi?.[i];
    const tag = b.tag?.[i];
    if ('text' in block) return { text: textOf(states, block.text, vi && 'text' in vi ? vi.text : undefined, tag && 'text' in tag ? tag.text : undefined) };
    return figureBlock(lab, states, block.figure, vi && 'figure' in vi ? vi.figure : undefined, tag && 'figure' in tag ? tag.figure : undefined);
  });
}
