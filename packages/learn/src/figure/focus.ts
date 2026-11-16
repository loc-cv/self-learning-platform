// From a world's whole view model to what one figure draws (docs/SCENARIO_FORMAT.md §11): the
// entities its focus selects, the containers they need, the facts it shows, and the entities its
// highlights and notes point at. Domain-agnostic: kinds and scopes are matched by the labels the
// view model gives them, facts by their labels.

import type { ViewEntity, ViewFact, ViewKind, ViewModel } from '@simlab/kernel';
import type { Change, EntityRef, Focus, Note, Panel, RenderedNote, ShowItem } from './types.ts';

const asList = (x: string | string[] | undefined): string[] | undefined => (x === undefined ? undefined : Array.isArray(x) ? x : [x]);

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/** `Kind/label`: the kind label and a matcher of entity labels. */
export function parseRef(ref: EntityRef): { kind: string; label: RegExp } | undefined {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { kind: ref.slice(0, i), label: globToRegExp(ref.slice(i + 1)) };
}

/** The ids of the entities of `model` a reference names, in model order. */
export function resolveRef(model: ViewModel, ref: EntityRef): string[] {
  const r = parseRef(ref);
  if (!r) return [];
  const kinds = new Set(model.kinds.filter((k) => k.label === r.kind).map((k) => k.kind));
  return model.entities.filter((e) => kinds.has(e.kind) && r.label.test(e.label)).map((e) => e.id);
}

/** The scope an entity belongs to: its own `scope`, or the nearest scope entity that contains it. */
function scopeOf(e: ViewEntity, kinds: Map<string, ViewKind>, byId: Map<string, ViewEntity>): ViewEntity | undefined {
  if (e.scope !== undefined) return byId.get(e.scope);
  for (let c: ViewEntity | undefined = e; c !== undefined; c = c.container === undefined ? undefined : byId.get(c.container)) {
    if (kinds.get(c.kind)?.shape === 'scope') return c;
  }
  return undefined;
}

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A fact entry belongs to a key when it starts with the key followed by `=`, `:` or nothing. */
function entryHasKey(entry: string, key: string): boolean {
  if (!entry.startsWith(key)) return false;
  const next = entry.charAt(key.length);
  return next === '' || next === '=' || next === ':' || next === ' ';
}

/** The facts `show` names, in its order; list facts cut to the entries of the keys it names. */
export function showFacts(facts: readonly ViewFact[], show: readonly ShowItem[] | undefined): ViewFact[] {
  const out: ViewFact[] = [];
  for (const s of show ?? []) {
    const name = typeof s === 'string' ? s : s.fact;
    const f = facts.find((x) => sameText(x.label, name));
    if (!f) continue;
    if (typeof s === 'string') {
      out.push({ ...f });
      continue;
    }
    const items = (f.items ?? []).filter((it) => s.keys.some((k) => entryHasKey(it, k)));
    if (items.length > 0) out.push({ label: f.label, value: items.join(', '), items });
  }
  return out;
}

/**
 * The part of a model a focus selects, with the facts `show` names. An entity keeps its container
 * when the container is selected too, when it is a scope the focus names, or when the entity's kind
 * is placed in containers of that kind (a selected instance pulls in the host it runs on, so it is
 * never drawn as unplaced); otherwise it moves up to the nearest container that stays.
 */
export function focusView(model: ViewModel, focus: Focus | undefined, show: readonly ShowItem[] | undefined): ViewModel {
  const kinds = new Map(model.kinds.map((k) => [k.kind, k]));
  const byId = new Map(model.entities.map((e) => [e.id, e]));
  const scopes = asList(focus?.scope);
  const kindLabels = focus?.kinds;
  const refs = focus?.entities?.map(parseRef);
  const selected = new Set<string>();
  for (const e of model.entities) {
    const k = kinds.get(e.kind);
    if (e.system === true && focus?.system !== true) continue;
    if (kindLabels && !kindLabels.includes(k?.label ?? '')) continue;
    if (scopes) {
      if (k?.shape === 'scope') {
        if (!scopes.includes(e.label)) continue;
      } else {
        const s = scopeOf(e, kinds, byId);
        if (s !== undefined && !scopes.includes(s.label)) continue;
      }
    }
    if (refs && !refs.some((r) => r !== undefined && r.kind === k?.label && r.label.test(e.label))) continue;
    selected.add(e.id);
  }
  // Containers pulled in by what they hold, and the scopes the focus names.
  const kept = new Set(selected);
  for (const id of selected) {
    const e = byId.get(id) as ViewEntity;
    const c = e.container === undefined ? undefined : byId.get(e.container);
    if (!c) continue;
    const placedIn = kinds.get(e.kind)?.placedIn;
    if (placedIn === c.kind || (scopes && kinds.get(c.kind)?.shape === 'scope' && scopes.includes(c.label))) kept.add(c.id);
  }
  const containerOf = (e: ViewEntity): string | undefined => {
    for (let c = e.container; c !== undefined; c = byId.get(c)?.container) if (kept.has(c)) return c;
    return undefined;
  };
  const entities: ViewEntity[] = [];
  for (const e of model.entities) {
    if (!kept.has(e.id)) continue;
    const { container: _c, scope: _s, facts, ...rest } = e;
    const out: ViewEntity = { ...rest, facts: showFacts(facts, show) };
    const c = containerOf(e);
    if (c !== undefined) out.container = c;
    if (e.scope !== undefined && kept.has(e.scope)) out.scope = e.scope;
    entities.push(out);
  }
  const usedKinds = new Set(entities.map((e) => e.kind));
  return {
    t: model.t,
    kinds: model.kinds.filter((k) => usedKinds.has(k.kind)),
    entities,
    relations: model.relations.filter((r) => kept.has(r.from) && kept.has(r.to)),
  };
}

export interface Marks {
  highlight?: readonly EntityRef[];
  notes?: readonly Note[];
}

/** Highlights and notes resolved against a focused model; `missing` lists references that name nothing. */
export function markPanel(model: ViewModel, marks: Marks, title: string | undefined, firstNote = 1): { panel: Panel; missing: string[] } {
  const missing: string[] = [];
  const highlight: string[] = [];
  for (const ref of marks.highlight ?? []) {
    const ids = resolveRef(model, ref);
    if (ids.length === 0) missing.push(ref);
    for (const id of ids) if (!highlight.includes(id)) highlight.push(id);
  }
  const notes: RenderedNote[] = (marks.notes ?? []).map((n, i) => {
    const on = n.on === undefined ? [] : resolveRef(model, n.on);
    if (n.on !== undefined && on.length === 0) missing.push(n.on);
    const out: RenderedNote = { n: firstNote + i, on, text: n.text };
    if (n.divergence !== undefined) out.divergence = n.divergence;
    return out;
  });
  const panel: Panel = { model, highlight, notes, changes: {} };
  if (title !== undefined) panel.title = title;
  return { panel, missing };
}

/** What a comparable entity looks like, for telling whether it changed. */
const look = (e: ViewEntity): string => JSON.stringify([e.state, e.status ?? '', e.container ?? '', e.muted === true, e.facts.map((f) => [f.label, f.value])]);

/** Marks what only one side has, and what both have but differently (on the right). */
export function markChanges(left: Panel, right: Panel): void {
  const l = new Map(left.model.entities.map((e) => [e.id, e]));
  const r = new Map(right.model.entities.map((e) => [e.id, e]));
  const lc: Record<string, Change> = {};
  const rc: Record<string, Change> = {};
  for (const [id, e] of r) {
    const before = l.get(id);
    if (!before) rc[id] = 'added';
    else if (look(before) !== look(e)) rc[id] = 'changed';
  }
  for (const id of l.keys()) if (!r.has(id)) lc[id] = 'removed';
  left.changes = lc;
  right.changes = rc;
}

/** The model without its time, for telling whether two frames differ. */
export function viewKey(m: ViewModel): string {
  const { t: _t, ...rest } = m;
  return JSON.stringify(rest);
}
