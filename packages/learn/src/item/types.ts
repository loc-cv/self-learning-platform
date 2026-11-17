// A content item as written (docs/SCENARIO_FORMAT.md §2, docs/LEARNING_MODEL.md §2), after YAML
// parsing: plain JSON data. The schema (schema.ts) is what guarantees these shapes; the types only
// name them. `Item` is the lab-like item (lab, drill, incident); lessons, cards and exams have
// their own types, and `AnyItem` is any of them.

import type { Assist } from '../assist.ts';
import type { Json } from '@simlab/kernel';
import type { Block, Figure, VariantBlock } from '../figure/types.ts';

export type JsonObject = { [key: string]: Json };

/** The lab-like kinds: a world, a ticket, checks, solutions, a debrief. */
export type ScenarioKind = 'lab' | 'drill' | 'incident';

export type ItemKind = ScenarioKind | 'lesson' | 'card' | 'exam';

export const SCENARIO_KINDS: readonly ScenarioKind[] = ['lab', 'drill', 'incident'];

/** `{ fault: stopped }`, `{ fault: [stopped, masked] }`: every key must match (§4). */
export type When = Record<string, Json>;

export type ParamGenerator = { pick: Json[] } | { int: { min: number; max: number } };

/** A step: one kind key, modifiers, optional `when` (§6). */
export type Step = JsonObject & { when?: When };

export type Hint = string | { text: string; when?: When };

export interface CheckDecl {
  id: string;
  title: string;
  assert: string;
  with: JsonObject;
  not?: boolean;
  within?: string;
  after?: Step[];
  /** Share of the score; default 1 (§7). */
  weight?: number;
  when?: When;
}

export type SolutionDecl = Step[] | { name: string; steps: Step[]; when?: When };

/** Markdown, or blocks of prose and figures (§10, §11). */
export type Debrief = string | Block[];

export interface World {
  topology: string;
  topologyParams?: JsonObject;
  startTime?: string;
  entry?: { machine: string; user: string };
  params?: Record<string, ParamGenerator>;
  images?: JsonObject;
  setup?: Step[];
}

export interface Item {
  id: string;
  kind: ScenarioKind;
  title: string;
  skills: string[];
  curriculum: string[];
  difficulty: number;
  targetMinutes: number;
  /** How much of the live view an attempt may use (assist.ts). Default `full`. */
  assist?: Assist;
  world: World;
  /** Markdown, or blocks of prose and figures (§10, §11). */
  ticket: string | Block[];
  hints: Hint[];
  checks: CheckDecl[];
  solutions: SolutionDecl[];
  debrief: Debrief;
}

/** Parameter values of one variant, in declaration order. */
export type Params = Record<string, Json>;

/** A check of one variant: placeholders substituted, `when` resolved away. */
export interface Check {
  id: string;
  title: string;
  assert: string;
  with: JsonObject;
  not: boolean;
  /** Milliseconds, or undefined to evaluate once. */
  within?: number;
  after: Step[];
  weight: number;
}

export interface Solution {
  /** Present for named solutions. */
  name?: string;
  steps: Step[];
}

/** One variant of an item: what a seed makes of it (§3, "resolve", "substitute", "drop"). */
export interface Variant {
  item: Item;
  seed: number;
  params: Params;
  topology: string;
  topologyParams: JsonObject;
  /** Milliseconds since the epoch, when the item fixes it. */
  startTime?: number;
  entry?: { machine: string; user: string };
  setup: Step[];
  ticket: VariantBlock[];
  hints: string[];
  checks: Check[];
  solutions: Solution[];
  debrief: VariantBlock[];
}

// ---- Lessons, cards and exams (docs/LEARNING_MODEL.md §2) ----

/** What every item that is practiced and scheduled declares. */
export interface ItemHeader {
  id: string;
  title: string;
  skills: string[];
  curriculum: string[];
  difficulty: number;
  targetMinutes: number;
  /** How much of the live view an attempt may use (assist.ts). Default `full`. */
  assist?: Assist;
}

/** A prediction prompt: answered before the learner sees what happens (PLAN.md §5). */
export interface Prediction {
  prompt: string;
  /** With choices the answer is checked; without, the learner compares with `explain`. */
  choices?: string[];
  /** Index of the correct choice. */
  answer?: number;
  /** Shown once answered: what happens and why. */
  explain: string;
}

/** A guided task in the lesson's live world. */
export interface LessonTask {
  text: string;
  hints?: string[];
  checks: CheckDecl[];
  /** Steps that do the task; content validation runs them. */
  solution: Step[];
}

export type LessonStep =
  | { text: string; when?: When }
  | { figure: Figure; when?: When }
  | { predict: Prediction; when?: When }
  | { task: LessonTask; when?: When };

export interface LessonItem extends ItemHeader {
  kind: 'lesson';
  world: World;
  steps: LessonStep[];
}

export interface CardItem extends ItemHeader {
  kind: 'card';
  /** Needed by a figure of a world and by checks. */
  world?: World;
  prompt: string;
  figure?: Figure;
  /** The expected answer, shown on reveal. */
  answer: string;
  /** Auto-check by choice: the options and the index of the correct one. */
  choices?: string[];
  correct?: number;
  /** Auto-check by command: the learner works in the card's world and these grade its state. */
  checks?: CheckDecl[];
  solution?: Step[];
}

export interface ExamTask {
  /** A lab, drill or incident. */
  item: string;
  /** Share of the exam's score. */
  weight: number;
}

/** An exam's definition; the mode that runs it is phase 31. */
export interface ExamItem {
  id: string;
  kind: 'exam';
  title: string;
  minutes: number;
  passPercent: number;
  tasks: ExamTask[];
}

export type AnyItem = Item | LessonItem | CardItem | ExamItem;

export const isScenario = (item: AnyItem): item is Item => item.kind === 'lab' || item.kind === 'drill' || item.kind === 'incident';

export type LessonVariantStep =
  | { text: string }
  | { figure: Figure }
  | { predict: Prediction }
  | { task: { text: string; hints: string[]; checks: Check[]; solution: Step[] } };

/** What a seed makes of the world of any item that has one. */
export interface WorldVariant {
  seed: number;
  params: Params;
  topology: string;
  topologyParams: JsonObject;
  startTime?: number;
  entry?: { machine: string; user: string };
  setup: Step[];
}

export interface LessonVariant extends WorldVariant {
  item: LessonItem;
  steps: LessonVariantStep[];
}

export interface CardVariant {
  item: CardItem;
  seed: number;
  params: Params;
  /** Present when the card has a world. */
  world?: WorldVariant;
  prompt: string;
  figure?: Figure;
  answer: string;
  choices?: string[];
  correct?: number;
  checks: Check[];
  solution: Step[];
}
