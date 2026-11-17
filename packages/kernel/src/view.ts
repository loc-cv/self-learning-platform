// The view contract (PLAN.md §6.5, docs/ARCHITECTURE.md §2.13). A view provider is a pure function
// from a world to a part of a view model: entities, typed relations between them, and a
// description of each kind in a small fixed vocabulary of shapes. The renderer knows the shapes and
// the relation types and nothing else, so it draws any domain; nothing here names one.
//
// A view model is plain data in a defined order (rule 4): the same world gives the same model,
// whether it is the live world, a fork or a world rebuilt by replay.

import type { Json } from './json.ts';
import type { Contribution, Registry } from './registry.ts';
import type { TraceRecord } from './trace.ts';
import { compareCodeUnits } from './table.ts';
import type { World } from './world.ts';

/** Registry kind of view providers. */
export const VIEW = 'view';

/**
 * What a kind looks like (docs/DESIGN.md §6): the renderer draws one shape per entry and lays them
 * out by it.
 *
 * - `host`: something things run on, with its own boundary (a machine, a VM, a member of a cluster).
 * - `scope`: a logical grouping that holds declarations (a project, a tenant, a subnet).
 * - `workload`: a declaration that keeps instances running (a controller of replicas, a unit).
 * - `process`: a running instance (a process, a container group).
 * - `endpoint`: an address traffic is sent to (a virtual IP, a listener, a frontend).
 * - `store`: where data or configuration is kept (a volume, a configuration object, a database).
 * - `rule`: something that admits, denies or steers (a policy, a firewall rule, a route).
 */
export const SHAPES = ['host', 'scope', 'workload', 'process', 'endpoint', 'store', 'rule'] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * The state of an entity, judged by its provider (docs/DESIGN.md §5):
 * - `healthy`: doing what it is declared to do;
 * - `progressing`: on its way there, expected to arrive without help;
 * - `degraded`: partly working, or blocked waiting for something that will not change by itself;
 * - `failed`: not working;
 * - `unknown`: the model cannot tell.
 */
export const VIEW_STATES = ['healthy', 'progressing', 'degraded', 'failed', 'unknown'] as const;
export type ViewState = (typeof VIEW_STATES)[number];

/**
 * Typed links (containment is not one of them: an entity names its container):
 * - `owns`: the source created the target and keeps it (a controller and its instances);
 * - `selects`: the source picks the target by its properties (a label selector);
 * - `routesTo`: traffic sent to the source reaches the target;
 * - `runsOn`: the source runs on the target, where containment cannot say it;
 * - `mounts`: the source reads or writes the target's data;
 * - `uses`: any other dependency the source needs to work.
 */
export const RELATION_TYPES = ['owns', 'selects', 'routesTo', 'runsOn', 'mounts', 'uses'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** A label and a value worth showing: `Address`, `10.0.0.11`. */
export interface ViewFact {
  label: string;
  value: string;
  /**
   * For a fact that is a list (labels, flags): its entries in the order shown, each starting with
   * its key (`disktype=ssd`). `value` is the whole list as the domain's tool prints it. A figure can
   * show some entries by key (docs/SCENARIO_FORMAT.md §11).
   */
  items?: string[];
}

export interface ViewEntity {
  /** Stable across worlds and time: the same thing keeps its id. Unique within the model. */
  id: string;
  /** One of the model's kinds. */
  kind: string;
  /** What the entity is called. */
  label: string;
  /** The entity that contains it; none for a top-level entity. */
  container?: string;
  /** A `scope` entity it belongs to when that is not its container: what a filter by scope reads. */
  scope?: string;
  state: ViewState;
  /** The state in the domain's own words, as its tools print it: `running`, `2/3`. */
  status?: string;
  /** Facts in the provider's order. */
  facts: ViewFact[];
  /** Present but inactive (scaled to zero, stopped): drawn quieter. */
  muted?: boolean;
  /** Part of the platform itself rather than the learner's work: filtered out by default. */
  system?: boolean;
}

export interface ViewRelation {
  type: RelationType;
  from: string;
  to: string;
}

export interface ViewKind {
  /** Unique within the model: `<provider>.<Kind>`. */
  kind: string;
  shape: Shape;
  /** The kind's name in the domain's words, singular and plural. */
  label: string;
  plural: string;
  /**
   * The kind of container this kind normally sits in. An entity of this kind without a container
   * is drawn apart, in a lane captioned `unplaced`.
   */
  placedIn?: string;
  unplaced?: string;
}

/** What one provider contributes. */
export interface ViewPart {
  kinds: ViewKind[];
  entities: ViewEntity[];
  relations: ViewRelation[];
}

export interface ViewModel extends ViewPart {
  /** Virtual time of the world it was taken from. */
  t: number;
}

/** How an event reads against the colors of states: it helped, it hurt, or it only happened. */
export const VIEW_TONES = ['good', 'bad', 'neutral'] as const;
export type ViewTone = (typeof VIEW_TONES)[number];

/** One line under an event: a verdict per candidate, a member of a set. */
export interface ViewEventItem {
  /** The entity the line is about, when it is one of the model's. */
  entity?: string;
  label: string;
  value: string;
  tone: ViewTone;
}

/**
 * A trace record as the views show it (PLAN.md §6.1 "Trace bus", §6.5): what a component did and
 * why, tied to the entities of the view model. A provider maps the records of its own components;
 * records it does not map stay out of every view. The text is simulator vocabulary, never a real
 * tool's output, and is shown as such (docs/ARCHITECTURE.md §2.9).
 */
export interface ViewEvent {
  /** The trace record's id: ordered, unique within a run. */
  id: number;
  t: number;
  /** For something that takes time (a command that runs for a while): when it ended, once it has. */
  until?: number;
  /** The component that acted, in the domain's words. */
  actor: string;
  /** What it did and why, as a sentence. */
  text: string;
  /** Entity ids, the one it happened to first. An id may name an entity that no longer exists. */
  about: string[];
  /** `key`: changed what the learner can see, or decided something. `detail`: bookkeeping around it. */
  level: 'key' | 'detail';
  tone: ViewTone;
  /**
   * The cause travelled from one entity to another (a controller created an instance, a placer
   * bound it). The renderer may move something along this pair, and along nothing else.
   */
  link?: { from: string; to: string };
  /** A command someone typed in a terminal: the learner's in a session, a script's in a setup. */
  input?: true;
  items?: ViewEventItem[];
  /**
   * What it follows from. A provider gives trace record ids; `buildEvents` resolves them to the
   * ids of the nearest events, through records that no event shows.
   */
  causes: number[];
  /**
   * The provider's own notes on the event, for its `why`: opaque to everything else, kept by
   * whoever passes events on.
   */
  detail?: Json;
}

/** Why an entity is in the state it is in: a sentence, and the events that led there, oldest first. */
export interface Why {
  entity: string;
  summary: string;
  steps: ViewEvent[];
}

export interface ViewProviderSpec extends Contribution {
  /** Pure: reads the world, changes nothing, depends on nothing else. */
  view(world: World): ViewPart;
  /**
   * The provider's reading of the trace: the records of its components as events, in record
   * order. Pure, and a function of the records alone, so the trace of a replay reads the same.
   */
  events?(records: readonly TraceRecord[]): ViewEvent[];
  /**
   * Why one of the provider's entities is in its state, from the world and the events (all
   * providers', as `buildEvents` returns them). Undefined for an entity that is not its own.
   */
  why?(world: World, events: readonly ViewEvent[], entity: string): Why | undefined;
}

const byKey =
  <T>(key: (x: T) => string) =>
  (a: T, b: T): number =>
    compareCodeUnits(key(a), key(b));

const relationKey = (r: ViewRelation): string => `${r.from}\u0000${r.type}\u0000${r.to}`;

/**
 * The view of a world: every registered provider's part, merged and put in a defined order (kinds
 * by kind, entities by id, relations by source, type and target). Relations whose ends are not in
 * the model are dropped: a provider may point at another provider's entity that does not exist in
 * this world.
 */
export function buildView(registry: Registry, world: World): ViewModel {
  const kinds: ViewKind[] = [];
  const entities: ViewEntity[] = [];
  const relations: ViewRelation[] = [];
  for (const p of registry.list<ViewProviderSpec>(VIEW)) {
    const part = p.view(world);
    kinds.push(...part.kinds);
    entities.push(...part.entities);
    relations.push(...part.relations);
  }
  const ids = new Set(entities.map((e) => e.id));
  const seen = new Set<string>();
  const rels = relations.filter((r) => {
    const k = relationKey(r);
    if (seen.has(k) || !ids.has(r.from) || !ids.has(r.to)) return false;
    seen.add(k);
    return true;
  });
  return {
    t: world.clock.now,
    kinds: kinds.sort(byKey((k) => k.kind)),
    entities: entities.sort(byKey((e) => e.id)),
    relations: rels.sort(byKey(relationKey)),
  };
}

/**
 * Every provider's events, in record order, with `causes` resolved: each cause is followed through
 * the records' own `causes` until it reaches a record that is an event, so a chain reads from event
 * to event even where the steps between are not shown.
 */
export function buildEvents(registry: Registry, records: readonly TraceRecord[]): ViewEvent[] {
  const events: ViewEvent[] = [];
  for (const p of registry.list<ViewProviderSpec>(VIEW)) if (p.events) events.push(...p.events(records));
  events.sort((a, b) => a.id - b.id);
  const shown = new Set(events.map((e) => e.id));
  const byId = new Map(records.map((r) => [r.id, r]));
  const resolve = (id: number, seen: Set<number>, out: Set<number>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (shown.has(id)) {
      out.add(id);
      return;
    }
    for (const c of byId.get(id)?.causes ?? []) resolve(c, seen, out);
  };
  return events.map((e) => {
    const out = new Set<number>();
    const seen = new Set<number>([e.id]);
    for (const c of e.causes) resolve(c, seen, out);
    return { ...e, causes: [...out].sort((a, b) => a - b) };
  });
}

/** Why `entity` is in its state: the answer of the provider that owns it. */
export function buildWhy(registry: Registry, world: World, events: readonly ViewEvent[], entity: string): Why | undefined {
  for (const p of registry.list<ViewProviderSpec>(VIEW)) {
    const w = p.why?.(world, events, entity);
    if (w) return w;
  }
  return undefined;
}

/** Problems with events: unknown levels and tones, causes that do not precede, items without words. */
export function validateEvents(events: readonly ViewEvent[]): string[] {
  const problems: string[] = [];
  const ids = new Set<number>();
  let last = -Infinity;
  for (const e of events) {
    const at = `event ${e.id}`;
    if (ids.has(e.id)) problems.push(`${at}: two events with this id`);
    if (e.id < last) problems.push(`${at}: out of record order`);
    last = e.id;
    ids.add(e.id);
    if (e.level !== 'key' && e.level !== 'detail') problems.push(`${at}: unknown level ${String(e.level)}`);
    if (!(VIEW_TONES as readonly string[]).includes(e.tone)) problems.push(`${at}: unknown tone ${String(e.tone)}`);
    if (e.actor === '' || e.text === '') problems.push(`${at}: an event names who acted and what happened`);
    for (const c of e.causes) if (c >= e.id) problems.push(`${at}: cause ${c} does not precede it`);
    for (const i of e.items ?? []) if (!(VIEW_TONES as readonly string[]).includes(i.tone) || i.label === '') problems.push(`${at}: a malformed item`);
  }
  return problems;
}

/** Problems with a view model: duplicate ids, unknown kinds, shapes, states or containers, cycles. */
export function validateView(m: ViewPart): string[] {
  const problems: string[] = [];
  const kinds = new Map<string, ViewKind>();
  for (const k of m.kinds) {
    if (kinds.has(k.kind)) problems.push(`kind ${k.kind}: described twice`);
    if (!(SHAPES as readonly string[]).includes(k.shape)) problems.push(`kind ${k.kind}: unknown shape ${k.shape}`);
    kinds.set(k.kind, k);
  }
  const ents = new Map<string, ViewEntity>();
  for (const e of m.entities) {
    if (ents.has(e.id)) problems.push(`${e.id}: two entities with this id`);
    ents.set(e.id, e);
    if (!kinds.has(e.kind)) problems.push(`${e.id}: kind ${e.kind} is not described`);
    if (!(VIEW_STATES as readonly string[]).includes(e.state)) problems.push(`${e.id}: unknown state ${e.state}`);
  }
  for (const e of m.entities) {
    if (e.container !== undefined && !ents.has(e.container)) problems.push(`${e.id}: container ${e.container} is not in the model`);
    if (e.scope !== undefined && kinds.get(ents.get(e.scope)?.kind ?? '')?.shape !== 'scope') problems.push(`${e.id}: scope ${e.scope} is not a scope entity`);
    const path = new Set<string>([e.id]);
    for (let c = e.container; c !== undefined; c = ents.get(c)?.container) {
      if (path.has(c)) {
        problems.push(`${e.id}: containment cycle through ${c}`);
        break;
      }
      path.add(c);
    }
  }
  for (const r of m.relations) {
    if (!(RELATION_TYPES as readonly string[]).includes(r.type)) problems.push(`relation ${r.from} → ${r.to}: unknown type ${r.type}`);
    if (!ents.has(r.from) || !ents.has(r.to)) problems.push(`relation ${r.type} ${r.from} → ${r.to}: an end is not in the model`);
  }
  return problems;
}
