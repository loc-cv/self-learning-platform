// A small plugin for kernel tests: random-driven events, an idle heartbeat, inputs, topics. It
// exercises every path through which a world can change, so determinism tests built on it mean
// something. Test support only; not exported from the package.

import type { Json } from '../json.ts';
import type { Plugin } from '../registry.ts';
import type { Ctx } from '../kernel.ts';
import { put, type Table } from '../table.ts';

export interface SimEntry {
  at: number;
  what: string;
  value: number;
}

export interface SimSlice {
  log: Table<SimEntry>;
  totals: { ticks: number; echoes: number };
}

const slice = (ctx: Ctx) => ctx.slice<SimSlice>('sim');

const record = (ctx: Ctx, what: string, value: number): void => {
  const s = slice(ctx);
  put(s.log, `${String(ctx.now).padStart(12, '0')}-${ctx.during}`, { at: ctx.now, what, value });
};

export function simPlugin(options: { tickLimit?: number; variant?: number } = {}): Plugin {
  const limit = options.tickLimit ?? 50;
  const variant = options.variant ?? 0;
  return {
    name: 'sim',
    slice: {
      name: 'sim',
      version: 1,
      init: (): SimSlice => ({ log: {}, totals: { ticks: 0, echoes: 0 } }),
      adopt: (s) => {
        const sim = s as SimSlice;
        for (const k of Object.keys(sim.log)) put(sim.log, k, sim.log[k] as SimEntry);
      },
    },
    handlers: [
      {
        type: 'sim.tick',
        handle(ctx, payload) {
          const n = (payload as { n: number }).n;
          const value = ctx.random('sim.ticks').int(1000) + variant;
          slice(ctx).totals.ticks++;
          record(ctx, `tick ${n}`, value);
          if (n < limit) ctx.schedule(1 + ctx.random('sim.delays').int(500), 'sim.tick', { n: n + 1 });
          if (value % 7 === 0) ctx.publish('sim.lucky');
        },
      },
      {
        type: 'sim.heartbeat',
        idle: true,
        handle(ctx) {
          ctx.schedule(10_000, 'sim.heartbeat', null);
        },
      },
      {
        type: 'sim.echo',
        handle(ctx, payload) {
          slice(ctx).totals.echoes++;
          record(ctx, `echo ${(payload as { name: string }).name}`, ctx.random('sim.echo').int(100));
        },
      },
    ],
    inputs: [
      {
        kind: 'sim.add',
        handle(ctx, input) {
          const name = input.name as string;
          record(ctx, `add ${name}`, 0);
          ctx.schedule(ctx.random('sim.echo').int(50), 'sim.echo', { name } as Json);
          ctx.subscribe('sim.lucky', 'sim.echo', { name: `${name}/lucky` });
        },
      },
    ],
  };
}

/** Starts the tick chain and the heartbeat. */
export function startSim(ctx: Ctx): void {
  ctx.schedule(0, 'sim.tick', { n: 1 });
  ctx.schedule(0, 'sim.heartbeat', null);
}
