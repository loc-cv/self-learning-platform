// The view contract (PLAN.md §6.5, docs/ARCHITECTURE.md §2.13). A view provider is a pure function
// from a world to a part of a view model: entities, typed relations between them, and a
// description of each kind in a small fixed vocabulary of shapes. The renderer knows the shapes and
// the relation types and nothing else, so it draws any domain; nothing here names one.
//
// A view model is plain data in a defined order (rule 4): the same world gives the same model,
// whether it is the live world, a fork or a world rebuilt by replay.

import type { Contribution, Registry } from './registry.ts';
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

export interface ViewProviderSpec extends Contribution {
  /** Pure: reads the world, changes nothing, depends on nothing else. */
  view(world: World): ViewPart;
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
