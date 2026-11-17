// The engine side of the web app, without the worker: one attempt at a time (a lab, a drill, an
// incident, a lesson or a card), its session
// world, the interactive time driver and the recorder (docs/ARCHITECTURE.md §2.5, §2.8). The
// worker (worker.ts) gives it messages and a monotonic clock; tests give it a fake one.
//
// Output is batched: everything a message or a tick produces is sent after it, consecutive bytes
// for one terminal in one message. A resumed attempt is replayed first; its terminal output goes
// to the page so the terminals show what they showed before the reload.

import { buildView, createInteractiveDriver, createRecorder, createRegistry, ENGINE_VERSION, hashNode, replay, type GapEvent, type InteractiveDriver, type Input, type Json, type LoggedInput, type Millis, type OutputRecord, type Ports, type SessionHeader, type SessionLog, type SessionRecorder } from '@simlab/kernel';
import { hostPlugin, type EditorRequest, type HostSlice } from '@simlab/host';
import { k8sPlugin, KUBERNETES_TAG } from '@simlab/k8s';
import { buildBaseline, cardVariantOf, grade, isScenario, lessonVariantOf, localize, openLab, scenarioShape, showSolution, tagUnits, variantOf, type Baseline, type CardVariant, type Check, type GradeReport, type Lab, type LessonVariant, type SidecarResolution, type Variant } from '@simlab/learn';
import type { Practiced } from '../content.ts';
import type { CardInfo, Clock, FromWorker, LabAction, LabInfo, LabResult, LabState, LessonStep, Note, OpenEditor, SolutionText, StoredAttempt, TaskState, ToWorker, TtyInfo } from '../protocol.ts';
import { blocksOf, figureBlock, textOf, three, translationOf, unitStates, type Three, type UnitStates } from './bilingual.ts';

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

/** The item's variant in English, with current Vietnamese, and tagged with unit keys (bilingual.ts). */
type Variants = { kind: 'scenario'; v: Three<Variant> } | { kind: 'lesson'; v: Three<LessonVariant> } | { kind: 'card'; v: Three<CardVariant> };

interface Active {
  item: Practiced;
  variants: Variants;
  states: UnitStates | undefined;
  /** A lesson's guided tasks by step: hints shown, the last report, whether it ever passed. */
  tasks: Map<number, { hints: number; passed: boolean; report?: GradeReport }>;
  notes: { confidence?: number; explanation?: string; predictions: Record<number, { choice?: number; text?: string }> };
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
export function labHeader(item: Practiced & { world: NonNullable<Practiced['world']> }, seed: number, startTime: Millis, params: SessionHeader['params']): SessionHeader {
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

/** A lesson's steps that are guided tasks, with their place among the steps. */
const lessonTasks = (v: LessonVariant) => v.steps.flatMap((s, step) => ('task' in s ? [{ step, task: s.task }] : []));

export function createEngine(items: readonly Practiced[], emit: (m: FromWorker) => void, clock: () => number, resolutionOf: (id: string) => SidecarResolution | undefined = () => undefined): Engine {
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

  /** The hint ladder of a lab-like item, or of one task of a lesson, in the three variants. */
  const hintTexts = (a: Active, step?: number): Three<string[]> => {
    if (a.variants.kind === 'scenario') return three(a.variants.v, (v) => v.hints);
    if (a.variants.kind === 'lesson' && step !== undefined)
      return three(a.variants.v, (v) => {
        const s = v.steps[step];
        return s && 'task' in s ? s.task.hints : [];
      });
    return { en: [] };
  };
  const hintText = (a: Active, index: number, step?: number) => {
    const h = hintTexts(a, step);
    return textOf(a.states, h.en[index] ?? '', h.vi?.[index], h.tag?.[index]);
  };

  /** The checks that grade the attempt, or one task of a lesson. */
  const checksOf = (a: Active, step?: number): readonly Check[] => {
    if (a.variants.kind === 'card') return a.variants.v.en.checks;
    if (a.variants.kind === 'lesson') {
      const s = step === undefined ? undefined : a.variants.v.en.steps[step];
      return s && 'task' in s ? s.task.checks : [];
    }
    return a.variants.v.en.checks;
  };

  /** A lesson is solved when every guided task has passed. */
  const lessonSolved = (a: Active): boolean => a.variants.kind === 'lesson' && lessonTasks(a.variants.v.en).every((t) => a.tasks.get(t.step)?.passed === true);

  const lessonFigures = (a: Active): Record<number, LabState['figures'] extends Record<number, infer B> | undefined ? B : never> => {
    if (a.variants.kind !== 'lesson') return {};
    const v = a.variants.v;
    const out: Record<number, ReturnType<typeof figureBlock>> = {};
    v.en.steps.forEach((s, i) => {
      if (!('figure' in s)) return;
      const vi = v.vi?.steps[i];
      const tag = v.tag?.steps[i];
      out[i] = figureBlock(a.lab, a.states, s.figure, vi && 'figure' in vi ? vi.figure : undefined, tag && 'figure' in tag ? tag.figure : undefined);
    });
    return out;
  };

  const labState = (a: Active, withFigures = false): LabState => {
    const s: LabState = { hints: a.lab.shownHints().map((_, i) => hintText(a, i)), solved: a.solved, solutionViewed: a.lab.solutionViewed, debriefSeen: a.debriefSeen };
    if (a.report) s.report = a.report;
    if (a.notes.confidence !== undefined) s.confidence = a.notes.confidence;
    if (a.notes.explanation !== undefined) s.explanation = a.notes.explanation;
    if (a.variants.kind === 'lesson') {
      const tasks: Record<number, TaskState> = {};
      for (const { step } of lessonTasks(a.variants.v.en)) {
        const t = a.tasks.get(step);
        const task: TaskState = { hints: Array.from({ length: t?.hints ?? 0 }, (_, i) => hintText(a, i, step)), passed: t?.passed === true };
        if (t?.report) task.report = t.report;
        tasks[step] = task;
      }
      s.tasks = tasks;
      s.predictions = a.notes.predictions;
      if (withFigures) s.figures = lessonFigures(a);
    }
    return s;
  };

  const solutionTexts = (a: Active): SolutionText[] => {
    if (a.variants.kind === 'lesson') return [];
    if (a.variants.kind === 'card') return a.variants.v.en.solution.length > 0 ? [{ name: { en: 'Solution' }, text: showSolution({ steps: a.variants.v.en.solution }, registry) }] : [];
    const v = a.variants.v;
    return v.en.solutions.map((sol, i) => ({ name: sol.name === undefined ? { en: `Solution ${i + 1}` } : textOf(a.states, sol.name, v.vi?.solutions[i]?.name, v.tag?.solutions[i]?.name), text: showSolution(sol, registry) }));
  };

  /**
   * The commands the learner's interactive shells remember, in the order the shells started. A
   * shell at its prompt keeps its whole state as data (packages/host/src/shell/bash.ts), history
   * included; a terminal that was closed, and the world before a reset, took theirs with them.
   */
  const commandHistory = (a: Active): string[] => {
    const h = host(a);
    const shells = Object.values(h.machines)
      .flatMap((m) => Object.values(m.procs))
      .filter((p) => p.image === 'bash' && p.tty !== undefined && a.ttys.has(p.tty))
      .sort((x, y) => x.startedAt - y.startedAt || (x.pid < y.pid ? -1 : 1));
    return shells.flatMap((p) => {
      const state = p.resume as { interactive?: boolean; history?: unknown } | undefined;
      return state?.interactive === true && Array.isArray(state.history) ? state.history.filter((c): c is string => typeof c === 'string') : [];
    });
  };

  const labInfo = (a: Active): LabInfo => {
    const { item } = a;
    const r = resolutionOf(item.id);
    const t3 = three(a.variants.v as Three<{ item: { title: string } }>, (v) => v.item.title);
    const info: LabInfo = {
      id: item.id,
      kind: item.kind,
      title: textOf(a.states, t3.en, t3.vi, t3.tag),
      seed: a.seed,
      targetMinutes: item.targetMinutes,
      difficulty: item.difficulty,
      ticket: [],
      hintCount: a.lab.hintCount,
      checkTitles: {},
      translation: translationOf(r),
      world: true,
      engine: { version: ENGINE_VERSION, kubernetes: KUBERNETES_TAG },
    };
    const titles = (c3: Three<readonly Check[]>): void => {
      c3.en.forEach((c, i) => {
        info.checkTitles[c.id] = textOf(a.states, c.title, c3.vi?.[i]?.title, c3.tag?.[i]?.title);
      });
    };
    if (a.variants.kind === 'scenario') {
      const v = a.variants.v;
      info.ticket = blocksOf(a.lab, a.states, three(v, (x) => x.ticket));
      titles(three(v, (x) => x.checks));
    } else if (a.variants.kind === 'lesson') {
      const v = a.variants.v;
      const figures = lessonFigures(a);
      info.steps = v.en.steps.map((s, i): LessonStep => {
        const vi = v.vi?.steps[i];
        const tag = v.tag?.steps[i];
        if ('text' in s) return { kind: 'text', text: textOf(a.states, s.text, vi && 'text' in vi ? vi.text : undefined, tag && 'text' in tag ? tag.text : undefined) };
        if ('figure' in s) return { kind: 'figure', block: figures[i] as NonNullable<(typeof figures)[number]> };
        if ('predict' in s) {
          const pv = vi && 'predict' in vi ? vi.predict : undefined;
          const pt = tag && 'predict' in tag ? tag.predict : undefined;
          const step: LessonStep = { kind: 'predict', prompt: textOf(a.states, s.predict.prompt, pv?.prompt, pt?.prompt), explain: textOf(a.states, s.predict.explain, pv?.explain, pt?.explain) };
          if (s.predict.choices) step.choices = s.predict.choices.map((c, j) => textOf(a.states, c, pv?.choices?.[j], pt?.choices?.[j]));
          if (s.predict.answer !== undefined) step.answer = s.predict.answer;
          return step;
        }
        const tv = vi && 'task' in vi ? vi.task : undefined;
        const tt = tag && 'task' in tag ? tag.task : undefined;
        titles({ en: s.task.checks, ...(tv ? { vi: tv.checks } : {}), ...(tt ? { tag: tt.checks } : {}) });
        return { kind: 'task', text: textOf(a.states, s.task.text, tv?.text, tt?.text), hintCount: s.task.hints.length };
      });
    } else {
      const v = a.variants.v;
      info.ticket = cardBlocks(a.lab, a.states, v);
      info.card = cardInfo(a.states, v, true);
      titles(three(v, (x) => x.checks));
    }
    return info;
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
    const resolution = resolutionOf(item.id);
    const states = unitStates(resolution);
    const make = <V>(of: (i: never) => V): Three<V> => {
      const f = of as (i: Practiced) => V;
      return resolution ? { en: f(item), vi: f(localize(item, resolution)), tag: f(tagUnits(item)) } : { en: f(item) };
    };
    if (item.kind === 'card' && !item.world) {
      // A card with no world: a question, nothing to simulate, nothing to resume.
      const v = make((i: typeof item) => cardVariantOf(i, msg.seed));
      const t3 = three(v, (x) => x.item.title);
      push({
        type: 'ready',
        lab: { id: item.id, kind: 'card', title: textOf(states, t3.en, t3.vi, t3.tag), seed: msg.seed, targetMinutes: item.targetMinutes, difficulty: item.difficulty, ticket: cardBlocks(undefined, states, v), hintCount: 0, checkTitles: {}, translation: translationOf(resolution), card: cardInfo(states, v, false), world: false, engine: { version: ENGINE_VERSION, kubernetes: KUBERNETES_TAG } },
        state: { hints: [], solved: false, solutionViewed: false, debriefSeen: false },
        ttys: [],
        editors: [],
        resumed: false,
        clock: { elapsed: 0, paused: false, speed: 1 },
      });
      return;
    }
    const worldItem = item as Practiced & { world: NonNullable<Practiced['world']> };
    const resume = msg.resume;
    if (resume && resume.current.header.contentHash !== hashNode(item)) return fail('changed', `${item.title} changed since this attempt was recorded, so it cannot be replayed.`);
    const seed = resume?.seed ?? msg.seed;
    const startTime = resume?.startTime ?? msg.startTime;
    // What the scenario runner builds the world from: the item itself, or a lesson's or a card's
    // world with its solutions in order (docs/LEARNING_MODEL.md §12).
    let variants: Variants;
    let variant: Variant;
    if (isScenario(item)) {
      variants = { kind: 'scenario', v: make((i: typeof item) => variantOf(i, seed)) };
      variant = variants.v.en;
    } else if (item.kind === 'lesson') {
      variants = { kind: 'lesson', v: make((i: typeof item) => lessonVariantOf(i, seed)) };
      const lv = variants.v.en;
      variant = scenarioShape(item.world, lv, item.id, lessonTasks(lv).flatMap((t) => t.task.solution));
    } else {
      variants = { kind: 'card', v: make((i: typeof item) => cardVariantOf(i, seed)) };
      const cv = variants.v.en;
      variant = scenarioShape(worldItem.world, cv.world as NonNullable<CardVariant['world']>, item.id, cv.solution);
    }
    const baseline = buildBaseline(variant, registry, { startTime });
    const header = labHeader(worldItem, seed, startTime, variant.params);
    let lab: Lab | undefined;
    const a: Partial<Active> & Pick<Active, 'ttys' | 'editors' | 'tasks' | 'notes'> = { item, variants, states, tasks: new Map(), notes: { predictions: {} }, seed, startTime, header, baseline, previous: resume?.previous ?? [], ttys: new Map(), editors: new Map(), solved: false, debriefSeen: false };
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
      const stepOf = (x: { data: unknown }): number | undefined => (x.data as { step?: number } | null | undefined)?.step;
      const task = (step: number) => {
        if (!a.tasks.has(step)) a.tasks.set(step, { hints: 0, passed: false });
        return a.tasks.get(step) as { hints: number; passed: boolean };
      };
      for (const x of acts) {
        if (x.action === 'hint' && x.data !== null && x.data !== undefined) {
          const step = stepOf(x);
          if (step === undefined) lab.nextHint();
          else task(step).hints++;
        } else if (x.action === 'check' && stepOf(x) !== undefined && (x.data as { passed?: boolean }).passed === true) task(stepOf(x) as number).passed = true;
        else if (x.action === 'note') applyNote(a.notes, x.data as Note);
        else if (x.action === 'view') lab.view((x.data as { open?: boolean } | undefined)?.open === true);
      }
      if (acts.some((x) => x.action === 'solution')) lab.solutions();
      a.solved = variants.kind === 'lesson' ? lessonSolved(a as Active) : acts.some((x) => x.action === 'check' && (x.data as { passed?: boolean } | undefined)?.passed === true);
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
      lab: labInfo(full),
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

  const labAction = (a: Active, req: number, action: LabAction, real: number, step?: number): void => {
    const act = (name: string, data?: Json): void =>
      deliver(a, data === undefined ? { kind: 'learn.action', action: name } : { kind: 'learn.action', action: name, data }, real);
    let result: LabResult;
    let figuresChanged = false;
    switch (action) {
      case 'check': {
        a.driver.tick(real);
        real = 0;
        if (a.variants.kind === 'lesson') {
          if (step === undefined) throw new Error('a lesson is checked one guided task at a time');
          const report = grade(a.lab.kernel, checksOf(a, step), { registry, entry: a.baseline.entry, baseline: a.baseline.kernel.world });
          act('check', { passed: report.passed, score: report.score, step });
          const t = a.tasks.get(step) ?? { hints: 0, passed: false };
          a.tasks.set(step, { ...t, passed: t.passed || report.passed, report });
          a.solved = lessonSolved(a);
          figuresChanged = report.passed;
          result = { action, report, step };
          break;
        }
        const report = a.variants.kind === 'card' ? grade(a.lab.kernel, checksOf(a), { registry, entry: a.baseline.entry, baseline: a.baseline.kernel.world }) : a.lab.check();
        act('check', { passed: report.passed, score: report.score });
        if (report.passed) a.solved = true;
        a.report = report;
        result = { action, report };
        break;
      }
      case 'hint': {
        if (a.variants.kind === 'lesson' && step !== undefined) {
          const t = a.tasks.get(step) ?? { hints: 0, passed: false };
          const index = t.hints;
          if (index >= hintTexts(a, step).en.length) {
            act('hint', null);
            result = { action, step };
            break;
          }
          act('hint', { index, step });
          a.tasks.set(step, { ...t, hints: index + 1 });
          result = { action, hint: { index, text: hintText(a, index, step) }, step };
          break;
        }
        const h = a.lab.nextHint();
        act('hint', h ? { index: h.index } : null);
        result = h ? { action, hint: { index: h.index, text: hintText(a, h.index) } } : { action };
        break;
      }
      case 'debrief':
        act('debrief');
        a.debriefSeen = true;
        // Figures build their worlds on forks (a solution, a scene): the time that takes is not the learner's.
        result = { action, blocks: a.variants.kind === 'scenario' ? blocksOf(a.lab, a.states, three(a.variants.v, (v) => v.debrief)) : [], history: commandHistory(a), solutions: solutionTexts(a) };
        last = clock();
        break;
      case 'solutions':
        act('solution');
        a.lab.solutions();
        result = { action, solutions: solutionTexts(a) };
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
        for (const [k, t] of a.tasks) a.tasks.set(k, { hints: t.hints, passed: t.passed });
        a.inputsAtCheckpoint = 0;
        a.checkpointAt = a.lab.kernel.now;
        lastViewAt = -Infinity;
        result = { action };
        break;
      }
    }
    if (action !== 'reset') checkpoint(a);
    push({ type: 'lab.result', req, result, state: labState(a, figuresChanged), clock: clockOf(a) });
    if (figuresChanged) last = clock();
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
        return labAction(a, msg.req, msg.action, real, msg.step);
      case 'note':
        deliver(a, { kind: 'learn.action', action: 'note', data: msg.note as unknown as Json }, real);
        applyNote(a.notes, msg.note);
        return;
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

function applyNote(notes: { confidence?: number; explanation?: string; predictions: Record<number, { choice?: number; text?: string }> }, n: Note): void {
  if (n.kind === 'confidence') notes.confidence = n.value;
  else if (n.kind === 'explanation') notes.explanation = n.text;
  else {
    const p: { choice?: number; text?: string } = {};
    if (n.choice !== undefined) p.choice = n.choice;
    if (n.text !== undefined) p.text = n.text;
    notes.predictions[n.step] = p;
  }
}

/** A card's prompt and its figure, as the blocks a ticket is. */
function cardBlocks(lab: Lab | undefined, states: UnitStates | undefined, v: Three<CardVariant>): LabInfo['ticket'] {
  const out: LabInfo['ticket'] = [{ text: textOf(states, v.en.prompt, v.vi?.prompt, v.tag?.prompt) }];
  if (v.en.figure) out.push(figureBlock(lab, states, v.en.figure, v.vi?.figure, v.tag?.figure));
  return out;
}

function cardInfo(states: UnitStates | undefined, v: Three<CardVariant>, world: boolean): CardInfo {
  const info: CardInfo = { way: v.en.choices ? 'choice' : world && v.en.checks.length > 0 ? 'command' : 'self', answer: textOf(states, v.en.answer, v.vi?.answer, v.tag?.answer) };
  if (v.en.choices) info.choices = v.en.choices.map((c, i) => textOf(states, c, v.vi?.choices?.[i], v.tag?.choices?.[i]));
  if (v.en.correct !== undefined) info.correct = v.en.correct;
  return info;
}
