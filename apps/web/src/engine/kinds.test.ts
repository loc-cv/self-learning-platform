// The engine session with the kinds phase 12 gave screens to: a lesson's guided tasks and
// predictions, cards with and without a world, text in two languages, the command history. The
// fixture pack (docs/LEARNING_MODEL.md §11) has one item of each, and two sidecars.

import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CONTENT_ROOT, loadPacks } from '@simlab/content';
import { parseSidecar, resolveSidecar, type AnyItem, type SidecarResolution } from '@simlab/learn';
import type { Practiced } from '../content.ts';
import type { FromWorker, LessonStep, StoredAttempt, ToWorker } from '../protocol.ts';
import { createEngine, type Engine } from './session.ts';

const FILES = loadPacks(join(CONTENT_ROOT, 'fixtures')).flatMap((p) => p.items);
const ITEMS = FILES.map((f) => f.raw as unknown as AnyItem).filter((i): i is Practiced => i.kind !== 'exam');
const RESOLUTIONS = new Map<string, SidecarResolution>(
  FILES.flatMap((f) => {
    const sidecar = f.sidecar ? parseSidecar(f.sidecar.raw).sidecar : undefined;
    return sidecar ? [[f.fileId, resolveSidecar(f.raw as unknown as AnyItem, sidecar)] as const] : [];
  }),
);
const LESSON = 'fx.workloads.scaling-lesson-01';
const START = 1_800_000_000_000;

function rig() {
  const seen: FromWorker[] = [];
  const t = { now: 0 };
  const engine: Engine = createEngine(ITEMS, (m) => seen.push(m), () => t.now, (id) => RESOLUTIONS.get(id));
  const screen = (tty: string): string => seen.flatMap((m) => (m.type === 'tty.out' && m.tty === tty ? [m.data] : [])).join('');
  const last = <T extends FromWorker['type']>(type: T): Extract<FromWorker, { type: T }> => {
    const m = [...seen].reverse().find((x) => x.type === type);
    if (!m) throw new Error(`no ${type} message`);
    return m as Extract<FromWorker, { type: T }>;
  };
  const settle = (done: () => boolean): void => {
    for (let i = 0; i < 200 && !done(); i++) {
      t.now += 50;
      engine.tick();
    }
  };
  return {
    engine,
    seen,
    t,
    last,
    send: (m: ToWorker) => engine.receive(m),
    open(): string {
      engine.receive({ type: 'tty.open', req: 1, cols: 120, rows: 30 });
      const tty = last('tty.opened').tty;
      settle(() => /[$#] $/.test(screen(tty)));
      return tty;
    },
    type(tty: string, line: string): void {
      const before = screen(tty).length;
      t.now += 100;
      engine.receive({ type: 'tty.bytes', tty, data: `${line}\r` });
      settle(() => /[$#] $/.test(screen(tty).slice(before + line.length)));
    },
    lab(action: 'check' | 'hint' | 'debrief' | 'solutions' | 'reset', step?: number) {
      engine.receive(step === undefined ? { type: 'lab', req: 9, action } : { type: 'lab', req: 9, action, step });
      return last('lab.result');
    },
  };
}

const kinds = (steps: readonly LessonStep[] | undefined): string[] => (steps ?? []).map((s) => s.kind);

describe('a lesson in the engine', () => {
  test('steps, a guided task graded on the world, hints per task, predictions; all of it back after a resume', () => {
    const r = rig();
    r.send({ type: 'start', item: LESSON, seed: 1, startTime: START });
    const ready = r.last('ready');
    expect(ready.lab.kind).toBe('lesson');
    expect(kinds(ready.lab.steps)).toEqual(['text', 'figure', 'predict', 'task', 'predict', 'figure']);
    expect(ready.lab.steps?.[1]).toMatchObject({ kind: 'figure', block: { figure: { kind: 'view' } } });
    expect(ready.lab.steps?.[2]).toMatchObject({ answer: 1 });
    expect(ready.lab.steps?.[3]).toMatchObject({ hintCount: 1 });
    expect(Object.keys(ready.lab.checkTitles)).toEqual(['scaled']);
    expect(ready.state.tasks).toEqual({ 3: { hints: [], passed: false } });

    const tty = r.open();
    const task = (ready.lab.steps?.[3] as Extract<LessonStep, { kind: 'task' }>).text.en;
    const [, ns, n] = /namespace `(\w+)` to (\d) replicas/.exec(task) as RegExpExecArray;
    // Untouched, the task fails; a hint is the task's own; a second one does not exist.
    const failed = r.lab('check', 3);
    expect(failed.result).toMatchObject({ action: 'check', step: 3, report: { passed: false } });
    expect(failed.state.solved).toBe(false);
    expect(r.lab('hint', 3).result).toMatchObject({ action: 'hint', step: 3, hint: { index: 0, text: { en: expect.stringContaining('kubectl scale') as string } } });
    expect(r.lab('hint', 3).result).toEqual({ action: 'hint', step: 3 });
    r.send({ type: 'note', note: { kind: 'prediction', step: 2, choice: 1 } });
    r.type(tty, `kubectl -n ${ns} scale deployment web --replicas=${n}`);
    r.send({ type: 'advance', ms: 90_000 });
    const passed = r.lab('check', 3);
    expect(passed.result).toMatchObject({ report: { passed: true } });
    expect(passed.state.solved).toBe(true);
    expect(passed.state.tasks?.[3]).toMatchObject({ passed: true, hints: [{ en: expect.any(String) as string }] });
    // The figures are drawn again once a task passes.
    expect(Object.keys(passed.state.figures ?? {})).toEqual(['1', '5']);
    expect(passed.clock.elapsed).toBeGreaterThan(90_000);

    // A reload: the attempt replays to the same lesson state.
    r.send({ type: 'flush' });
    const stored: StoredAttempt = structuredClone(r.last('attempt').attempt);
    const again = rig();
    again.send({ type: 'start', item: LESSON, seed: 1, startTime: START, resume: stored });
    const resumed = again.last('ready');
    expect(resumed.resumed).toBe(true);
    expect(resumed.state.solved).toBe(true);
    expect(resumed.state.tasks?.[3]).toMatchObject({ passed: true });
    expect(resumed.state.tasks?.[3]?.hints).toHaveLength(1);
    expect(resumed.state.predictions).toEqual({ 2: { choice: 1 } });
  });

  test('text in two languages: current Vietnamese beside the English, a reason where there is none', () => {
    const r = rig();
    r.send({ type: 'start', item: LESSON, seed: 1, startTime: START });
    const lab = r.last('ready').lab;
    expect(lab.translation).toBe('partial');
    expect(lab.title).toEqual({ en: 'A replica count is a wish the Deployment keeps granting', vi: 'Số replica là một mong muốn mà Deployment luôn đáp ứng' });
    const steps = lab.steps as LessonStep[];
    // Translated from an earlier English: the English stands, marked outdated.
    expect(steps[0]).toMatchObject({ text: { gap: 'outdated' } });
    expect((steps[0] as { text: { vi?: string } }).text.vi).toBeUndefined();
    // Current, with the seed's values substituted in both.
    const prompt = (steps[2] as Extract<LessonStep, { kind: 'predict' }>).prompt;
    expect(prompt.vi).toMatch(/^Bạn đặt `replicas` thành \d\./);
    expect(prompt.en).toMatch(/^You set `replicas` to \d\./);
    expect(prompt.gap).toBeUndefined();
    expect((steps[2] as Extract<LessonStep, { kind: 'predict' }>).choices?.[0]).toMatchObject({ gap: 'missing' });
    // A figure none of whose texts is translated is drawn once and says so.
    expect(steps[1]).toMatchObject({ block: { gap: 'missing' } });
    expect((steps[1] as { block: { vi?: unknown } }).block.vi).toBeUndefined();
  });
});

describe('cards in the engine', () => {
  test('a card with no world is a question: no terminal, a diagram, choices, the answer', () => {
    const r = rig();
    r.send({ type: 'start', item: 'fx.workloads.owner-card-01', seed: 3, startTime: START });
    const ready = r.last('ready');
    expect(ready.lab).toMatchObject({ kind: 'card', world: false, card: { way: 'choice', correct: 1 }, translation: 'partial' });
    expect(ready.lab.card?.choices).toHaveLength(3);
    expect(ready.lab.ticket[0]).toMatchObject({ text: { en: expect.stringContaining('Which controller creates the third?') as string, vi: expect.stringContaining('Controller nào') as string } });
    // The figure is drawn in English and once more with its Vietnamese caption.
    expect(ready.lab.ticket[1]).toMatchObject({ figure: { kind: 'diagram', caption: 'The chain of ownership.' }, vi: { caption: 'Chuỗi sở hữu.' } });
    expect(r.engine.kernel).toBeUndefined();
    expect(r.seen.some((m) => m.type === 'attempt')).toBe(false);
  });

  test('a card by command is graded on the state of its world', () => {
    const r = rig();
    r.send({ type: 'start', item: 'fx.workloads.scale-card-01', seed: 2, startTime: START });
    const ready = r.last('ready');
    expect(ready.lab).toMatchObject({ kind: 'card', world: true, card: { way: 'command' } });
    const tty = r.open();
    expect(r.lab('check').result).toMatchObject({ report: { passed: false } });
    const answer = ready.lab.card?.answer.en.replace(/`/g, '') ?? '';
    expect(answer).toMatch(/^kubectl -n \w+ scale deployment web --replicas=\d$/);
    r.type(tty, answer);
    r.send({ type: 'advance', ms: 90_000 });
    const res = r.lab('check');
    expect(res.result).toMatchObject({ report: { passed: true } });
    expect(res.state.solved).toBe(true);
  });
});

describe('a drill in the engine', () => {
  test('the debrief comes with the commands the shells remember and the solution; notes survive a resume', () => {
    const r = rig();
    r.send({ type: 'start', item: 'fx.workloads.scale-drill-01', seed: 4, startTime: START });
    const tty = r.open();
    r.type(tty, 'kubectl get ns');
    r.type(tty, 'echo "second command"');
    r.send({ type: 'note', note: { kind: 'confidence', value: 2 } });
    r.send({ type: 'note', note: { kind: 'explanation', text: 'the count was one' } });
    const res = r.lab('debrief');
    if (res.result.action !== 'debrief') throw new Error('not a debrief');
    expect(res.result.history).toEqual(['kubectl get ns', 'echo "second command"']);
    expect(res.result.solutions.map((s) => s.text)).toEqual([expect.stringMatching(/^\$ kubectl -n \w+ scale deployment web --replicas=\d/) as string]);
    expect(res.result.blocks.map((b) => Object.keys(b)[0])).toEqual(['figure', 'text']);
    expect(res.state).toMatchObject({ confidence: 2, explanation: 'the count was one', debriefSeen: true });
    r.send({ type: 'flush' });
    const again = rig();
    again.send({ type: 'start', item: 'fx.workloads.scale-drill-01', seed: 4, startTime: START, resume: structuredClone(r.last('attempt').attempt) });
    expect(again.last('ready').state).toMatchObject({ confidence: 2, explanation: 'the count was one', debriefSeen: true });
  });
});
