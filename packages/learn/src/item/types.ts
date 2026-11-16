// A content item as written (docs/SCENARIO_FORMAT.md §2), after YAML parsing: plain JSON data.
// The schema (schema.ts) is what guarantees these shapes; the types only name them.

import type { Json } from '@simlab/kernel';

export type JsonObject = { [key: string]: Json };

export type ItemKind = 'lab' | 'drill' | 'incident';

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

export type Debrief = string | { text: string; when?: When }[];

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
  kind: ItemKind;
  title: string;
  skills: string[];
  curriculum: string[];
  difficulty: number;
  targetMinutes: number;
  world: World;
  ticket: string;
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
  ticket: string;
  hints: string[];
  checks: Check[];
  solutions: Solution[];
  debrief: string;
}
