// Blocks of prose and figures for one variant (docs/SCENARIO_FORMAT.md §10, §11): `when` resolved,
// placeholders substituted, a scene's steps resolved like any other list of steps. And the plain
// text of a list of blocks, for a terminal: a figure becomes its caption and its alt text.

import type { Json } from '@simlab/kernel';
import type { JsonObject, Params } from '../item/types.ts';
import { matches, resolveSteps, substitute, substituteString } from '../item/variant.ts';
import type { Block, Figure, Frame, SceneFigure, VariantBlock } from './types.ts';

/** A figure for one variant: placeholders substituted, a scene's steps resolved. */
export function resolveFigure(fig: Figure, params: Params, where: string): Figure {
  if (fig.kind !== 'scene') return substitute(fig as unknown as Json, params, where) as unknown as Figure;
  const { world, frames, ...rest } = fig;
  const out = substitute(rest as unknown as Json, params, where) as unknown as SceneFigure;
  if (world) {
    const { setup, ...w } = world;
    out.world = { ...(substitute(w as unknown as Json, params, `${where}.world`) as JsonObject), setup: resolveSteps(setup, params, `${where}.world.setup`) };
  }
  out.frames = frames.map((f, i) => {
    const { steps, ...fr } = f;
    const r = substitute(fr as unknown as Json, params, `${where}.frames[${i}]`) as unknown as Frame;
    if (steps) r.steps = resolveSteps(steps, params, `${where}.frames[${i}].steps`);
    return r;
  });
  return out;
}

const asText = (v: Json): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** A Markdown field or a list of blocks, for one variant. */
export function resolveBlocks(value: string | readonly Block[], params: Params, where: string): VariantBlock[] {
  if (typeof value === 'string') return [{ text: asText(substituteString(value, params, where)) }];
  const out: VariantBlock[] = [];
  value.forEach((b, i) => {
    if (!matches(b.when, params)) return;
    if ('figure' in b) out.push({ figure: resolveFigure(b.figure, params, `${where}[${i}].figure`) });
    else out.push({ text: asText(substituteString(b.text, params, `${where}[${i}]`)) });
  });
  return out;
}

/** The figures of a list of blocks, in order. */
export const figuresOf = (blocks: readonly VariantBlock[]): Figure[] => blocks.flatMap((b) => ('figure' in b ? [b.figure] : []));

/** The prose of a list of blocks as one Markdown text, a figure as its caption and alt text. */
export function blocksText(blocks: readonly VariantBlock[], figure: (f: Figure) => string = figureText): string {
  return blocks.map((b) => ('figure' in b ? figure(b.figure) : b.text).replace(/\s+$/, '')).join('\n\n') + '\n';
}

/** A figure in a terminal: what it is called and what it shows. */
export function figureText(f: Figure): string {
  return `[Figure] ${f.caption.trim()}\n${f.alt.trim()}`;
}
