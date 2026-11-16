// Which entities a view shows: by default everything but the platform's own (`system`) entities;
// or everything; or one scope and what belongs to it, with the entities that belong to no scope
// (the hosts things run on).

import type { ViewEntity, ViewKind, ViewModel } from '@simlab/kernel';

/** `mine`: all but system entities; `all`; or the id of one scope entity. */
export type ScopeFilter = 'mine' | 'all' | { scope: string };

/** The scope an entity belongs to: its own `scope`, the nearest scope that contains it, or itself. */
export function scopeOf(e: ViewEntity, kinds: Map<string, ViewKind>, byId: Map<string, ViewEntity>): string | undefined {
  if (e.scope !== undefined) return e.scope;
  for (let c: ViewEntity | undefined = e; c !== undefined; c = c.container === undefined ? undefined : byId.get(c.container)) {
    if (kinds.get(c.kind)?.shape === 'scope') return c.id;
  }
  return undefined;
}

export function visibility(model: ViewModel, filter: ScopeFilter): (e: ViewEntity) => boolean {
  const kinds = new Map(model.kinds.map((k) => [k.kind, k]));
  const byId = new Map(model.entities.map((e) => [e.id, e]));
  return (e) => {
    if (filter === 'all') return true;
    if (filter === 'mine') return e.system !== true;
    const s = scopeOf(e, kinds, byId);
    return s === undefined || s === filter.scope;
  };
}

/** The scopes a filter can pick, in model order: label and id. */
export function scopes(model: ViewModel): { id: string; label: string; system: boolean }[] {
  const shapes = new Map(model.kinds.map((k) => [k.kind, k.shape]));
  return model.entities.filter((e) => shapes.get(e.kind) === 'scope').map((e) => ({ id: e.id, label: e.label, system: e.system === true }));
}

/** What the scope kind is called, for the filter's label. */
export function scopeKind(model: ViewModel): ViewKind | undefined {
  return model.kinds.find((k) => k.shape === 'scope');
}
