import { describe, expect, test } from 'vitest';
import { isLabLike, loadPacks } from '@simlab/content';
import type { Item } from '@simlab/learn';
import type { FromWorker, StoredAttempt, ToWorker } from '../protocol.ts';
import { createEngine, type Engine } from './session.ts';

const ITEMS = loadPacks().flatMap((p) => p.items.filter(isLabLike).map((i) => i.raw as unknown as Item));
const BUILD = 'k8s.workloads.deployment-service-01';
const START = 1_800_000_000_000;

interface Rig {
  engine: Engine;
  seen: FromWorker[];
  /** Real time in ms, moved by the test. */
  t: { now: number };
  send(m: ToWorker): void;
  /** Everything the terminal received so far. */
  screen(tty: string): string;
  last<T extends FromWorker['type']>(type: T): Extract<FromWorker, { type: T }>;
  type(tty: string, line: string): string;
}

function rig(): Rig {
  const seen: FromWorker[] = [];
  const t = { now: 0 };
  const engine = createEngine(ITEMS, (m) => seen.push(m), () => t.now);
  const r: Rig = {
    engine,
    seen,
    t,
    send: (m) => engine.receive(m),
    screen: (tty) => seen.flatMap((m) => (m.type === 'tty.out' && m.tty === tty ? [m.data] : [])).join(''),
    last(type) {
      const m = [...seen].reverse().find((x) => x.type === type);
      if (!m) throw new Error(`no ${type} message`);
      return m as Extract<FromWorker, { type: typeof type }>;
    },
    type(tty, line) {
      const before = r.screen(tty).length;
      t.now += 100;
      engine.receive({ type: 'tty.bytes', tty, data: `${line}\r` });
      // Commands take virtual time: tick as the worker does until the prompt is back.
      for (let i = 0; i < 100 && !/[$#] $/.test(r.screen(tty).slice(before + line.length)); i++) {
        t.now += 50;
        engine.tick();
      }
      return r.screen(tty).slice(before);
    },
  };
  return r;
}

/** Opens a terminal and waits, as the page would, for the login shell's prompt. */
function open(r: Rig, req = 1): string {
  r.send({ type: 'tty.open', req, cols: 100, rows: 30 });
  const tty = r.last('tty.opened').tty;
  for (let i = 0; i < 100 && !/[$#] $/.test(r.screen(tty)); i++) {
    r.t.now += 50;
    r.engine.tick();
  }
  return tty;
}

describe('the web engine session', () => {
  test('the debrief comes with figures built on forks, outside the attempt', () => {
    const r = rig();
    r.send({ type: 'start', item: 'k8s.troubleshooting.broken-rollout-01', seed: 2, startTime: START });
    const ready = r.last('ready');
    expect(ready.lab.ticket.map((b) => ('figure' in b ? b.figure.kind : 'text' in b ? 'text' : 'failed'))).toEqual(['text']);
    const tty = open(r);
    r.type(tty, 'kubectl get ns');
    const clock = r.engine.kernel?.now;
    r.send({ type: 'lab', req: 7, action: 'debrief' });
    const res = r.last('lab.result');
    if (res.result.action !== 'debrief') throw new Error('not a debrief');
    const kinds = res.result.blocks.map((b) => ('figure' in b ? b.figure.kind : 'text' in b ? 'text' : 'failed'));
    expect(kinds.slice(0, 2)).toEqual(['compare', 'scene']);
    expect(kinds).not.toContain('failed');
    // The log gained only the debrief action, the time spent building figures is not the
    // learner's, and the attempt replays to the same world: the figures' forks touched nothing.
    const attempt = r.last('attempt').attempt;
    expect(attempt.current.inputs.filter((x) => x.kind === 'learn.action').map((x) => x['action'])).toEqual(['debrief']);
    expect(r.engine.kernel?.now).toBe(clock);
    const again = rig();
    again.send({ type: 'start', item: 'k8s.troubleshooting.broken-rollout-01', seed: 2, startTime: START, resume: attempt });
    expect(again.last('ready').resumed).toBe(true);
    expect(again.engine.kernel?.hash()).toBe(r.engine.kernel?.hash());
  });

  test('starts a lab, runs commands in a terminal and grades it', () => {
    const r = rig();
    r.send({ type: 'start', item: BUILD, seed: 2, startTime: START });
    const ready = r.last('ready');
    expect(ready.lab).toMatchObject({ id: BUILD, seed: 2, hintCount: expect.any(Number) as number });
    expect(ready.resumed).toBe(false);
    const tty = open(r);
    expect(tty).toMatch(/^tty\d+$/);
    expect(r.screen(tty)).toMatch(/[$#] $/);
    expect(r.type(tty, 'kubectl get ns')).toMatch(/NAME\s+STATUS\s+AGE\r\n.*default\s+Active/s);
    r.send({ type: 'lab', req: 7, action: 'check' });
    const checked = r.last('lab.result');
    expect(checked.req).toBe(7);
    expect(checked.result.action === 'check' && checked.result.report.passed).toBe(false);
    r.send({ type: 'lab', req: 8, action: 'hint' });
    expect(r.last('lab.result').state.hints).toHaveLength(1);
    const stored = r.last('attempt').attempt;
    expect(stored.current.inputs.map((i) => i.kind)).toEqual(['tty.open', 'tty.bytes', 'learn.action', 'learn.action']);
    expect(stored.report?.passed).toBe(false);
  });

  test('the X-ray gets the world’s view model when it opens and while it changes; opening it is logged', () => {
    const r = rig();
    r.send({ type: 'start', item: 'k8s.scheduling.pending-pods-01', seed: 1, startTime: START });
    expect(r.seen.some((m) => m.type === 'view')).toBe(false);
    r.send({ type: 'view', open: true });
    const first = r.last('view').model;
    expect(first.entities.some((e) => e.kind === 'host.Machine')).toBe(true);
    const views = (): number => r.seen.filter((m) => m.type === 'view').length;
    // Unchanged world, nothing new; time passes and the world changes, a new model at most every VIEW_EVERY.
    r.t.now += 50;
    r.engine.tick();
    expect(views()).toBe(1);
    r.send({ type: 'view', open: false });
    r.t.now += 60_000;
    r.engine.tick();
    expect(views()).toBe(1);
    r.send({ type: 'flush' });
    const logged = r.last('attempt').attempt.current.inputs.filter((i) => i.kind === 'learn.action');
    expect(logged.map((i) => [i['action'], i['data']])).toEqual([
      ['view', { open: true }],
      ['view', { open: false }],
    ]);
  });

  test('virtual time follows the clock and stops while paused', () => {
    const r = rig();
    r.send({ type: 'start', item: BUILD, seed: 1, startTime: START });
    const k = () => r.engine.kernel?.now ?? 0;
    const t0 = k();
    r.t.now += 1500;
    r.engine.tick();
    expect(k() - t0).toBe(1500);
    r.send({ type: 'pause', paused: true });
    r.t.now += 10_000;
    r.engine.tick();
    expect(k() - t0).toBe(1500);
    expect(r.last('clock').clock).toMatchObject({ paused: true, elapsed: 1500 });
    r.send({ type: 'pause', paused: false });
    r.send({ type: 'advance', ms: 60_000 });
    expect(k() - t0).toBe(61_500);
  });

  test('a stored attempt resumes by replay: the same terminal content, world, hints and open editor', () => {
    const a = rig();
    a.send({ type: 'start', item: BUILD, seed: 3, startTime: START });
    const tty = open(a);
    a.type(tty, 'kubectl create deployment web --image=nginx:1.31.8');
    a.t.now += 30_000;
    a.engine.tick();
    a.type(tty, 'kubectl get deploy');
    a.send({ type: 'lab', req: 1, action: 'hint' });
    a.type(tty, 'vim notes.yaml');
    const opened = a.last('editor.open').editor;
    expect(opened.request).toMatchObject({ flavor: 'vim', name: 'notes.yaml', isNew: true, language: 'yaml' });
    a.send({ type: 'editor.save', session: opened.session, content: 'replicas: 2\n' });
    expect(a.last('editor.status')).toMatchObject({ ok: true });
    a.t.now += 400;
    a.engine.tick();
    a.send({ type: 'flush' });
    const stored = JSON.parse(JSON.stringify(a.last('attempt').attempt)) as StoredAttempt;

    const b = rig();
    b.send({ type: 'start', item: BUILD, seed: 99, startTime: 0, resume: stored });
    const ready = b.last('ready');
    expect(ready.resumed).toBe(true);
    expect(ready.lab.seed).toBe(3);
    expect(ready.ttys.map((x) => x.tty)).toEqual([tty]);
    expect(ready.state.hints).toHaveLength(1);
    expect(ready.editors).toHaveLength(1);
    expect(ready.editors[0]).toMatchObject({ session: opened.session, content: 'replicas: 2\n', saved: true });
    expect(b.screen(tty)).toBe(a.screen(tty));
    expect(b.engine.kernel?.hash()).toBe(a.engine.kernel?.hash());

    // The resumed attempt goes on where it stopped: close the editor, the shell prompt returns.
    b.send({ type: 'editor.close', session: opened.session });
    expect(b.type(tty, 'cat notes.yaml')).toContain('replicas: 2');
    b.send({ type: 'flush' });
    const next = b.last('attempt').attempt;
    expect(next.current.inputs.length).toBeGreaterThan(stored.current.inputs.length);
  });

  test('reset starts a new world and keeps the hints; the attempt remembers the earlier one', () => {
    const r = rig();
    r.send({ type: 'start', item: BUILD, seed: 1, startTime: START });
    const tty = open(r);
    r.type(tty, 'kubectl create namespace scratch');
    r.send({ type: 'lab', req: 1, action: 'hint' });
    r.send({ type: 'lab', req: 2, action: 'reset' });
    const res = r.last('lab.result');
    expect(res.result.action).toBe('reset');
    expect(res.state.hints).toHaveLength(1);
    const fresh = open(r, 3);
    expect(r.type(fresh, 'kubectl get ns scratch')).toContain('Error from server (NotFound): namespaces "scratch" not found');
    r.send({ type: 'flush' });
    const stored = r.last('attempt').attempt;
    expect(stored.previous).toHaveLength(1);
    const b = rig();
    b.send({ type: 'start', item: BUILD, seed: 1, startTime: START, resume: stored });
    expect(b.last('ready').state.hints).toHaveLength(1);
    expect(b.last('ready').clock.elapsed).toBeGreaterThan(0);
  });

  test('a shell that exits ends its terminal', () => {
    const r = rig();
    r.send({ type: 'start', item: BUILD, seed: 1, startTime: START });
    const tty = open(r);
    r.type(tty, 'exit');
    expect(r.last('tty.ended').tty).toBe(tty);
  });

  test('an attempt that cannot be vouched for is refused', () => {
    const r = rig();
    r.send({ type: 'start', item: BUILD, seed: 1, startTime: START });
    const tty = open(r);
    r.type(tty, 'kubectl get pods');
    r.send({ type: 'lab', req: 1, action: 'check' });
    const stored = r.last('attempt').attempt;
    const tampered: StoredAttempt = { ...stored, current: { ...stored.current, checkpoints: stored.current.checkpoints.map((c) => ({ ...c, hash: '0000000000000000' })) } };
    const b = rig();
    b.send({ type: 'start', item: BUILD, seed: 1, startTime: START, resume: tampered });
    expect(b.last('failed').problem).toBe('diverged');
    const changed: StoredAttempt = { ...stored, current: { ...stored.current, header: { ...stored.current.header, contentHash: 'other' } } };
    b.send({ type: 'start', item: BUILD, seed: 1, startTime: START, resume: changed });
    expect(b.last('failed').problem).toBe('changed');
    b.send({ type: 'start', item: 'nope', seed: 1, startTime: START });
    expect(b.last('failed').problem).toBe('unknown-item');
  });
});
