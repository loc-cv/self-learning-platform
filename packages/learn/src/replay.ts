// The replay of a run as frames (PLAN.md §5 "Feedback that explains", §6.5 surface 3): the world
// at the start with why what is broken is broken, the moment each change landed, and how the
// world went on, each at the virtual time it happened and with the causes the trace recorded.
//
// A learner's attempt is replayed from its input log on a world of its own (twice: once to read
// the trace and find the moments, once to draw them), so the session is never touched. A
// reference solution is run step by step on another fork and drawn the same way. Everything
// here reads the world through the view contract and names no domain.

import { buildView, buildWhy, createReplayCursor, type Millis, type Registry, type SessionLog, type ViewEvent, type ViewModel, type Why } from '@simlab/kernel';
import { eventsIn, eventsOf, lastRecord, linksIn } from './figure/events.ts';
import { focusView, markChanges, viewKey } from './figure/focus.ts';
import type { Focus, Panel, ShowItem } from './figure/types.ts';
import type { Solution } from './item/types.ts';
import { startSession, type Baseline } from './runner/build.ts';
import { runSteps } from './runner/steps.ts';
import { showStep } from './show.ts';

export interface ReplayFrame {
  /** Virtual time the frame shows. */
  t: Millis;
  /**
   * - `start`: the world as the run found it;
   * - `change`: something the run did has landed (a command returned, a step ran);
   * - `settled`: how the world went on by itself afterwards, at the last thing that happened
   *   before the next change (or the end).
   */
  kind: 'start' | 'change' | 'settled';
  /** For a change: what was done, as it was typed or as the step reads. Several when they landed together. */
  labels: string[];
  /** What the trace recorded since the frame before about what is drawn, oldest first (commands excluded). */
  events: ViewEvent[];
  panel: Panel;
}

export interface Replay {
  start: Millis;
  end: Millis;
  frames: ReplayFrame[];
  /** Every command of the run, in order, also those that changed nothing that is drawn. */
  inputs: ViewEvent[];
  /** At the start: why each entity that is not working is so, from the trace of the setup. */
  causes: Why[];
  /** Frames left out because the run had more than `REPLAY_FRAMES` of them. */
  omitted: number;
}

export interface ReplayOptions {
  focus?: Focus;
  show?: readonly ShowItem[];
}

/** A replay draws at most this many frames; a longer run keeps the first and the last ones. */
export const REPLAY_FRAMES = 60;
/** At most this many entities are explained at the start. */
export const REPLAY_CAUSES = 6;

const BROKEN = new Set(['degraded', 'failed']);

interface Drawing {
  frames: ReplayFrame[];
  previous: Panel;
  /** The newest event a frame has shown: the next frame shows what came after it. */
  shown: number;
}

function panelOf(model: ViewModel): Panel {
  return { model, highlight: [], notes: [], changes: {} };
}

/**
 * Adds a frame if the drawing differs from the one before, or if `acted` says the run did
 * something to what is drawn that the drawing does not show yet (a declaration was changed and
 * nothing has reacted so far). Returns whether it did.
 */
function draw(d: Drawing, kind: ReplayFrame['kind'], t: Millis, model: ViewModel, labels: string[], happened: readonly ViewEvent[], acted = false): boolean {
  if (!acted && viewKey(model) === viewKey(d.previous.model)) return false;
  const panel = panelOf(model);
  const before = panelOf(d.previous.model);
  markChanges(before, panel);
  const since = pending(d, happened, t);
  const events = eventsIn(since, model);
  const links = linksIn(events, model);
  if (links.length > 0) panel.links = links;
  d.frames.push({ t, kind, labels, events, panel });
  d.previous = panel;
  d.shown = since.at(-1)?.id ?? d.shown;
  return true;
}

/** What components did up to `t` that no frame has shown yet (commands are not among it). */
function pending(d: Drawing, happened: readonly ViewEvent[], t: Millis): ViewEvent[] {
  return happened.filter((e) => e.input !== true && e.level === 'key' && e.id > d.shown && e.t <= t);
}

function startCauses(registry: Registry, world: Parameters<typeof buildView>[1], model: ViewModel, events: readonly ViewEvent[]): Why[] {
  const out: Why[] = [];
  for (const e of model.entities) {
    if (out.length >= REPLAY_CAUSES) break;
    if (!BROKEN.has(e.state)) continue;
    const why = buildWhy(registry, world, events, e.id);
    if (why && why.steps.length > 0) out.push(why);
  }
  return out;
}

function limit(frames: ReplayFrame[]): { frames: ReplayFrame[]; omitted: number } {
  if (frames.length <= REPLAY_FRAMES) return { frames, omitted: 0 };
  const head = Math.ceil(REPLAY_FRAMES / 2);
  const tail = REPLAY_FRAMES - head;
  return { frames: [...frames.slice(0, head), ...frames.slice(frames.length - tail)], omitted: frames.length - REPLAY_FRAMES };
}

/** When a command's effect is in the world: when it ended, or when it was entered if it still runs. */
const landed = (c: ViewEvent): Millis => c.until ?? c.t;

/**
 * The replay of an attempt from its input log. `baseline` is the world the log started from. A
 * frame is drawn where the drawing changed: when a command returned, and at the last recorded
 * event before the next command was entered.
 */
export function replayAttempt(log: SessionLog, baseline: Baseline, registry: Registry, options: ReplayOptions = {}): Replay {
  const focused = (world: Parameters<typeof buildView>[1]): ViewModel => focusView(buildView(registry, world), options.focus, options.show);
  const start = baseline.kernel.now;
  const before = lastRecord(baseline.kernel);

  // First pass: the whole run, for its trace.
  const first = createReplayCursor(log, startSession(baseline).kernel);
  first.seek(log.end);
  const all = eventsOf(registry, first.kernel);
  const happened = all.filter((e) => e.id > before);
  const inputs = happened.filter((e) => e.input === true);
  const others = happened.filter((e) => e.input !== true && e.level === 'key');

  // The moments worth drawing, in time order: each landing, and the last event of each quiet stretch.
  const landings = [...new Set(inputs.map(landed))].sort((a, b) => a - b);
  const moments: { t: Millis; kind: 'change' | 'settled' }[] = [];
  const bounds = [start, ...landings];
  bounds.forEach((from, i) => {
    if (i > 0) moments.push({ t: from, kind: 'change' });
    const next = landings[i];
    // The stretch ends where the next command is entered (it may run for a while before it lands);
    // the last stretch runs to the end of the log, inclusive.
    const entered = next === undefined ? log.end + 1 : Math.min(next, ...inputs.filter((c) => landed(c) === next).map((c) => c.t));
    const last = others.filter((e) => e.t > from && e.t < entered).at(-1);
    if (last) moments.push({ t: last.t, kind: 'settled' });
  });

  // Second pass: draw them.
  const second = createReplayCursor(log, startSession(baseline).kernel);
  const model0 = focused(second.kernel.world);
  const d: Drawing = { frames: [{ t: start, kind: 'start', labels: [], events: [], panel: panelOf(model0) }], previous: panelOf(model0), shown: before };
  const causes = startCauses(registry, second.kernel.world, model0, all.filter((e) => e.id <= before));
  for (const m of moments) {
    second.seek(m.t);
    const model = focused(second.kernel.world);
    if (m.kind === 'settled') {
      draw(d, m.kind, m.t, model, [], happened);
      continue;
    }
    // The commands that returned now, and whether the trace recorded them doing something to what
    // is drawn while they ran: a command that only read leaves no such event.
    const commands = inputs.filter((c) => landed(c) === m.t);
    const during = eventsIn(others.filter((e) => commands.some((c) => e.t >= c.t && e.t <= m.t)), model);
    const acting = commands.filter((c) => during.some((e) => e.t >= c.t));
    draw(d, m.kind, m.t, model, (acting.length > 0 ? acting : commands).map((c) => c.text), happened, during.length > 0);
  }
  return { start, end: log.end, ...limit(d.frames), inputs, causes };
}

/**
 * The replay of a reference solution: its steps run on a fork of the baseline, a frame after each
 * step that changed the drawing. A step that waits (`until`, `advance`) shows how the world settled.
 */
export function replaySolution(solution: Solution, baseline: Baseline, registry: Registry, options: ReplayOptions = {}): Replay {
  const focused = (world: Parameters<typeof buildView>[1]): ViewModel => focusView(buildView(registry, world), options.focus, options.show);
  const { kernel, hub } = startSession(baseline);
  const start = kernel.now;
  const before = lastRecord(kernel);
  const model0 = focused(kernel.world);
  const d: Drawing = { frames: [{ t: start, kind: 'start', labels: [], events: [], panel: panelOf(model0) }], previous: panelOf(model0), shown: before };
  const causes = startCauses(registry, kernel.world, model0, eventsOf(registry, kernel));
  let inputs: ViewEvent[] = [];
  runSteps(
    kernel,
    solution.steps,
    {
      registry,
      entry: baseline.entry,
      hub,
      baseline: baseline.kernel.world,
      onStep(_i, step, kind) {
        const waits = kind === 'until' || kind === 'advance';
        const happened = eventsOf(registry, kernel).filter((e) => e.id > before);
        // The commands so far: read here, before the runner's own logins end with the list.
        inputs = happened.filter((e) => e.input === true);
        const model = focused(kernel.world);
        const acted = !waits && eventsIn(pending(d, happened, kernel.now), model).length > 0;
        draw(d, waits ? 'settled' : 'change', kernel.now, model, waits ? [] : [showStep(step, registry)], happened, acted);
      },
    },
    solution.name ?? 'solution',
  );
  return { start, end: kernel.now, ...limit(d.frames), inputs, causes };
}
