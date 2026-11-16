// The engine side of the web app, without the worker: one lab attempt at a time, its session
// world, the interactive time driver and the recorder (docs/ARCHITECTURE.md §2.5, §2.8). The
// worker (worker.ts) gives it messages and a monotonic clock; tests give it a fake one.
//
// Output is batched: everything a message or a tick produces is sent after it, consecutive bytes
// for one terminal in one message. A resumed attempt is replayed first; its terminal output goes
// to the page so the terminals show what they showed before the reload.

import { buildView, createInteractiveDriver, createRecorder, createRegistry, ENGINE_VERSION, hashNode, replay, type GapEvent, type InteractiveDriver, type Input, type Json, type LoggedInput, type Millis, type OutputRecord, type Ports, type SessionHeader, type SessionLog, type SessionRecorder } from '@simlab/kernel';
import { hostPlugin, type EditorRequest, type HostSlice } from '@simlab/host';
import { k8sPlugin, KUBERNETES_TAG } from '@simlab/k8s';
import { buildBaseline, openLab, showSolution, variantOf, type Baseline, type GradeReport, type Item, type Lab } from '@simlab/learn';
import type { Clock, FromWorker, LabAction, LabResult, LabState, OpenEditor, StoredAttempt, ToWorker, TtyInfo } from '../protocol.ts';

export const registry = createRegistry([hostPlugin, k8sPlugin]);

/** How often the log's `end` is sent while only time passes (real ms). New inputs go at once. */
export const SAVE_IDLE = 5_000;
/** A checkpoint (a world hash, ~40 ms) at most this often in virtual time, besides lab actions. */
export const CHECKPOINT_EVERY = 120_000;
/** How often the clock is reported (real ms). */
export const CLOCK_EVERY = 1_000;
/** The X-ray's view model is sent at most this often (real ms), and only when it changed. */
export const VIEW_EVERY = 200;

export interface Engine {
  receive(msg: ToWorker): void;
  /** Lets virtual time catch up with the wall clock. */
  tick(): void;
  /** The session world of the attempt in progress, for tests. */
  readonly kernel: Lab['kernel'] | undefined;
  /** Real ms until the next pending event is due at the current speed; undefined when paused or idle. */
  nextEventIn(): number | undefined;
}

interface Active {
  item: Item;
  seed: number;
  startTime: Millis;
  header: SessionHeader;
  baseline: Baseline;
  lab: Lab;
  recorder: SessionRecorder;
  driver: InteractiveDriver;
  previous: SessionLog[];
  /** The terminals the page shows, in the order they were opened. */
  ttys: Map<string, { ended: boolean }>;
  editors: Map<string, OpenEditor>;
  report?: GradeReport;
  solved: boolean;
  debriefSeen: boolean;
  inputsAtCheckpoint: number;
  checkpointAt: Millis;
}

/** The session header of an attempt, as `npm run lab` writes it (apps/cli/src/labsession.ts). */
export function labHeader(item: Item, seed: number, startTime: Millis, params: SessionHeader['params']): SessionHeader {
  const h: SessionHeader = { item: item.id, topology: item.world.topology, seed, startTime, engine: ENGINE_VERSION, versions: { kubernetes: KUBERNETES_TAG }, contentHash: hashNode(item) };
  if (params !== undefined) h.params = params;
  return h;
}

/** The learn.action inputs of every attempt, in order. */
function actions(logs: readonly SessionLog[]): { action: string; data: unknown }[] {
  return logs.flatMap((l) => l.inputs.filter((i) => i.kind === 'learn.action').map((i) => ({ action: String(i['action']), data: i['data'] })));
}

/** The fields of a logged input this module reads (kernel inputs are open records). */
function field(i: LoggedInput, name: 'tty' | 'session' | 'content'): string {
  return String(i[name]);
}

export function createEngine(items: readonly Item[], emit: (m: FromWorker) => void, clock: () => number): Engine {
  let active: Active | undefined;
  let queue: FromWorker[] = [];
  let replaying = false;
  /** Output of a replay, per terminal, sent once the replay is known to be good. */
  let replayOut = new Map<string, string>();
  let last = clock();
  let lastSave = last;
  let lastClock = last;
  /** How much of the current log the page has: inputs and checkpoints. */
  let sent = { inputs: 0, checkpoints: 0 };
  /** The X-ray is open: view models go to the page. The last one sent, without its time. */
  let viewOpen = false;
  let lastView = '';
  let lastViewAt = -Infinity;

  const push = (m: FromWorker): void => {
    const prev = queue[queue.length - 1];
    if (m.type === 'tty.out' && prev?.type === 'tty.out' && prev.tty === m.tty) prev.data += m.data;
    else queue.push(m);
  };
  const flush = (): void => {
    const q = queue;
    queue = [];
    for (const m of q) emit(m);
  };
  const elapsed = (): number => {
    const t = clock();
    const d = Math.max(0, t - last);
    last = t;
    return d;
  };

  const host = (a: Active): HostSlice => a.lab.kernel.world.slices['host'] as HostSlice;

  const onOutput = (r: OutputRecord): void => {
    const a = active;
    if (r.kind === 'tty') {
      if (replaying) replayOut.set(r.tty, (replayOut.get(r.tty) ?? '') + r.data);
      else if (a?.ttys.has(r.tty)) push({ type: 'tty.out', tty: r.tty, data: r.data });
      return;
    }
    if (!a) return;
    if (r.kind === 'editor.open') {
      const request = r.request as unknown as EditorRequest;
      const editor: OpenEditor = { session: r.session, request, content: request.content, saved: false };
      if (r.tty !== undefined) editor.tty = r.tty;
      a.editors.set(r.session, editor);
      if (!replaying) push({ type: 'editor.open', editor });
      return;
    }
    const e = a.editors.get(r.session);
    if (e && r.ok) e.saved = true;
    if (!replaying) push(r.message === undefined ? { type: 'editor.status', session: r.session, ok: r.ok } : { type: 'editor.status', session: r.session, ok: r.ok, message: r.message });
  };
  const onGap = (gap: GapEvent): void => push({ type: 'gap', gap, replayed: replaying });
  const ports: Ports = { output: onOutput, gap: onGap };

  const deliver = (a: Active, input: Input, real: number): void => {
    a.driver.deliver(input, real);
  };

  const ttyInfo = (a: Active): TtyInfo[] =>
    [...a.ttys].map(([tty, t]) => {
      const rec = host(a).ttys[tty];
      return { tty, cols: rec?.cols ?? 80, rows: rec?.rows ?? 24, ended: t.ended };
    });

  const shellEnded = (a: Active, tty: string): boolean => {
    const h = host(a);
    const pid = h.ttys[tty]?.session;
    const p = pid === undefined ? undefined : h.machines[a.baseline.entry.machine]?.procs[pid];
    return !p || p.state !== 'running';
  };

  const labState = (a: Active): LabState => {
    const s: LabState = { hints: a.lab.shownHints(), solved: a.solved, solutionViewed: a.lab.solutionViewed, debriefSeen: a.debriefSeen };
    if (a.report) s.report = a.report;
    return s;
  };

  const clockOf = (a: Active): Clock => {
    const start = a.baseline.kernel.now;
    const before = a.previous.reduce((sum, l) => sum + (l.end - start), 0);
    return { elapsed: before + (a.lab.kernel.now - start), paused: a.driver.paused, speed: a.driver.speed };
  };

  const attempt = (a: Active): StoredAttempt => {
    const s: StoredAttempt = { v: 1, item: a.item.id, seed: a.seed, startTime: a.startTime, previous: a.previous, current: a.recorder.log() };
    if (a.report) s.report = a.report;
    return s;
  };

  const save = (a: Active): void => {
    const full = attempt(a);
    push({ type: 'attempt', attempt: full });
    sent = { inputs: full.current.inputs.length, checkpoints: full.current.checkpoints.length };
    lastSave = clock();
  };

  /** Sends what the log gained; with `idle`, also when only `end` moved. */
  const sendDelta = (a: Active, idle: boolean): void => {
    const log = a.recorder.log();
    if (!idle && log.inputs.length === sent.inputs && log.checkpoints.length === sent.checkpoints) return;
    push({ type: 'attempt.delta', from: sent.inputs, inputs: log.inputs.slice(sent.inputs), checkpoints: log.checkpoints.slice(sent.checkpoints), end: log.end });
    sent = { inputs: log.inputs.length, checkpoints: log.checkpoints.length };
    lastSave = clock();
  };

  const checkpoint = (a: Active): void => {
    a.recorder.checkpoint();
    a.inputsAtCheckpoint = a.recorder.log().inputs.length;
    a.checkpointAt = a.lab.kernel.now;
  };

  /** After every message and tick: ended shells, checkpoints, storage, the clock. */
  const after = (): void => {
    const a = active;
    if (a) {
      for (const [tty, t] of a.ttys) {
        if (!t.ended && shellEnded(a, tty)) {
          t.ended = true;
          push({ type: 'tty.ended', tty });
        }
      }
      const now = clock();
      const inputs = a.recorder.log().inputs.length;
      if (inputs > sent.inputs && inputs > a.inputsAtCheckpoint && a.lab.kernel.now - a.checkpointAt >= CHECKPOINT_EVERY) checkpoint(a);
      sendDelta(a, now - lastSave >= SAVE_IDLE && !a.driver.paused);
      if (now - lastClock >= CLOCK_EVERY) {
        lastClock = now;
        push({ type: 'clock', clock: clockOf(a) });
      }
      if (viewOpen && now - lastViewAt >= VIEW_EVERY) sendView(a, now);
    }
    flush();
  };

  /** Sends the world's view model if it differs from the last one sent. */
  const sendView = (a: Active, now: number): void => {
    lastViewAt = now;
    const model = buildView(registry, a.lab.kernel.world);
    const { t: _t, ...rest } = model;
    const key = JSON.stringify(rest);
    if (key === lastView) return;
    lastView = key;
    push({ type: 'view', model });
  };

  const fail = (problem: 'changed' | 'diverged' | 'unknown-item' | 'error', message: string): void => {
    active = undefined;
    push({ type: 'failed', problem, message });
  };

  const start = (msg: Extract<ToWorker, { type: 'start' }>): void => {
    active = undefined;
    // The page opens the X-ray of the new attempt again if it is open (an event of this attempt).
    viewOpen = false;
    lastView = '';
    const item = items.find((i) => i.id === msg.item);
    if (!item) return fail('unknown-item', `There is no content item ${msg.item}.`);
    const resume = msg.resume;
    if (resume && resume.current.header.contentHash !== hashNode(item)) return fail('changed', `${item.title} changed since this attempt was recorded, so it cannot be replayed.`);
    const seed = resume?.seed ?? msg.seed;
    const startTime = resume?.startTime ?? msg.startTime;
    const variant = variantOf(item, seed);
    const baseline = buildBaseline(variant, registry, { startTime });
    const header = labHeader(item, seed, startTime, variant.params);
    let lab: Lab | undefined;
    const a: Partial<Active> & { ttys: Active['ttys']; editors: Active['editors'] } = { item, seed, startTime, header, baseline, previous: resume?.previous ?? [], ttys: new Map(), editors: new Map(), solved: false, debriefSeen: false };
    active = a as Active;
    if (resume) {
      replaying = true;
      replayOut = new Map();
      let result;
      try {
        result = replay(resume.current, () => {
          lab = openLab(baseline, registry, ports, { startTime });
          a.lab = lab;
          return lab.kernel;
        });
      } finally {
        replaying = false;
      }
      if (result.diverged || !lab) return fail('diverged', `This attempt was recorded by an engine that behaved differently, so replaying it does not reach the same world (checkpoint at ${result.diverged?.checkpoint.t ?? 'start'}).`);
      a.recorder = createRecorder(lab.kernel, header, resume.current);
      const log = resume.current;
      for (const i of log.inputs) {
        if (i.kind === 'tty.open') a.ttys.set(field(i, 'tty'), { ended: false });
        else if (i.kind === 'tty.close') a.ttys.delete(field(i, 'tty'));
        else if (i.kind === 'editor.save') {
          const e = a.editors.get(field(i, 'session'));
          if (e) e.content = field(i, 'content');
        } else if (i.kind === 'editor.close') a.editors.delete(field(i, 'session'));
      }
      if (resume.report) a.report = resume.report;
      const acts = actions([...(a.previous ?? []), log]);
      const hints = acts.filter((x) => x.action === 'hint' && x.data !== null && x.data !== undefined).length;
      for (let k = 0; k < hints; k++) lab.nextHint();
      if (acts.some((x) => x.action === 'solution')) lab.solutions();
      for (const x of acts) if (x.action === 'view') lab.view((x.data as { open?: boolean } | undefined)?.open === true);
      a.solved = acts.some((x) => x.action === 'check' && (x.data as { passed?: boolean } | undefined)?.passed === true);
      a.debriefSeen = acts.some((x) => x.action === 'debrief');
      a.inputsAtCheckpoint = log.checkpoints[log.checkpoints.length - 1]?.inputs ?? 0;
      a.checkpointAt = log.checkpoints[log.checkpoints.length - 1]?.t ?? baseline.kernel.now;
    } else {
      lab = openLab(baseline, registry, ports, { startTime });
      a.lab = lab;
      a.recorder = createRecorder(lab.kernel, header);
      a.inputsAtCheckpoint = 0;
      a.checkpointAt = lab.kernel.now;
    }
    a.driver = createInteractiveDriver(a.recorder);
    const full = a as Active;
    for (const [tty, data] of replayOut) if (full.ttys.has(tty)) push({ type: 'tty.out', tty, data });
    replayOut = new Map();
    for (const [tty, t] of full.ttys) t.ended = shellEnded(full, tty);
    for (const [id] of full.editors) if (host(full).editors[id]?.state !== 'open') full.editors.delete(id);
    push({
      type: 'ready',
      lab: { id: item.id, title: item.title, seed, targetMinutes: item.targetMinutes, difficulty: item.difficulty, ticket: lab.render(lab.ticket), hintCount: lab.hintCount, engine: { version: ENGINE_VERSION, kubernetes: KUBERNETES_TAG } },
      state: labState(full),
      ttys: ttyInfo(full),
      editors: [...full.editors.values()],
      resumed: resume !== undefined,
      clock: clockOf(full),
    });
    // The time spent building the world is not the learner's.
    last = clock();
    lastClock = last;
    save(full);
  };

  const labAction = (a: Active, req: number, action: LabAction, real: number): void => {
    const act = (name: string, data?: Json): void =>
      deliver(a, data === undefined ? { kind: 'learn.action', action: name } : { kind: 'learn.action', action: name, data }, real);
    let result: LabResult;
    switch (action) {
      case 'check': {
        a.driver.tick(real);
        real = 0;
        const report = a.lab.check();
        act('check', { passed: report.passed, score: report.score });
        if (report.passed) a.solved = true;
        a.report = report;
        result = { action, report };
        break;
      }
      case 'hint': {
        const h = a.lab.nextHint();
        act('hint', h ? { index: h.index } : null);
        result = h ? { action, hint: h } : { action };
        break;
      }
      case 'debrief':
        act('debrief');
        a.debriefSeen = true;
        // Figures build their worlds on forks (a solution, a scene): the time that takes is not the learner's.
        result = { action, blocks: a.lab.render(a.lab.debrief) };
        last = clock();
        break;
      case 'solutions':
        act('solution');
        result = { action, solutions: a.lab.solutions().map((s, i) => ({ name: s.name ?? `Solution ${i + 1}`, text: showSolution(s, registry) })) };
        break;
      case 'reset': {
        act('reset');
        checkpoint(a);
        a.previous = [...a.previous, a.recorder.log()];
        const { speed, paused } = a.driver;
        a.lab.reset(ports);
        a.recorder = createRecorder(a.lab.kernel, a.header);
        a.driver = createInteractiveDriver(a.recorder, { speed });
        if (paused) a.driver.pause();
        a.ttys.clear();
        a.editors.clear();
        delete a.report;
        a.inputsAtCheckpoint = 0;
        a.checkpointAt = a.lab.kernel.now;
        lastViewAt = -Infinity;
        result = { action };
        break;
      }
    }
    if (action !== 'reset') checkpoint(a);
    push({ type: 'lab.result', req, result, state: labState(a) });
    push({ type: 'clock', clock: clockOf(a) });
    save(a);
  };

  const handle = (msg: ToWorker): void => {
    const real = elapsed();
    if (msg.type === 'start') return start(msg);
    const a = active;
    if (!a) return;
    switch (msg.type) {
      case 'tty.open': {
        const h = host(a);
        let n = 1;
        while (h.ttys[`tty${n}`]) n++;
        const tty = `tty${n}`;
        push({ type: 'tty.opened', req: msg.req, tty });
        a.ttys.set(tty, { ended: false });
        deliver(a, { kind: 'tty.open', tty, machine: a.baseline.entry.machine, user: a.baseline.entry.user, cols: msg.cols, rows: msg.rows }, real);
        return;
      }
      case 'tty.bytes':
        if (a.ttys.has(msg.tty) && !a.ttys.get(msg.tty)?.ended) deliver(a, { kind: 'tty.bytes', tty: msg.tty, data: msg.data }, real);
        return;
      case 'tty.resize':
        if (a.ttys.has(msg.tty) && !a.ttys.get(msg.tty)?.ended) deliver(a, { kind: 'tty.resize', tty: msg.tty, cols: msg.cols, rows: msg.rows }, real);
        return;
      case 'tty.close':
        if (!a.ttys.has(msg.tty)) return;
        a.ttys.delete(msg.tty);
        deliver(a, { kind: 'tty.close', tty: msg.tty }, real);
        return;
      case 'editor.save': {
        const e = a.editors.get(msg.session);
        if (!e) return;
        e.content = msg.content;
        deliver(a, { kind: 'editor.save', session: msg.session, content: msg.content }, real);
        return;
      }
      case 'editor.close':
        if (!a.editors.delete(msg.session)) return;
        deliver(a, { kind: 'editor.close', session: msg.session }, real);
        push({ type: 'editor.closed', session: msg.session });
        return;
      case 'lab':
        return labAction(a, msg.req, msg.action, real);
      case 'pause':
        a.driver.tick(real);
        if (msg.paused) a.driver.pause();
        else a.driver.resume();
        push({ type: 'clock', clock: clockOf(a) });
        return;
      case 'speed':
        a.driver.tick(real);
        a.driver.setSpeed(msg.speed);
        push({ type: 'clock', clock: clockOf(a) });
        return;
      case 'advance':
        a.driver.tick(real);
        if (msg.ms === undefined) a.driver.skipToNextEvent();
        else a.lab.kernel.advance(msg.ms);
        push({ type: 'clock', clock: clockOf(a) });
        return;
      case 'flush':
        a.driver.tick(real);
        save(a);
        return;
      case 'view':
        if (msg.open === viewOpen) return;
        viewOpen = msg.open;
        // Opening the X-ray is help: logged as a lab action, so it survives a reload.
        deliver(a, { kind: 'learn.action', action: 'view', data: { open: msg.open } }, real);
        a.lab.view(msg.open);
        if (msg.open) {
          lastView = '';
          sendView(a, clock());
        }
        return;
      case 'gap': {
        // Completed as the kernel completes an engine gap (kernel.ts Ctx.gap); not world state.
        const machine = host(a).editors[msg.session]?.machine ?? a.baseline.entry.machine;
        const g = msg.gap;
        push({ type: 'gap', replayed: false, gap: { v: 1, ...g, key: `${g.kind}:${g.program}:${g.what}`, context: { machine, seed: a.seed, virtualTime: a.lab.kernel.now } } });
        return;
      }
    }
  };

  return {
    get kernel() {
      return active?.lab?.kernel;
    },
    nextEventIn() {
      const a = active;
      if (!a?.driver || a.driver.paused) return undefined;
      const next = a.lab.kernel.nextEventTime();
      return next === undefined ? undefined : Math.max(0, next - a.lab.kernel.now) / a.driver.speed;
    },
    receive(msg) {
      try {
        handle(msg);
      } catch (e) {
        const err = e as Error;
        if (msg.type === 'start') fail('error', err.message);
        else push({ type: 'error', message: `${err.message}\n${err.stack ?? ''}` });
      }
      after();
    },
    tick() {
      try {
        if (active) active.driver.tick(elapsed());
        else elapsed();
      } catch (e) {
        const err = e as Error;
        push({ type: 'error', message: `${err.message}\n${err.stack ?? ''}` });
      }
      after();
    },
  };
}
