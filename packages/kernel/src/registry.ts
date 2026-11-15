// Plugin registry (docs/ARCHITECTURE.md §2.11). Built once from a fixed list of plugins and
// immutable afterwards. It is code and static data, so it lives outside world state and every
// world on one engine shares it.

import type { Json } from './json.ts';
import type { Ctx } from './kernel.ts';
import type { SliceSpec } from './world.ts';
import { compareCodeUnits } from './table.ts';

export interface HandlerSpec {
  /** Event type, dotted and prefixed by the plugin: `host.proc.run`. */
  type: string;
  /** Periodic background work (heartbeats, resyncs); `settle` does not wait for it. */
  idle?: boolean;
  handle(ctx: Ctx, payload: Json): void;
}

/** An input as delivered from outside: terminal bytes, an editor result, a UI action (§2.8). */
export interface Input {
  kind: string;
  [field: string]: Json;
}

export interface InputHandlerSpec {
  /** Input kind: `tty.bytes`, `editor.save`, `learn.action`. */
  kind: string;
  handle(ctx: Ctx, input: Input): void;
}

export interface Contribution {
  /** Unique within its kind: `k8s.podsReady`, `kubeadm-1cp-2w`, `ls`. */
  name: string;
  [field: string]: unknown;
}

export interface Plugin {
  name: string;
  /** Plugins this one builds on; registration order follows it. */
  requires?: string[];
  slice?: SliceSpec<unknown>;
  handlers?: HandlerSpec[];
  inputs?: InputHandlerSpec[];
  /** Contributions for other layers, keyed by registry kind: `check`, `program`, `fileProvider`, … */
  contributions?: { [kind: string]: Contribution[] };
}

export interface Registry {
  /** Plugins in registration order: each after the plugins it requires. */
  readonly plugins: readonly Plugin[];
  /** Slices in registration order. */
  readonly slices: readonly SliceSpec<unknown>[];
  /** The handler for an event type. Throws if none is registered: that is an engine bug. */
  handler(type: string): HandlerSpec;
  /** The handler for an input kind. Throws if none is registered. */
  input(kind: string): InputHandlerSpec;
  get<T extends Contribution>(kind: string, name: string): T | undefined;
  /** Contributions of one kind, sorted by name. */
  list<T extends Contribution>(kind: string): T[];
}

/**
 * The kernel's own registrations. `learn.action` inputs (hint shown, check pressed) change nothing
 * in the world; they are delivered only so the input log places them on the timeline (§2.8).
 */
export const kernelPlugin: Plugin = {
  name: 'kernel',
  inputs: [{ kind: 'learn.action', handle: () => {} }],
};

/** Builds the registry. The kernel plugin is always included first. */
export function createRegistry(plugins: readonly Plugin[]): Registry {
  const ordered = orderPlugins([kernelPlugin, ...plugins.filter((p) => p !== kernelPlugin)]);
  const handlers = new Map<string, HandlerSpec>();
  const inputs = new Map<string, InputHandlerSpec>();
  const contributions = new Map<string, Map<string, Contribution>>();
  const slices: SliceSpec<unknown>[] = [];

  for (const plugin of ordered) {
    if (plugin.slice) {
      if (plugin.slice.name !== plugin.name) {
        throw new Error(`plugin ${plugin.name}: its slice must be named after it, not ${plugin.slice.name}`);
      }
      slices.push(plugin.slice);
    }
    for (const h of plugin.handlers ?? []) {
      if (handlers.has(h.type)) throw new Error(`plugin ${plugin.name}: event type ${h.type} already has a handler`);
      handlers.set(h.type, h);
    }
    for (const i of plugin.inputs ?? []) {
      if (inputs.has(i.kind)) throw new Error(`plugin ${plugin.name}: input kind ${i.kind} already has a handler`);
      inputs.set(i.kind, i);
    }
    for (const kind of Object.keys(plugin.contributions ?? {}).sort(compareCodeUnits)) {
      const byName = contributions.get(kind) ?? new Map<string, Contribution>();
      contributions.set(kind, byName);
      for (const c of plugin.contributions?.[kind] ?? []) {
        if (byName.has(c.name)) throw new Error(`plugin ${plugin.name}: ${kind} ${c.name} is already registered`);
        byName.set(c.name, c);
      }
    }
  }

  const sortedLists = new Map<string, Contribution[]>();
  for (const [kind, byName] of contributions) {
    sortedLists.set(kind, [...byName.values()].sort((a, b) => compareCodeUnits(a.name, b.name)));
  }

  return Object.freeze({
    plugins: Object.freeze(ordered),
    slices: Object.freeze(slices),
    handler(type: string): HandlerSpec {
      const h = handlers.get(type);
      if (!h) throw new Error(`no handler registered for event type ${type}`);
      return h;
    },
    input(kind: string): InputHandlerSpec {
      const h = inputs.get(kind);
      if (!h) throw new Error(`no handler registered for input kind ${kind}`);
      return h;
    },
    get<T extends Contribution>(kind: string, name: string): T | undefined {
      return contributions.get(kind)?.get(name) as T | undefined;
    },
    list<T extends Contribution>(kind: string): T[] {
      return ((sortedLists.get(kind) ?? []) as T[]).slice();
    },
  });
}

/** Each plugin after the plugins it requires; otherwise the given order. */
function orderPlugins(plugins: readonly Plugin[]): Plugin[] {
  const byName = new Map<string, Plugin>();
  for (const p of plugins) {
    if (byName.has(p.name)) throw new Error(`plugin ${p.name} is registered twice`);
    byName.set(p.name, p);
  }
  const out: Plugin[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (p: Plugin, chain: string[]): void => {
    const s = state.get(p.name);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`plugin requirements form a cycle: ${[...chain, p.name].join(' → ')}`);
    state.set(p.name, 'visiting');
    for (const req of p.requires ?? []) {
      const dep = byName.get(req);
      if (!dep) throw new Error(`plugin ${p.name} requires ${req}, which is not registered`);
      visit(dep, [...chain, p.name]);
    }
    state.set(p.name, 'done');
    out.push(p);
  };
  for (const p of plugins) visit(p, []);
  return out;
}
