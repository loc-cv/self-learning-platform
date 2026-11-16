// The phase 01 exit criteria for the kernel (docs/ARCHITECTURE.md §2.7): same seed and input log
// give the same hash; fork then run equals run; snapshot, restore and continue equals continue; a
// mutated fork leaves the original unchanged; pending events survive snapshot and restore.

import { describe, expect, test } from 'vitest';
import { createInteractiveDriver } from './driver.ts';
import { bootKernel, createKernel, type Kernel } from './kernel.ts';
import { createRegistry, type Registry } from './registry.ts';
import { createRecorder, replay, type SessionHeader, type SessionLog } from './replay.ts';
import { restore, snapshot } from './snapshot.ts';
import { put } from './table.ts';
import { ENGINE_VERSION } from './version.ts';
import { simPlugin, startSim, type SimSlice } from './testing/sim-plugin.ts';

const registry = createRegistry([simPlugin()]);

function bootSim(seed: number, reg: Registry = registry): Kernel {
  const k = bootKernel(reg, { seed, startTime: 1_000_000 });
  k.act('setup', startSim);
  return k;
}

/** A scripted session: inputs at chosen times with time passing in between. */
function play(k: Kernel, deliver: (input: { kind: string; name: string }) => void = (i) => k.input(i)): void {
  k.advance(300);
  deliver({ kind: 'sim.add', name: 'alpha' });
  k.advance(1);
  deliver({ kind: 'sim.add', name: 'beta' });
  deliver({ kind: 'sim.add', name: 'gamma' });
  k.advance(4_000);
  deliver({ kind: 'sim.add', name: 'delta' });
  k.settle({ timeout: 60_000 });
}

const sim = (k: Kernel) => k.world.slices.sim as SimSlice;

describe('same seed and input log, same world', () => {
  test('two runs give the same hash and the same world', () => {
    const a = bootSim(7);
    const b = bootSim(7);
    play(a);
    play(b);
    expect(sim(a).totals.ticks).toBe(50);
    expect(sim(a).totals.echoes).toBeGreaterThan(4);
    expect(a.hash()).toBe(b.hash());
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
  });

  test('another seed gives another world', () => {
    const a = bootSim(7);
    const b = bootSim(8);
    play(a);
    play(b);
    expect(a.hash()).not.toBe(b.hash());
  });

  test('the hash covers every part of the world', () => {
    const base = bootSim(7);
    const h = base.hash();
    const mutations: ((k: Kernel) => void)[] = [
      (k) => k.advance(1),
      (k) => k.act('m', (ctx) => ctx.random('sim.ticks').int(10)),
      (k) => k.act('m', (ctx) => ctx.nextId('x')),
      (k) => k.act('m', (ctx) => ctx.subscribe('t', 'sim.echo', { name: 'n' })),
      (k) => k.act('m', (ctx) => ctx.schedule(5, 'sim.echo', { name: 'n' })),
      (k) => put(sim(k).log, 'x', { at: 0, what: 'x', value: 0 }),
    ];
    for (const m of mutations) {
      const f = base.fork();
      m(f);
      expect(f.hash()).not.toBe(h);
    }
    expect(base.hash()).toBe(h);
  });
});

describe('fork', () => {
  test('fork then run equals run', () => {
    const a = bootSim(3);
    a.advance(200);
    const b = a.fork();
    play(a);
    play(b);
    expect(b.hash()).toBe(a.hash());
  });

  test('a fork never affects its parent', () => {
    const parent = bootSim(3);
    play(parent);
    const before = parent.hash();
    const json = JSON.stringify(parent.world);

    const child = parent.fork();
    child.input({ kind: 'sim.add', name: 'intruder' });
    child.act('m', (ctx) => {
      ctx.random('sim.ticks').int(10);
      ctx.subscribe('sim.lucky', 'sim.echo', { name: 'x' });
      startSim(ctx);
    });
    put(sim(child).log, 'zzz', { at: 1, what: 'w', value: 1 });
    sim(child).totals.ticks = -1;
    child.advance(100_000);

    expect(parent.hash()).toBe(before);
    expect(JSON.stringify(parent.world)).toBe(json);
    expect(child.hash()).not.toBe(before);
  });

  test('forks share values and copy containers', () => {
    const a = bootSim(3);
    play(a);
    const b = a.fork();
    const key = Object.keys(sim(a).log)[0] as string;
    expect(sim(b).log[key]).toBe(sim(a).log[key]);
    expect(sim(b).log).not.toBe(sim(a).log);
    expect(b.world.queue).not.toBe(a.world.queue);
    expect(b.world.queue[0]).toBe(a.world.queue[0]);
    expect(b.world.prng['sim.ticks']).not.toBe(a.world.prng['sim.ticks']);
  });
});

describe('snapshot and restore', () => {
  test('snapshot, restore, continue equals continue', () => {
    const a = bootSim(11);
    a.advance(150);
    a.input({ kind: 'sim.add', name: 'early' });
    const text = snapshot(a.world, registry);
    const b = createKernel(restore(text, registry), registry);
    expect(b.hash()).toBe(a.hash());
    play(a);
    play(b);
    expect(b.hash()).toBe(a.hash());
  });

  test('pending events and waiters survive, and values come back frozen', () => {
    const a = bootSim(11);
    a.advance(150);
    a.input({ kind: 'sim.add', name: 'early' });
    expect(a.world.queue.length).toBeGreaterThan(1);
    expect(Object.keys(a.world.topics)).toEqual(['sim.lucky']);
    const w = restore(snapshot(a.world, registry), registry);
    expect(w.queue).toEqual(a.world.queue);
    expect(w.topics).toEqual(a.world.topics);
    expect(w.queue.every((ev) => Object.isFrozen(ev))).toBe(true);
    expect(Object.isFrozen(w.topics['sim.lucky'])).toBe(true);
    const anyEntry = Object.values((w.slices.sim as SimSlice).log)[0];
    expect(Object.isFrozen(anyEntry)).toBe(true);
    expect(Object.isFrozen(w.slices.sim)).toBe(false);
    // A restored world forks cheaply again: values shared, containers copied.
    const k = createKernel(w, registry);
    expect(k.fork().world.queue[0]).toBe(w.queue[0]);
  });

  test('restore refuses another engine, kernel schema or slice version', () => {
    const text = snapshot(bootSim(1).world, registry);
    const file = JSON.parse(text) as { header: Record<string, unknown> };
    const tamper = (f: (h: Record<string, unknown>) => void) => {
      const copy = structuredClone(file);
      f(copy.header);
      return JSON.stringify(copy);
    };
    expect(() => restore(tamper((h) => (h.engine = '0.0.0')), registry)).toThrow(
      `snapshot was taken by engine 0.0.0, this is engine ${ENGINE_VERSION}`,
    );
    expect(() => restore(tamper((h) => (h.kernelSchema = 0)), registry)).toThrow('kernel schema 0');
    expect(() => restore(tamper((h) => (h.slices = { sim: 2 })), registry)).toThrow(
      'snapshot slice sim has version 2, this engine has 1',
    );
    expect(() => restore(text, createRegistry([]))).toThrow('snapshot slice sim has version 1, this engine has none');
  });

  test('snapshot refuses state that is not plain data', () => {
    const k = bootSim(1);
    (sim(k).totals as unknown as Record<string, unknown>).when = new Map();
    expect(() => snapshot(k.world, registry)).toThrow('world.slices.sim.totals.when: an instance of Map is not JSON data');
  });
});

describe('input log and replay', () => {
  const header: SessionHeader = { topology: 'sim', seed: 5, startTime: 1_000_000, engine: ENGINE_VERSION };
  const bootFrom = (reg: Registry) => (h: SessionHeader) => bootSim(h.seed, reg);

  function record(): { log: SessionLog; final: string } {
    const k = bootSim(5);
    const rec = createRecorder(k, header);
    rec.checkpoint();
    play(k, (i) => {
      rec.deliver(i);
      if (i.name === 'beta') rec.checkpoint();
    });
    k.advance(1234);
    rec.checkpoint();
    return { log: rec.log(), final: k.hash() };
  }

  test('a log replays into the same world', () => {
    const { log, final } = record();
    expect(log.inputs.map((i) => [i.t, i.name])).toEqual([
      [1_000_300, 'alpha'],
      [1_000_301, 'beta'],
      [1_000_301, 'gamma'],
      [1_004_301, 'delta'],
    ]);
    expect(log.checkpoints.map((c) => c.inputs)).toEqual([0, 2, 4]);
    const result = replay(log, bootFrom(registry));
    expect(result.diverged).toBeUndefined();
    expect(result.kernel.now).toBe(log.end);
    expect(result.kernel.hash()).toBe(final);
  });

  test('an input at the same instant runs after events already due, as replay does', () => {
    const k = bootSim(5);
    k.advance(10);
    k.act('t', (ctx) => ctx.schedule(0, 'sim.echo', { name: 'due' }));
    k.input({ kind: 'sim.add', name: 'after' });
    const whats = Object.values(sim(k).log).map((e) => e.what);
    expect(whats.indexOf('echo due')).toBeLessThan(whats.indexOf('add after'));
  });

  test('a log survives JSON storage', () => {
    const { log, final } = record();
    const result = replay(JSON.parse(JSON.stringify(log)) as SessionLog, bootFrom(registry));
    expect(result.kernel.hash()).toBe(final);
  });

  test('a resumed session continues its log, and the whole log replays', () => {
    // Record half a session, replay it (a page reload), continue recording on the replayed world.
    const k = bootSim(5);
    const first = createRecorder(k, header);
    k.advance(300);
    first.deliver({ kind: 'sim.add', name: 'alpha' });
    k.advance(50);
    first.checkpoint();
    const saved = JSON.parse(JSON.stringify(first.log())) as SessionLog;
    const resumed = replay(saved, bootFrom(registry));
    expect(resumed.diverged).toBeUndefined();
    const next = createRecorder(resumed.kernel, header, saved);
    resumed.kernel.advance(10);
    next.deliver({ kind: 'sim.add', name: 'beta' });
    next.checkpoint();
    const log = next.log();
    expect(log.inputs.map((i) => [i.t, i.name])).toEqual([
      [1_000_300, 'alpha'],
      [1_000_360, 'beta'],
    ]);
    expect(log.checkpoints.map((c) => c.inputs)).toEqual([1, 2]);
    // The same session without the reload.
    first.kernel.advance(10);
    first.deliver({ kind: 'sim.add', name: 'beta' });
    first.checkpoint();
    expect(first.log().checkpoints).toEqual(log.checkpoints);
    expect(resumed.kernel.hash()).toBe(k.hash());
    expect(replay(log, bootFrom(registry)).kernel.hash()).toBe(k.hash());
    expect(() => createRecorder(bootSim(5), header, log)).toThrow(RangeError);
  });

  test('a changed engine is detected at the first checkpoint that differs', () => {
    const { log } = record();
    const changed = createRegistry([simPlugin({ variant: 1 })]);
    const result = replay(log, bootFrom(changed));
    // The first checkpoint runs the tick due at the start, whose value the variant changes.
    expect(result.diverged?.checkpoint).toEqual(log.checkpoints[0]);
    expect(result.diverged?.actual).not.toBe(log.checkpoints[0]?.hash);
    expect(result.kernel.now).toBe(log.checkpoints[0]?.t);
  });
});

describe('interactive driver', () => {
  const header: SessionHeader = { topology: 'sim', seed: 2, startTime: 1_000_000, engine: ENGINE_VERSION };

  test('virtual time follows real time at the chosen speed, carrying fractions', () => {
    const k = bootSim(2);
    const d = createInteractiveDriver(createRecorder(k, header), { speed: 0.5 });
    d.tick(3);
    expect(k.now).toBe(1_000_001);
    d.tick(1);
    expect(k.now).toBe(1_000_002);
    d.setSpeed(10);
    d.tick(16.7);
    expect(k.now).toBe(1_000_169);
    d.pause();
    d.tick(10_000);
    expect(k.now).toBe(1_000_169);
    d.resume();
    expect(() => d.setSpeed(0)).toThrow(RangeError);
    expect(() => d.tick(-1)).toThrow(RangeError);
  });

  test('inputs are stamped with the virtual time they arrive at, and replay reproduces the session', () => {
    const k = bootSim(2);
    const rec = createRecorder(k, header);
    const d = createInteractiveDriver(rec, { speed: 2 });
    d.deliver({ kind: 'sim.add', name: 'one' }, 100);
    d.skipToNextEvent();
    d.tick(33.3);
    d.deliver({ kind: 'sim.add', name: 'two' }, 0.4);
    d.tick(5000);
    const log = rec.log();
    expect(log.inputs[0]?.t).toBe(1_000_200);
    const r = replay(log, (h) => bootSim(h.seed));
    expect(r.kernel.hash()).toBe(k.hash());
  });

  test('skip to next event ignores idle work', () => {
    const k = bootSim(2);
    k.settle({ timeout: 1_000_000 });
    const d = createInteractiveDriver(createRecorder(k, header));
    const now = k.now;
    d.skipToNextEvent();
    expect(k.now).toBe(now);
  });
});
