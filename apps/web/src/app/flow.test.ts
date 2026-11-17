import { describe, expect, it } from 'vitest';
import { eventProblem, type GradeReport } from '@simlab/learn';
import type { LessonStep } from '../protocol.ts';
import { leaveOutcome, lessonDone, nextReview, noteEvent, resultEvents, startedEvent } from './flow.ts';

const report = (passed: boolean): GradeReport => ({ passed, score: passed ? 1 : 0.5, at: 1, checks: [{ id: 'a', title: 'A', status: 'pass', weight: 1, expected: '', observed: '' }, { id: 'b', title: 'B', status: passed ? 'pass' : 'fail', weight: 1, expected: 'x', observed: 'y' }] }) as unknown as GradeReport;

describe('events of an attempt', () => {
  it('every event the flow makes is one the log accepts', () => {
    const steps: LessonStep[] = [{ kind: 'predict', prompt: { en: '?' }, choices: [{ en: 'a' }, { en: 'b' }], answer: 1, explain: { en: '!' } }];
    const events = [
      startedEvent({ id: 'a1', item: 'x.y.z-01', mode: 'review' }, 7, 1000),
      ...resultEvents('a1', { action: 'check', report: report(false) }, 1001, false),
      ...resultEvents('a1', { action: 'check', report: report(true), step: 3 }, 1002, false),
      ...resultEvents('a1', { action: 'hint', hint: { index: 0, text: { en: 'h' } } }, 1003, false),
      ...resultEvents('a1', { action: 'solutions', solutions: [] }, 1004, true),
      noteEvent('a1', { kind: 'confidence', value: 4 }, 1005),
      noteEvent('a1', { kind: 'explanation', text: ' the taint ' }, 1006),
      noteEvent('a1', { kind: 'prediction', step: 0, choice: 1 }, 1007, steps),
      noteEvent('a1', { kind: 'prediction', step: 0, text: 'it comes back' }, 1008, steps),
    ];
    for (const e of events) expect(eventProblem(e)).toBeUndefined();
    expect(events.map((e) => e?.type)).toEqual(['attempt.started', 'attempt.check', 'attempt.check', 'attempt.hint', 'attempt.solution', 'attempt.confidence', 'attempt.explanation', 'attempt.prediction', 'attempt.prediction']);
    expect(events[2]).toMatchObject({ step: 3, passed: true, checks: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'pass' }] });
    expect(events[6]).toMatchObject({ text: 'the taint' });
    expect(events[7]).toMatchObject({ choice: 1, correct: true });
  });

  it('the answer seen after passing is study, not help; an empty explanation and a hint that does not exist record nothing', () => {
    expect(resultEvents('a1', { action: 'solutions', solutions: [] }, 1, false)).toEqual([]);
    expect(resultEvents('a1', { action: 'debrief', blocks: [], history: [], solutions: [] }, 1, true).map((e) => e.type)).toEqual(['attempt.solution']);
    expect(resultEvents('a1', { action: 'hint' }, 1, false)).toEqual([]);
    expect(noteEvent('a1', { kind: 'explanation', text: '  ' }, 1)).toBeUndefined();
  });

  it('leaving: failed once the answer was seen, abandoned when skipped, open otherwise', () => {
    expect(leaveOutcome(true, 'away')).toBe('failed');
    expect(leaveOutcome(true, 'skip')).toBe('failed');
    expect(leaveOutcome(false, 'skip')).toBe('abandoned');
    expect(leaveOutcome(false, 'away')).toBeUndefined();
  });

  it('a lesson is done when each task passed and each prediction is answered', () => {
    const steps: LessonStep[] = [{ kind: 'text', text: { en: 't' } }, { kind: 'predict', prompt: { en: '?' }, explain: { en: '!' } }, { kind: 'task', text: { en: 'do' }, hintCount: 0 }];
    expect(lessonDone(steps, { 2: { passed: true } }, {})).toBe(false);
    expect(lessonDone(steps, { 2: { passed: false } }, { 1: {} })).toBe(false);
    expect(lessonDone(steps, { 2: { passed: true } }, { 1: {} })).toBe(true);
  });

  it('the next review in the learner\'s days', () => {
    const settings = { utcOffsetMinutes: 420, dayStartHour: 4 };
    const now = Date.UTC(2026, 10, 17, 3, 0); // 10:00 in UTC+7
    expect(nextReview({ dueAt: now + 86_400_000 }, settings, now)).toEqual({ days: 1, text: 'tomorrow', date: '18 Nov' });
    expect(nextReview({ dueAt: now + 5 * 86_400_000 }, settings, now)).toMatchObject({ days: 5, text: 'in 5 days', date: '22 Nov' });
    expect(nextReview({ dueAt: now - 86_400_000 }, settings, now).text).toBe('today');
  });
});
