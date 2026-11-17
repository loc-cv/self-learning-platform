// Figures (docs/SCENARIO_FORMAT.md §11, PLAN.md §5 "Show, then tell", §6.5): views of simulated
// worlds inside the ticket, the debrief and (phase 11) lesson steps. What an author writes is a
// `Figure`; what the engine makes of it for one variant, with the worlds it names, is a
// `RenderedFigure`: plain view models with the marks the renderer draws. Nothing here names a
// domain: kinds, scopes and facts are matched by the words the view model itself uses.

import type { RelationType, Shape, ViewEvent, ViewModel, ViewState } from '@simlab/kernel';
import type { Step, When } from '../item/types.ts';

/** Which world a view shows: after setup, after the first reference solution, or the learner's now. */
export type WorldName = 'start' | 'solved' | 'now';

/**
 * An entity named the way the view model names it: `<Kind label>/<label>`, `Unit/web`.
 * `*` in the label matches any run of characters (`Process/web-*`), and `<Kind>/*` every entity of the
 * kind in the figure.
 */
export type EntityRef = string;

/** Which part of the world a view shows. Absent: everything but the platform's own entities. */
export interface Focus {
  /** Scope labels (`shop`): entities that belong to another scope are left out. */
  scope?: string | string[];
  /** Kind labels (`Process`, `Machine`): only entities of these kinds. */
  kinds?: string[];
  /** Only these entities (and the containers they are placed in). */
  entities?: EntityRef[];
  /** Include the platform's own entities (`system` in the view model). Default false. */
  system?: boolean;
}

/** A fact to show on each entity that has it, by its label; for a list fact, optionally some entries by key. */
export type ShowItem = string | { fact: string; keys: string[] };

export interface Note {
  /** The entities the note points at; absent for a note on the whole figure. */
  on?: EntityRef;
  text: string;
  /** A divergence register entry (docs/FIDELITY.md) where the model is coarser than reality. */
  divergence?: string;
}

interface FigureBase {
  caption: string;
  /** Says what the figure shows, for a screen reader and for `npm run lab` in a terminal. */
  alt: string;
}

interface Marked {
  focus?: Focus;
  /** The facts shown on the cards. Required in a ticket's figure, so a reviewer sees what it reveals. */
  show?: ShowItem[];
  highlight?: EntityRef[];
  notes?: Note[];
}

export interface WorldSide {
  of: WorldName;
  title?: string;
}

export interface ViewFigure extends FigureBase, Marked {
  kind: 'view';
  of: WorldName;
}

export interface CompareFigure extends FigureBase, Marked {
  kind: 'compare';
  left: WorldSide;
  right: WorldSide;
}

/** A small world of the scene's own: a topology (default: the item's) and setup steps. */
export interface SceneWorld {
  topology?: string;
  setup: Step[];
}

/**
 * A moment the trace recorded (docs/SCENARIO_FORMAT.md §11.6): the first event since the previous
 * frame that matches every part given. `*` matches any run of characters; case is ignored.
 */
export interface FrameAnchor {
  /** The component that acted, as the event names it. */
  actor?: string;
  /** An entity the event is about. */
  about?: EntityRef;
  /** The event's text. */
  text?: string;
  /** How long to wait for it in virtual time (a duration, `90s`). Default 5m. */
  within?: string;
}

export interface Frame {
  /** Run before the frame is taken; the first frame may have none. */
  steps?: Step[];
  /**
   * Draw the frame at the moment the trace records a matching event: after `steps`, time advances
   * event by event until it does. The caption may quote the event's text as `{{@cause}}`.
   */
  at?: FrameAnchor;
  caption: string;
  highlight?: EntityRef[];
  notes?: Note[];
}

export interface SceneFigure extends FigureBase, Marked {
  kind: 'scene';
  /** Absent: the scene starts from the item's baseline. */
  world?: SceneWorld;
  frames: Frame[];
}

export interface DiagramEntity {
  id: string;
  shape: Shape;
  label: string;
  /** The kind's name shown on the card; default none. */
  kind?: string;
  container?: string;
  state?: ViewState;
  status?: string;
  facts?: { label: string; value: string }[];
}

export interface DiagramFigure extends FigureBase {
  kind: 'diagram';
  entities: DiagramEntity[];
  relations?: { type: RelationType; from: string; to: string }[];
  /** Notes `on` a diagram entity name it by id. */
  highlight?: string[];
  notes?: Note[];
}

export type Figure = ViewFigure | CompareFigure | SceneFigure | DiagramFigure;

/** A block of prose or a figure, in the ticket, the debrief or (phase 11) a lesson step. */
export type Block = { text: string; when?: When } | { figure: Figure; when?: When };

/** A block of one variant: placeholders substituted, `when` resolved away. */
export type VariantBlock = { text: string } | { figure: Figure };

// ---------------------------------------------------------------------------------------------
// Rendered

/** How an entity differs between the two sides of a comparison. */
export type Change = 'added' | 'removed' | 'changed';

export interface RenderedNote {
  /** The number drawn on the entities it points at, and before its text. */
  n: number;
  /** Ids of the entities it points at; empty for a note on the whole figure. */
  on: string[];
  text: string;
  divergence?: string;
}

/** One drawing: a view model trimmed to the figure's focus and facts, and what to mark on it. */
export interface Panel {
  title?: string;
  model: ViewModel;
  highlight: string[];
  notes: RenderedNote[];
  /** Entity id → how it differs from the other side (a comparison) or from the frame before (a replay). */
  changes: Record<string, Change>;
  /**
   * Causes that travelled between two entities of the model since the frame before (a controller
   * created an instance, a placer assigned it), from the trace. The renderer moves something along
   * these and along nothing else (PLAN.md §6.5).
   */
  links?: { from: string; to: string }[];
}

/** One frame of a scene: a view, and for a frame anchored to the trace the event it was drawn at. */
export interface RenderedFrame {
  caption: string;
  panel: Panel;
  /** Virtual time the frame was taken at. */
  t?: number;
  cause?: ViewEvent;
}

export type RenderedFigure =
  | { kind: 'view' | 'diagram'; caption: string; alt: string; panel: Panel }
  | { kind: 'compare'; caption: string; alt: string; left: Panel; right: Panel }
  | { kind: 'scene'; caption: string; alt: string; frames: RenderedFrame[] };

/** A block as the learner sees it: prose, a rendered figure, or a figure that could not be built. */
export type RenderedBlock = { text: string } | { figure: RenderedFigure } | { failed: { caption: string; alt: string; problems: string[] } };
