// Rendering a figure of one variant (docs/SCENARIO_FORMAT.md §11): the worlds it names are built
// on forks of the baseline (`start` is a fresh fork, `solved` a fork the first reference solution
// ran on, a scene its own fork or its own small world), so none of them touches the learner's
// session or its input log. `now` is the learner's world, read and never changed. The result is
// plain data the renderer draws; the problems are what content validation reports.

import { buildView, type Registry, type ViewEntity, type ViewKind, type ViewModel, type World } from '@simlab/kernel';
import { validateView } from '@simlab/kernel';
import { buildBaseline, startSession, type Baseline, type BuildOptions } from '../runner/build.ts';
import { runSteps, StepFailure } from '../runner/steps.ts';
import { focusView, markChanges, markPanel, resolveRef, viewKey } from './focus.ts';
import type { DiagramFigure, Figure, Panel, RenderedFigure, SceneFigure, WorldName } from './types.ts';

/** The worlds a figure can name, built when first asked for. */
export interface FigureWorlds {
  start(): World;
  solved(): World;
  now(): World;
}

export interface FigureEnv {
  registry: Registry;
  baseline: Baseline;
  /** For a scene's own world: the start time the item's baseline was built with. */
  build?: BuildOptions;
}

/**
 * The worlds of a variant's figures. `now` defaults to the untouched start, which is what content
 * validation shows in place of a learner's world.
 */
export function figureWorlds(env: FigureEnv, now?: () => World): FigureWorlds {
  let start: World | undefined;
  let solved: World | undefined;
  return {
    start: () => (start ??= startSession(env.baseline).kernel.world),
    solved: () => {
      if (solved) return solved;
      const first = env.baseline.variant.solutions[0];
      if (!first) throw new FigureError('no reference solution applies to this variant, so there is no solved world');
      const { kernel, hub } = startSession(env.baseline);
      runSteps(kernel, first.steps, { registry: env.registry, entry: env.baseline.entry, hub, baseline: env.baseline.kernel.world }, first.name ?? 'solution 1');
      return (solved = kernel.world);
    },
    now: now ?? (() => (start ??= startSession(env.baseline).kernel.world)),
  };
}

export class FigureError extends Error {}

const DEFAULT_TITLES: Record<WorldName, string> = { start: 'At the start', solved: 'Solved', now: 'Your world now' };

export interface Rendering {
  figure?: RenderedFigure;
  problems: string[];
  /**
   * Worlds in which the focus selected nothing. A problem for `start`, `solved` and scenes; for
   * `now` only in content validation, where it stands for the start: a learner may have deleted
   * everything, and then the figure shows an empty drawing.
   */
  empty: WorldName[];
}

function worldOf(worlds: FigureWorlds, name: WorldName): World {
  return name === 'start' ? worlds.start() : name === 'solved' ? worlds.solved() : worlds.now();
}

function focused(env: FigureEnv, world: World, fig: Exclude<Figure, DiagramFigure>): ViewModel {
  return focusView(buildView(env.registry, world), fig.focus, fig.show);
}

/** The problems of a rendering, an empty `now` included only when `now` stands for the start. */
export function renderProblems(r: Rendering, nowIsStart: boolean): string[] {
  return [...r.empty.filter((w) => w !== 'now' || nowIsStart).map((w) => `the focus selects nothing in the ${w} world`), ...r.problems];
}

export function renderFigure(fig: Figure, worlds: FigureWorlds, env: FigureEnv): Rendering {
  try {
    switch (fig.kind) {
      case 'view': {
        const model = focused(env, worldOf(worlds, fig.of), fig);
        const empty: WorldName[] = model.entities.length === 0 ? [fig.of] : [];
        const { panel, missing } = markPanel(model, fig, undefined);
        const problems = empty.length > 0 ? [] : missing.map((r) => `${r} names no entity in the ${fig.of} world`);
        return { figure: { kind: 'view', caption: fig.caption, alt: fig.alt, panel }, problems, empty };
      }
      case 'compare': {
        const problems: string[] = [];
        const empty: WorldName[] = [];
        const side = (s: { of: WorldName; title?: string }) => {
          const model = focused(env, worldOf(worlds, s.of), fig);
          if (model.entities.length === 0) empty.push(s.of);
          return model;
        };
        const lm = side(fig.left);
        const rm = side(fig.right);
        const left = markPanel(lm, fig, fig.left.title ?? DEFAULT_TITLES[fig.left.of]);
        const right = markPanel(rm, fig, fig.right.title ?? DEFAULT_TITLES[fig.right.of]);
        // A mark may point at what only one side has (the new instances); it must exist on one.
        for (const r of left.missing) if (right.missing.includes(r)) problems.push(`${r} names no entity in either world`);
        markChanges(left.panel, right.panel);
        return { figure: { kind: 'compare', caption: fig.caption, alt: fig.alt, left: left.panel, right: right.panel }, problems, empty };
      }
      case 'scene':
        return renderScene(fig, env);
      case 'diagram':
        return renderDiagram(fig);
    }
  } catch (e) {
    if (e instanceof StepFailure || e instanceof FigureError) return { problems: [e.message], empty: [] };
    throw e;
  }
}

function renderScene(fig: SceneFigure, env: FigureEnv): Rendering {
  const base = fig.world ? buildBaseline({ ...env.baseline.variant, topology: fig.world.topology ?? env.baseline.variant.topology, setup: fig.world.setup }, env.registry, env.build) : env.baseline;
  const { kernel, hub } = startSession(base);
  const problems: string[] = [];
  const frames: { caption: string; panel: Panel }[] = [];
  const figureLevel = { highlight: new Set(fig.highlight ?? []), notes: new Set((fig.notes ?? []).flatMap((n) => (n.on === undefined ? [] : [n.on]))) };
  const found = new Set<string>();
  let previous = '';
  fig.frames.forEach((f, i) => {
    if (problems.length > 0) return;
    try {
      if (f.steps && f.steps.length > 0) runSteps(kernel, f.steps, { registry: env.registry, entry: base.entry, hub, baseline: base.kernel.world }, `scene frame ${i + 1}`);
    } catch (e) {
      if (e instanceof StepFailure) {
        problems.push(e.message);
        return;
      }
      throw e;
    }
    const model = focused(env, kernel.world, fig);
    if (model.entities.length === 0) problems.push(`the focus selects nothing in frame ${i + 1}`);
    const key = viewKey(model);
    if (i > 0 && key === previous) problems.push(`frame ${i + 1} shows the same as frame ${i}; a frame must change something`);
    previous = key;
    for (const r of [...figureLevel.highlight, ...figureLevel.notes]) if (resolveRef(model, r).length > 0) found.add(r);
    const { panel: shared } = markPanel(model, fig, undefined);
    const own = markPanel(model, f, undefined, shared.notes.length + 1);
    problems.push(...own.missing.map((r) => `${r} names no entity in frame ${i + 1}`));
    const panel: Panel = { model, highlight: [...new Set([...shared.highlight, ...own.panel.highlight])], notes: [...shared.notes, ...own.panel.notes], changes: {} };
    frames.push({ caption: f.caption, panel });
  });
  if (problems.length === 0) for (const r of new Set([...figureLevel.highlight, ...figureLevel.notes])) if (!found.has(r)) problems.push(`${r} names no entity in any frame`);
  return problems.length > 0 ? { problems, empty: [] } : { figure: { kind: 'scene', caption: fig.caption, alt: fig.alt, frames }, problems, empty: [] };
}

/** A hand-drawn figure as a view model: one kind per shape and kind name. */
export function diagramModel(fig: DiagramFigure): ViewModel {
  const kinds = new Map<string, ViewKind>();
  const entities: ViewEntity[] = fig.entities.map((d) => {
    const kind = `diagram.${d.shape}.${d.kind ?? ''}`;
    if (!kinds.has(kind)) kinds.set(kind, { kind, shape: d.shape, label: d.kind ?? '', plural: d.kind ?? '' });
    const e: ViewEntity = { id: d.id, kind, label: d.label, state: d.state ?? 'unknown', facts: (d.facts ?? []).map((f) => ({ ...f })) };
    if (d.status !== undefined) e.status = d.status;
    if (d.container !== undefined) e.container = d.container;
    return e;
  });
  return { t: 0, kinds: [...kinds.values()], entities, relations: (fig.relations ?? []).map((r) => ({ ...r })) };
}

function renderDiagram(fig: DiagramFigure): Rendering {
  const model = diagramModel(fig);
  const problems = validateView(model).map((p) => `diagram: ${p}`);
  const ids = new Set(model.entities.map((e) => e.id));
  for (const h of fig.highlight ?? []) if (!ids.has(h)) problems.push(`diagram: highlight ${h} is not an entity`);
  for (const n of fig.notes ?? []) if (n.on !== undefined && !ids.has(n.on)) problems.push(`diagram: a note is on ${n.on}, which is not an entity`);
  const notes = (fig.notes ?? []).map((n, i) => ({ n: i + 1, on: n.on === undefined ? [] : [n.on], text: n.text, ...(n.divergence !== undefined ? { divergence: n.divergence } : {}) }));
  return { figure: { kind: 'diagram', caption: fig.caption, alt: fig.alt, panel: { model, highlight: [...(fig.highlight ?? [])], notes, changes: {} } }, problems, empty: [] };
}
