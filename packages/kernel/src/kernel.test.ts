import { describe, expect, test } from 'vitest';
import { bootKernel, MAX_EVENTS_PER_INSTANT, type Ctx } from './kernel.ts';
import type { Json } from './json.ts';
import { createRegistry, type Plugin } from './registry.ts';
import type { GapEvent, TraceRecord } from './trace.ts';

/** A plugin whose handlers append to a log outside the world, to observe dispatch order. */
function recorder(): { plugin: Plugin; seen: string[] } {
  const seen: string[] = [];
  const plugin: Plugin = {
    name: 'rec',
    handlers: [
      { type: 'rec.a', handle: (ctx, p) => seen.push(`a:${String(p)}@${ctx.now}`) },
      { type: 'rec.b', handle: (ctx, p) => seen.push(`b:${String(p)}@${ctx.now}`) },
      { type: 'rec.idle', idle: true, handle: (ctx) => void ctx.schedule(100, 'rec.idle', null) },
      {
        type: 'rec.chain',
        handle(ctx, p) {
          seen.push(`chain:${String(p)}@${ctx.now}`);
          if ((p as number) > 0) ctx.schedule(0, 'rec.chain', (p as number) - 1);
        },
      },
      { type: 'rec.loop', handle: (ctx) => void ctx.schedule(0, 'rec.loop', null) },
    ],
    inputs: [{ kind: 'rec.in', handle: (ctx, i) => seen.push(`in:${String(i.v)}@${ctx.now}`) }],
  };
  return { plugin, seen };
}

function boot(plugins: Plugin[] = [], extra: Partial<Parameters<typeof bootKernel>[1]> = {}) {
  return bootKernel(createRegistry(plugins), { seed: 1, startTime: 1000, ...extra });
}

describe('event queue', () => {
  test('orders by time, then by scheduling order', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.act('setup', (ctx) => {
      ctx.schedule(20, 'rec.a', 1);
      ctx.schedule(10, 'rec.b', 2);
      ctx.schedule(10, 'rec.a', 3);
      ctx.schedule(0, 'rec.b', 4);
      ctx.schedule(20, 'rec.b', 5);
    });
    k.runUntil(1020);
    expect(seen).toEqual(['b:4@1000', 'b:2@1010', 'a:3@1010', 'a:1@1020', 'b:5@1020']);
  });

  test('runUntil runs events at exactly t and leaves the clock at t', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.act('setup', (ctx) => {
      ctx.schedule(10, 'rec.a', 1);
      ctx.schedule(11, 'rec.a', 2);
    });
    k.runUntil(1010);
    expect(seen).toEqual(['a:1@1010']);
    expect(k.now).toBe(1010);
    k.advance(5);
    expect(seen).toEqual(['a:1@1010', 'a:2@1011']);
    expect(k.now).toBe(1015);
  });

  test('events scheduled at delay zero run at the same instant, after those already due', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.act('setup', (ctx) => {
      ctx.schedule(5, 'rec.chain', 2);
      ctx.schedule(5, 'rec.a', 9);
    });
    k.advance(5);
    expect(seen).toEqual(['chain:2@1005', 'a:9@1005', 'chain:1@1005', 'chain:0@1005']);
  });

  test('cancel removes a pending event and reports whether it was pending', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    const ids = k.act('setup', (ctx) => [ctx.schedule(1, 'rec.a', 1), ctx.schedule(2, 'rec.a', 2), ctx.schedule(3, 'rec.a', 3)]);
    expect(k.act('t', (ctx) => ctx.cancel(ids[1] as string))).toBe(true);
    expect(k.act('t', (ctx) => ctx.cancel(ids[1] as string))).toBe(false);
    k.advance(10);
    expect(seen).toEqual(['a:1@1001', 'a:3@1003']);
    expect(k.act('t', (ctx) => ctx.cancel(ids[0] as string))).toBe(false);
  });

  test('refuses the past, fractions, and unknown event types', () => {
    const { plugin } = recorder();
    const k = boot([plugin]);
    expect(() => k.act('t', (ctx) => ctx.schedule(-1, 'rec.a', null))).toThrow(RangeError);
    expect(() => k.act('t', (ctx) => ctx.schedule(0.5, 'rec.a', null))).toThrow(RangeError);
    expect(() => k.act('t', (ctx) => ctx.schedule(0, 'rec.none', null))).toThrow('no handler registered for event type rec.none');
    expect(() => k.runUntil(999)).toThrow('in the past');
    expect(() => k.advance(-1)).toThrow(RangeError);
  });

  test('payloads are frozen with the event', () => {
    const k = boot([recorder().plugin]);
    const payload = { list: [1] };
    k.act('t', (ctx) => ctx.schedule(1, 'rec.a', payload));
    expect(Object.isFrozen(k.world.queue[0]?.payload)).toBe(true);
  });

  test('a livelock at one instant is detected and names the event types', () => {
    const k = boot([recorder().plugin]);
    k.act('t', (ctx) => ctx.schedule(0, 'rec.loop', null));
    expect(() => k.advance(0)).toThrow(new RegExp(`more than ${MAX_EVENTS_PER_INSTANT} events .* \\(rec\\.loop ×${MAX_EVENTS_PER_INSTANT + 1}\\)`));
  });
});

describe('settle and nextEventTime', () => {
  test('quiet when only idle events remain, without moving the clock', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.act('setup', (ctx) => {
      ctx.schedule(0, 'rec.idle', null);
      ctx.schedule(50, 'rec.a', 1);
    });
    expect(k.nextEventTime()).toBe(1050);
    expect(k.settle({ timeout: 10_000 })).toBe('quiet');
    expect(seen).toEqual(['a:1@1050']);
    expect(k.now).toBe(1050);
    expect(k.nextEventTime()).toBeUndefined();
    expect(k.world.queue.length).toBe(1); // the heartbeat is still pending
  });

  test('timeout when work remains past the window; the clock ends at the deadline', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.act('setup', (ctx) => {
      ctx.schedule(10, 'rec.a', 1);
      ctx.schedule(500, 'rec.a', 2);
    });
    expect(k.settle({ timeout: 100 })).toBe('timeout');
    expect(seen).toEqual(['a:1@1010']);
    expect(k.now).toBe(1100);
  });

  test('until stops as soon as the predicate holds', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.act('setup', (ctx) => {
      for (let i = 1; i <= 5; i++) ctx.schedule(i * 10, 'rec.a', i);
    });
    expect(k.settle({ timeout: 1000, until: () => seen.length >= 3 })).toBe('until');
    expect(k.now).toBe(1030);
    expect(k.settle({ timeout: 0, until: () => true })).toBe('until');
  });
});

describe('topics', () => {
  test('publish wakes waiters once, in subscription order; unsubscribe withdraws one', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    const ids = k.act('setup', (ctx) => [
      ctx.subscribe('t1', 'rec.a', 'first'),
      ctx.subscribe('t1', 'rec.b', 'second'),
      ctx.subscribe('t1', 'rec.a', 'third'),
    ]);
    k.act('t', (ctx) => ctx.unsubscribe('t1', ids[1] as string));
    k.act('t', (ctx) => ctx.publish('t1'));
    k.act('t', (ctx) => ctx.publish('t1'));
    k.act('t', (ctx) => ctx.publish('nobody'));
    k.advance(0);
    expect(seen).toEqual(['a:first@1000', 'a:third@1000']);
    expect(k.world.topics).toEqual({});
  });
});

describe('inputs, trace and gaps', () => {
  test('inputs reach their handler at the current time; unknown kinds throw', () => {
    const { plugin, seen } = recorder();
    const k = boot([plugin]);
    k.advance(7);
    k.input({ kind: 'rec.in', v: 'x' });
    expect(seen).toEqual(['in:x@1007']);
    expect(() => k.input({ kind: 'nope' })).toThrow('no handler registered for input kind nope');
    k.input({ kind: 'learn.action', action: 'hint' });
    expect(() => k.input({ kind: 'rec.in', v: undefined as unknown as Json })).toThrow(/not JSON data/);
  });

  test('trace records carry time, what was being handled, and causes; events carry their cause', () => {
    const port: TraceRecord[] = [];
    const tracer: Plugin = {
      name: 'tr',
      handlers: [
        {
          type: 'tr.step',
          handle(ctx: Ctx) {
            ctx.trace({ source: 'tr', kind: 'step.ran', message: 'ran' });
          },
        },
      ],
      inputs: [
        {
          kind: 'tr.go',
          handle(ctx) {
            const id = ctx.trace({ source: 'tr', kind: 'go', message: 'go' });
            ctx.trace({ source: 'tr', kind: 'go.more', message: 'more', causes: [id] });
            ctx.schedule(5, 'tr.step', null);
          },
        },
      ],
    };
    const k = boot([tracer], { ports: { trace: (r) => port.push(r) } });
    k.input({ kind: 'tr.go' });
    const ev = k.world.queue[0];
    expect(ev?.cause).toBe('in1');
    k.advance(5);
    expect(port.map((r) => [r.id, r.kind, r.t, r.during, r.causes ?? []])).toEqual([
      [1, 'go', 1000, 'in1', []],
      [2, 'go.more', 1000, 'in1', [1]],
      [3, 'step.ran', 1005, ev?.id, []],
    ]);
    expect(k.traceRecords()).toEqual(port);
  });

  test('the trace buffer is bounded', () => {
    const k = boot([], { traceCapacity: 3 });
    k.act('t', (ctx) => {
      for (let i = 0; i < 5; i++) ctx.trace({ source: 's', kind: 'k', message: String(i) });
    });
    expect(k.traceRecords().map((r) => r.message)).toEqual(['2', '3', '4']);
  });

  test('gap records are completed with seed, machine and virtual time', () => {
    const gaps: GapEvent[] = [];
    const k = boot([], { ports: { gap: (g) => gaps.push(g) }, seed: 9 });
    k.advance(250);
    k.act('t', (ctx) =>
      ctx.gap({ kind: 'flag', program: 'ls', what: '--hyperlink', commandLine: 'ls --hyperlink', machine: 'node01' }),
    );
    expect(gaps).toEqual([
      {
        v: 1,
        kind: 'flag',
        program: 'ls',
        what: '--hyperlink',
        commandLine: 'ls --hyperlink',
        key: 'flag:ls:--hyperlink',
        context: { machine: 'node01', seed: 9, virtualTime: 1250 },
      },
    ]);
  });

  test('counters start at 1 and live in the world', () => {
    const k = boot();
    expect(k.act('t', (ctx) => [ctx.nextId('pid'), ctx.nextId('pid'), ctx.nextId('ino')])).toEqual([1, 2, 1]);
    expect(k.world.counters).toEqual({ pid: 2, ino: 1 });
  });

  test('slice access fails loudly for an unknown slice', () => {
    const k = boot();
    expect(() => k.act('t', (ctx) => ctx.slice('nope'))).toThrow('no slice named nope');
  });
});

describe('slice attach hook and output port', () => {
  test('attach runs when a kernel is created over a world: at boot, fork and restore', () => {
    const calls: string[] = [];
    const plugin: Plugin = {
      name: 'att',
      slice: {
        name: 'att',
        version: 1,
        init: () => ({ n: 0 }),
        adopt: () => {},
        attach(ctx) {
          calls.push(ctx.during);
          (ctx.slice<{ n: number }>('att')).n++;
        },
      },
    };
    const k = bootKernel(createRegistry([plugin]), { seed: 1, startTime: 0 });
    expect(calls).toEqual(['attach']);
    const f = k.fork();
    expect(calls).toEqual(['attach', 'attach']);
    expect((f.world.slices['att'] as { n: number }).n).toBe(2);
    expect((k.world.slices['att'] as { n: number }).n).toBe(1);
  });

  test('output records go to the port and nowhere else', () => {
    const out: unknown[] = [];
    const k = bootKernel(createRegistry([]), { seed: 1, startTime: 0, ports: { output: (r) => out.push(r) } });
    const before = k.hash();
    k.act('t', (ctx) => ctx.output({ kind: 'tty', tty: 'x', data: 'hi' }));
    expect(out).toEqual([{ kind: 'tty', tty: 'x', data: 'hi' }]);
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(k.hash()).toBe(before);
  });
});
