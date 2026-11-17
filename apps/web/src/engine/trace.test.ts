// Phase 13 on the engine side of the web app: time controls, the trace as events, "why", reading
// a past moment, the replay in the debrief, and assist levels (docs/ARCHITECTURE.md §2.5, §2.13;
// docs/LEARNING_MODEL.md §13, §14). The engine runs here as it does in the worker, with a clock
// the test moves.

import { describe, expect, test } from 'vitest';
import { isLabLike, loadPacks } from '@simlab/content';
import type { ViewEvent, ViewModel } from '@simlab/kernel';
import type { Assist, Item } from '@simlab/learn';
import type { FromWorker, ToWorker } from '../protocol.ts';
import { createEngine, MAX_OWED, TICK_BUDGET, type Engine } from './session.ts';

const ITEMS = loadPacks().flatMap((p) => p.items.filter(isLabLike).map((i) => i.raw as unknown as Item));
const BUILD = 'k8s.workloads.deployment-service-01';
const PENDING = 'k8s.scheduling.pending-pods-01';
const START = 1_800_000_000_000;
const PROMPT = /[$#] $/;

interface Rig {
  engine: Engine;
  seen: FromWorker[];
  t: { now: number };
  send(m: ToWorker): void;
  screen(tty: string): string;
  last<T extends FromWorker['type']>(type: T): Extract<FromWorker, { type: T }>;
  all<T extends FromWorker['type']>(type: T): Extract<FromWorker, { type: T }>[];
  /** Types a line and ticks until the prompt is back. Returns what the terminal printed. */
  type(tty: string, line: string): string;
  /** Lets `ms` of real time pass in worker-sized ticks. */
  wait(ms: number): void;
  now(): number;
}

function rig(item: string, opts: { seed?: number; assist?: Assist; items?: readonly Item[]; clock?: (t: { now: number }) => number } = {}): Rig {
  const seen: FromWorker[] = [];
  const t = { now: 0 };
  const engine = createEngine(opts.items ?? ITEMS, (m) => seen.push(m), () => (opts.clock ? opts.clock(t) : t.now));
  const r: Rig = {
    engine,
    seen,
    t,
    send: (m) => engine.receive(m),
    screen: (tty) => seen.flatMap((m) => (m.type === 'tty.out' && m.tty === tty ? [m.data] : [])).join(''),
    all: (type) => seen.filter((x) => x.type === type) as Extract<FromWorker, { type: typeof type }>[],
    last(type) {
      const m = r.all(type).at(-1);
      if (!m) throw new Error(`no ${type} message`);
      return m;
    },
    type(tty, line) {
      const before = r.screen(tty).length;
      t.now += 100;
      engine.receive({ type: 'tty.bytes', tty, data: `${line}\r` });
      for (let i = 0; i < 400 && !PROMPT.test(r.screen(tty).slice(before + line.length)); i++) {
        t.now += 50;
        engine.tick();
      }
      return r.screen(tty).slice(before);
    },
    wait(ms) {
      for (let left = ms; left > 0; left -= 50) {
        t.now += Math.min(50, left);
        engine.tick();
      }
    },
    now: () => engine.kernel?.now ?? 0,
  };
  const start: ToWorker = { type: 'start', item, seed: opts.seed ?? 2, startTime: START };
  if (opts.assist) start.assist = opts.assist;
  r.send(start);
  return r;
}

function open(r: Rig, req = 1): string {
  r.send({ type: 'tty.open', req, cols: 120, rows: 30 });
  const tty = r.last('tty.opened').tty;
  for (let i = 0; i < 100 && !PROMPT.test(r.screen(tty)); i++) {
    r.t.now += 50;
    r.engine.tick();
  }
  return tty;
}

/** The events the page holds after applying every `events` message in order. */
function pageEvents(r: Rig): ViewEvent[] {
  const byId = new Map<number, ViewEvent>();
  for (const m of r.all('events')) {
    if (m.reset) byId.clear();
    for (const e of m.events) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const entity = (m: ViewModel, kind: string, label: RegExp) => {
  const k = m.kinds.find((x) => x.label === kind)?.kind;
  return m.entities.find((e) => e.kind === k && label.test(e.label));
};

describe('time controls', () => {
  test('the clock reports virtual time; speed scales it; a pause stops it', () => {
    const r = rig(BUILD);
    expect(r.last('ready').clock).toMatchObject({ now: START, paused: false, speed: 1 });
    r.wait(1_000);
    expect(r.now()).toBe(START + 1_000);
    r.send({ type: 'speed', speed: 10 });
    expect(r.last('clock').clock.speed).toBe(10);
    r.wait(1_000);
    expect(r.now()).toBe(START + 11_000);
    r.send({ type: 'pause', paused: true });
    r.wait(5_000);
    expect(r.now()).toBe(START + 11_000);
    r.send({ type: 'pause', paused: false });
    r.send({ type: 'speed', speed: 2 });
    expect(r.last('clock').clock).toMatchObject({ now: START + 11_000, speed: 2, paused: false });
    r.wait(500);
    expect(r.now()).toBe(START + 12_000);
  });

  test('the terminal prints the same at every speed', () => {
    // The same keys, typed with the same pauses of real time, at 1× and at 10×: what the tools
    // print does not depend on how fast the world runs (ages do: the commands below print none).
    const session = (speed: number): string => {
      const r = rig(BUILD);
      const tty = open(r);
      r.send({ type: 'speed', speed });
      const out = [r.type(tty, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=3'), r.type(tty, 'kubectl rollout status deployment/web'), r.type(tty, 'kubectl get deployment web -o name'), r.type(tty, 'echo one; sleep 2; echo two')];
      return out.join('');
    };
    const slow = session(1);
    expect(slow).toContain('deployment "web" successfully rolled out');
    expect(slow).toContain('deployment.apps/web\r\n');
    expect(slow).toMatch(/one\r\ntwo\r\n/);
    expect(session(10)).toBe(slow);
    expect(session(5)).toBe(slow);
  });

  test('a tick yields when its budget of real time is spent, and drops what it cannot make up', () => {
    // A clock that moves 1 ms every time it is read: the engine "computes slowly".
    const r = rig(BUILD, { clock: (t) => (t.now += 1) });
    r.send({ type: 'speed', speed: 10 });
    const before = r.now();
    r.t.now += 60_000; // the machine slept for a minute
    r.engine.tick();
    // One tick made up only what fits in its budget (a few slices of 50 virtual ms each)…
    const first = r.now() - before;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(TICK_BUDGET * 50);
    expect(r.engine.nextEventIn()).toBe(0);
    // …and of the rest at most MAX_OWED of real time is ever made up: the minute is not replayed.
    for (let i = 0; i < 400; i++) r.engine.tick();
    expect(r.now() - before).toBeLessThan((MAX_OWED + 2_000) * 10);
  });
});

describe('reading a past moment', () => {
  test('the view at an earlier time is the world as it was, and the session does not move', () => {
    const r = rig(BUILD);
    const tty = open(r);
    r.send({ type: 'view', open: true });
    const t0 = r.now();
    r.type(tty, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    r.type(tty, 'kubectl rollout status deployment/web');
    r.wait(300);
    const t1 = r.now();
    const live = r.last('view').model;
    expect(entity(live, 'Deployment', /^web$/)?.status).toBe('2/2');
    const hash = r.engine.kernel?.hash();
    const logged = (): number => r.all('attempt.delta').reduce((n, m) => n + m.inputs.length, 0);
    const inputs = logged();

    r.send({ type: 'past', req: 1, t: t0 });
    const then = r.last('past');
    expect(then.t).toBe(t0);
    expect(entity(then.model, 'Deployment', /^web$/)).toBeUndefined();
    // Forward on the same replayed world, then back again from the start: both are the session's past.
    r.send({ type: 'past', req: 2, t: t1 });
    expect(entity(r.last('past').model, 'Deployment', /^web$/)?.status).toBe('2/2');
    r.send({ type: 'past', req: 3, t: t0 + 1 });
    expect(entity(r.last('past').model, 'Deployment', /^web$/)).toBeUndefined();
    // A time outside the attempt is brought inside it.
    r.send({ type: 'past', req: 4, t: 0 });
    expect(r.last('past').t).toBe(START);
    r.send({ type: 'past', req: 5, t: t1 + 3_600_000 });
    expect(r.last('past').t).toBe(r.now());
    // Reading the past is not an input and changes nothing.
    expect(r.engine.kernel?.hash()).toBe(hash);
    expect(logged()).toBe(inputs);
  });
});

describe('assist levels', () => {
  test('off: the worker sends no view, no events, no why, no past, whatever the page asks', () => {
    const r = rig(PENDING, { assist: 'off' });
    expect(r.last('ready').lab.assist).toBe('off');
    const tty = open(r);
    r.send({ type: 'view', open: true });
    r.type(tty, 'kubectl get pods');
    r.send({ type: 'why', req: 1, entity: 'anything' });
    r.send({ type: 'past', req: 2, t: START });
    r.wait(1_000);
    for (const type of ['view', 'events', 'why', 'past'] as const) expect(r.all(type)).toEqual([]);
    // Nothing of it is in the attempt's log either: no help was used.
    expect(r.last('attempt.delta').inputs.filter((i) => i.kind === 'learn.action')).toEqual([]);
  });

  test('view: the world is shown, nothing explains it', () => {
    const r = rig(PENDING, { assist: 'view' });
    expect(r.last('ready').lab.assist).toBe('view');
    open(r);
    r.send({ type: 'view', open: true });
    r.send({ type: 'why', req: 1, entity: 'anything' });
    r.send({ type: 'past', req: 2, t: START });
    r.wait(1_000);
    expect(r.all('view').length).toBeGreaterThan(0);
    for (const type of ['events', 'why', 'past'] as const) expect(r.all(type)).toEqual([]);
  });

  test('an item can ask for less than the learner allows, never for more', () => {
    const drill = { ...(ITEMS.find((i) => i.id === PENDING) as Item), assist: 'view' as const };
    expect(rig(PENDING, { items: [drill] }).last('ready').lab.assist).toBe('view');
    expect(rig(PENDING, { items: [drill], assist: 'off' }).last('ready').lab.assist).toBe('off');
    expect(rig(PENDING, { assist: 'view' }).last('ready').lab.assist).toBe('view');
    expect(rig(PENDING).last('ready').lab.assist).toBe('full');
  });
});

describe('the trace as events', () => {
  test('the X-ray gets the session\'s events while it is open: commands, what components did, marks', () => {
    const r = rig(BUILD);
    const tty = open(r);
    r.send({ type: 'view', open: true });
    const first = r.last('events');
    expect(first.reset).toBe(true);
    expect(first.start).toBe(START);
    r.type(tty, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    r.type(tty, 'kubectl rollout status deployment/web');
    r.send({ type: 'lab', req: 1, action: 'check' });
    r.wait(400);
    const events = pageEvents(r);
    // Only what happened in the session: nothing from before the attempt started.
    expect(events.every((e) => e.t >= START)).toBe(true);
    const commands = events.filter((e) => e.input);
    expect(commands.map((c) => c.text)).toEqual(['kubectl create deployment web --image=nginx:1.31.8 --replicas=2', 'kubectl rollout status deployment/web']);
    // A command that has ended says when and how; the page got the later form of the same event.
    expect(commands.every((c) => c.until !== undefined && c.until >= c.t)).toBe(true);
    expect(commands[0]?.items?.[0]).toMatchObject({ label: 'Exit status', value: '0' });
    const actors = new Set(events.filter((e) => !e.input && e.level === 'key').map((e) => e.actor));
    for (const a of ['deployment-controller', 'replicaset-controller', 'kube-scheduler']) expect([...actors]).toContain(a);
    expect([...actors].some((a) => a.startsWith('kubelet'))).toBe(true);
    // Every event names entities by the ids the view uses, and its causes came before it.
    const ids = new Set(r.all('view').flatMap((m) => m.model.entities.map((e) => e.id)));
    for (const e of events.filter((x) => x.level === 'key')) {
      expect(e.about.length).toBeGreaterThan(0);
      expect(e.about.some((id) => ids.has(id))).toBe(true);
      for (const c of e.causes) expect(c).toBeLessThan(e.id);
    }
    expect(r.last('events').marks).toEqual([{ t: expect.any(Number) as number, action: 'check', passed: false }]);
    // Closed: nothing more is sent. Opened again: everything, as a reset.
    r.send({ type: 'view', open: false });
    const sent = r.all('events').length;
    r.type(tty, 'kubectl scale deployment web --replicas=3');
    r.wait(400);
    expect(r.all('events').length).toBe(sent);
    r.send({ type: 'view', open: true });
    expect(r.last('events').reset).toBe(true);
    expect(pageEvents(r).filter((e) => e.input).length).toBe(3);
  });

  test('a reset starts the events again from the new world', () => {
    const r = rig(BUILD);
    const tty = open(r);
    r.send({ type: 'view', open: true });
    r.type(tty, 'kubectl create namespace x');
    r.wait(400);
    expect(pageEvents(r).some((e) => e.input)).toBe(true);
    r.send({ type: 'lab', req: 1, action: 'reset' });
    const before = r.all('events').length;
    r.wait(400);
    expect(r.all('events').slice(before - 1).some((m) => m.reset)).toBe(true);
    expect(pageEvents(r).filter((e) => e.input)).toEqual([]);
  });
});

describe('why', () => {
  test('a Pod that is Pending when the lab opens: every node with its reason, from the trace of the setup', () => {
    const r = rig(PENDING, { seed: 3 });
    open(r);
    r.send({ type: 'view', open: true });
    const model = r.last('view').model;
    const pod = model.entities.find((e) => e.status === 'Pending');
    if (!pod) throw new Error('no Pending entity');
    r.send({ type: 'why', req: 5, entity: pod.id });
    const why = r.last('why');
    expect(why.req).toBe(5);
    expect(why.why?.entity).toBe(pod.id);
    expect(why.why?.summary).not.toBe('');
    const decision = why.why?.steps.findLast((s) => s.actor === 'kube-scheduler');
    const nodes = model.entities.filter((e) => e.kind === model.kinds.find((k) => k.label === 'Node')?.kind);
    expect(nodes.length).toBe(3);
    expect(decision?.items?.map((i) => i.entity).sort()).toEqual(nodes.map((n) => n.id).sort());
    for (const i of decision?.items ?? []) {
      expect(i.tone).toBe('bad');
      expect(i.value).not.toBe('');
    }
    // Asking is help: it is in the attempt's log, with the entity.
    const logged = r.all('attempt.delta').flatMap((m) => m.inputs).filter((i) => i.kind === 'learn.action' && i['action'] === 'why');
    expect(logged.map((i) => i['data'])).toEqual([{ entity: pod.id }]);
    // An entity nobody knows gets an answer without a chain.
    r.send({ type: 'why', req: 6, entity: 'no/such/thing' });
    expect(r.last('why')).toEqual({ type: 'why', req: 6 });
  });
});

describe('skip to next event', () => {
  test('during a back-off, a skip lands exactly on the restart the kubelet announced', () => {
    const r = rig(BUILD);
    const tty = open(r);
    r.send({ type: 'view', open: true });
    r.type(tty, 'kubectl run crash --image=busybox:1.37 --restart=Always -- sh -c "exit 3"');
    // Run until the kubelet has backed off twice: the second back-off is 20 s long.
    const backoffs = (): ViewEvent[] => pageEvents(r).filter((e) => /back-off/i.test(e.text) && e.level === 'key');
    for (let i = 0; i < 600 && backoffs().length < 2; i++) r.wait(100);
    const last = backoffs().at(-1);
    if (!last) throw new Error('the Pod never backed off');
    const retryAt = Number((last.detail as { k8s: { retryAt: number } }).k8s.retryAt);
    expect(retryAt).toBeGreaterThan(r.now() + 5_000);
    const before = r.now();
    r.send({ type: 'advance' });
    const skipped = r.last('skipped');
    expect(skipped.found).toBe(true);
    expect(r.now()).toBe(retryAt);
    expect(skipped.by).toBe(retryAt - before);
    expect(r.last('clock').clock.now).toBe(retryAt);
    // What it stopped at is the restart, and nothing else of note happened on the way.
    r.wait(300);
    const since = pageEvents(r).filter((e) => e.level === 'key' && e.t > before && e.t <= retryAt);
    expect(since.length).toBe(1);
    expect(since[0]?.text).toMatch(/restart/i);
    // A skip is not an input: the log has none for it.
    expect(r.all('attempt.delta').flatMap((m) => m.inputs).some((i) => i.t === retryAt)).toBe(false);
  });

  test('with nothing due to show within the hour, a skip says so', () => {
    const r = rig(BUILD);
    open(r);
    // The cluster is still starting its DNS Pods when the lab opens: let it finish.
    r.send({ type: 'speed', speed: 10 });
    r.wait(12_000);
    r.send({ type: 'view', open: true });
    const t = r.now();
    r.send({ type: 'advance' });
    r.wait(300);
    expect(pageEvents(r).filter((e) => e.t > t).map((e) => [e.level, e.actor, e.text])).toEqual([]);
    expect(r.last('skipped').found).toBe(false);
  });
});

describe('the replay in the debrief', () => {
  test('a solved attempt: the fault\'s cause, the fix, the convergence, each at its virtual time in the input log', () => {
    // Seed 4 is the memory variant: each Pod asks for more memory than a node has.
    const r = rig(PENDING, { seed: 4 });
    const tty = open(r);
    r.type(tty, 'kubectl get pods -A');
    const row = /\n(\S+)\s+(\S+)\s+0\/\d+/.exec(r.type(tty, 'kubectl get deployments -A --no-headers').replace(/\r/g, ''));
    if (!row) throw new Error('no Deployment that is not ready');
    r.wait(3_000);
    // The fix goes through the editor, as the hint suggests: the command returns when it closes.
    const fix = `kubectl -n ${row[1] as string} edit deployment ${row[2] as string}`;
    const shown = r.screen(tty).length;
    r.t.now += 100;
    r.send({ type: 'tty.bytes', tty, data: `${fix}\r` });
    for (let i = 0; i < 100 && r.all('editor.open').length === 0; i++) r.wait(50);
    const editor = r.last('editor.open').editor;
    r.wait(4_000);
    r.send({ type: 'editor.save', session: editor.session, content: editor.content.replace('memory: 8Gi', 'memory: 256Mi') });
    r.send({ type: 'editor.close', session: editor.session });
    for (let i = 0; i < 100 && !PROMPT.test(r.screen(tty).slice(shown + fix.length)); i++) r.wait(50);
    const out = r.screen(tty).slice(shown);
    expect(out).toContain('edited');
    r.type(tty, 'kubectl get pods');
    r.wait(20_000);
    r.send({ type: 'lab', req: 1, action: 'check' });
    const report = r.last('lab.result');
    if (report.result.action !== 'check') throw new Error('not a check');
    expect(report.result.report.passed).toBe(true);
    const clock = r.now();
    r.send({ type: 'lab', req: 2, action: 'debrief' });
    const hash = r.engine.kernel?.hash();
    const res = r.last('lab.result');
    if (res.result.action !== 'debrief' || !res.result.replay) throw new Error('no replay');
    const replay = res.result.replay;
    const log = r.last('attempt').attempt.current;

    // The start: the fault's cause, from the trace of the setup.
    // The attempt starts where the setup left the clock.
    expect(replay.frames[0]).toMatchObject({ kind: 'start', t: replay.start });
    expect(replay.start).toBeLessThanOrEqual(log.inputs[0]?.t as number);
    expect(replay.causes.length).toBeGreaterThan(0);
    // One of the broken things is a Pending Pod, explained by the scheduler's verdict per node.
    expect(replay.causes.some((cause) => cause.steps.some((s) => s.actor === 'kube-scheduler' && (s.items ?? []).length === 3))).toBe(true);
    // My fix: a frame at the moment the command returned, which lies between the stamp of its
    // Enter key in the input log and the next key typed.
    const change = replay.frames.find((f) => f.kind === 'change');
    expect(change?.labels).toEqual([fix]);
    const command = replay.inputs.find((c) => c.text === fix);
    const enter = log.inputs.filter((i) => i.kind === 'tty.bytes' && String(i['data']).endsWith('\r')).map((i) => i.t);
    expect(enter).toContain(command?.t);
    expect(change?.t).toBe(command?.until);
    // The edit took its time in the editor: the change landed with the save, seconds after Enter.
    const save = log.inputs.find((i) => i.kind === 'editor.save');
    expect(change?.t).toBeGreaterThanOrEqual(save?.t as number);
    expect((save?.t as number) - (command?.t as number)).toBeGreaterThanOrEqual(4_000);
    // The convergence: a later frame, at the time of the last thing the trace recorded, in which
    // nothing is Pending any more; the scheduler's binding is among what it says happened.
    const settled = replay.frames.filter((f) => f.kind === 'settled' && f.t > (change?.t as number)).at(-1);
    if (!settled) throw new Error('no settled frame');
    expect(settled.t).toBeLessThanOrEqual(log.end);
    expect(settled.panel.model.entities.some((e) => e.status === 'Pending')).toBe(false);
    expect(replay.frames[0]?.panel.model.entities.some((e) => e.status === 'Pending')).toBe(true);
    const happened = replay.frames.filter((f) => f.t >= (change?.t as number)).flatMap((f) => f.events);
    expect(happened.some((e) => e.actor === 'kube-scheduler' && e.tone !== 'bad')).toBe(true);
    expect(happened.every((e) => e.t > replay.start && e.t <= log.end)).toBe(true);
    // Frame times rise, and every command of the log is listed, also those that changed nothing.
    expect(replay.frames.map((f) => f.t)).toEqual([...replay.frames.map((f) => f.t)].sort((a, b) => a - b));
    expect(replay.inputs.map((c) => c.text)).toEqual(['kubectl get pods -A', 'kubectl get deployments -A --no-headers', fix, 'kubectl get pods']);
    // The replay ran on worlds of its own, and the time it took is not the learner's.
    expect(r.now()).toBe(clock);

    // On request, the reference solution's run, drawn the same way.
    r.send({ type: 'lab', req: 3, action: 'reference' });
    const ref = r.last('lab.result');
    if (ref.result.action !== 'reference' || !ref.result.replay) throw new Error('no reference run');
    expect(ref.result.replay.frames[0]?.kind).toBe('start');
    expect(ref.result.replay.frames.some((f) => f.kind === 'change' && f.labels.length === 1)).toBe(true);
    expect(ref.result.replay.frames.at(-1)?.panel.model.entities.some((e) => e.status === 'Pending')).toBe(false);
    expect(r.engine.kernel?.hash()).toBe(hash);
  });

  test('the reference run is part of the debrief: asked before it, it is refused', () => {
    const r = rig(PENDING);
    open(r);
    r.send({ type: 'lab', req: 1, action: 'reference' });
    expect(r.last('error').message).toContain('open the debrief first');
  });
});

describe('reading the start of an attempt whose setup took time', () => {
  test('the world at the start holds nothing the learner did later', () => {
    const r = rig(PENDING, { seed: 1 });
    const tty = open(r);
    r.send({ type: 'view', open: true });
    const start = r.last('events').start;
    const before = r.last('view').model.entities.map((e) => e.id).sort();
    const row = /\n(\S+)\s+(\S+)\s+0\/\d+/.exec(r.type(tty, 'kubectl get deployments -A --no-headers').replace(/\r/g, ''));
    if (!row) throw new Error('no Deployment');
    r.t.now += 100;
    r.send({ type: 'tty.bytes', tty, data: `kubectl -n ${row[1] as string} edit deployment ${row[2] as string}\r` });
    for (let i = 0; i < 100 && r.all('editor.open').length === 0; i++) r.wait(50);
    const editor = r.last('editor.open').editor;
    r.send({ type: 'editor.save', session: editor.session, content: editor.content.replace('disktype: SSD', 'disktype: ssd') });
    r.send({ type: 'editor.close', session: editor.session });
    r.wait(2_000);
    r.send({ type: 'advance', ms: 90_000 });
    r.wait(300);
    expect(r.last('view').model.entities.map((e) => e.id).sort()).not.toEqual(before);
    r.send({ type: 'past', req: 1, t: start });
    expect(r.last('past').t).toBe(start);
    expect(r.last('past').model.entities.map((e) => e.id).sort()).toEqual(before);
  });
});
