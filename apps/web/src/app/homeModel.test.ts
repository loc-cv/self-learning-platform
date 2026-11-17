import { describe, expect, it } from 'vitest';
import { buildQueue, dayIndex, DAY_MS, demoCatalog, domainStats, initialState, simulateLearner, skillStats, streak, type ProgressState } from '@simlab/learn';
import type { CurriculumExam } from 'virtual:simlab/content';
import { activity, ago, dayDate, examGroups, forecast, formatMinutes, isFirstRun, itemCards, matches, mistakeKinds, mistakeRows, NO_FILTERS, sessionMode, sessionPlan, skillRows } from './homeModel.ts';

const START = Date.UTC(2026, 9, 1, 9, 0);
const catalog = demoCatalog();
const sim = simulateLearner(catalog, { days: 30, seed: 7, start: START, track: 'demo.track.all' });
const state = sim.live;
// The morning after the last simulated session: a new day with its queue.
const now = START + 30 * DAY_MS;
const session = { day: dayIndex(now, state.settings), running: false, skipped: [], done: [] };

const CURRICULUM: CurriculumExam[] = [
  {
    id: 'demo',
    title: 'Demo exam',
    domains: [
      { id: 'demo.build', title: 'Build', weight: 60, competencies: [] },
      { id: 'demo.operate', title: 'Operate', weight: 30, competencies: [] },
      { id: 'demo.empty', title: 'Nothing here yet', weight: 10, competencies: [] },
    ],
  },
];

describe('formatting', () => {
  it('says minutes, seconds for a card, hours past sixty', () => {
    expect([formatMinutes(0.5), formatMinutes(8), formatMinutes(60), formatMinutes(65)]).toEqual(['30 s', '8 min', '1 h', '1 h 5 min']);
  });
  it('reads a learner day as its local date', () => {
    // 1970-01-01 was a Thursday.
    expect(dayDate(0).long).toBe('Thu 1 Jan');
    expect(dayDate(dayIndex(Date.UTC(2026, 10, 17, 12), initialState().settings)).long).toBe('Tue 17 Nov');
  });
  it('says how long ago', () => {
    expect([ago(0, 30_000), ago(0, 5 * 60_000), ago(0, 3 * 3_600_000), ago(0, 25 * 3_600_000), ago(0, 3 * DAY_MS)]).toEqual(['just now', '5 min ago', '3 h ago', 'yesterday', '3 days ago']);
  });
});

describe('the session', () => {
  const queue = buildQueue(state, catalog, now);

  it('lays the entries end to end after what was spent, on a scale of at least the box', () => {
    const plan = sessionPlan(state, catalog, queue);
    expect(plan.entries.map((e) => e.item)).toEqual(queue.entries.map((e) => e.item));
    expect(plan.scale).toBeGreaterThanOrEqual(plan.box);
    let at = plan.spent / plan.scale;
    for (const e of plan.entries) {
      expect(e.from).toBeCloseTo(at);
      at = e.to;
    }
    expect(at).toBeLessThanOrEqual(1 + 1e-9);
    expect(plan.reviews + plan.fresh).toBe(queue.entries.length);
  });

  it('says what did not fit, and only then', () => {
    const plan = sessionPlan(state, catalog, { ...queue, waiting: { reviews: 2, fresh: 1 } });
    expect(plan.waiting).toBe("2 more reviews and 1 new item did not fit today's 30 minutes. Reviews stay due and come first tomorrow.");
    expect(sessionPlan(state, catalog, { ...queue, waiting: { reviews: 0, fresh: 0 } }).waiting).toBeUndefined();
  });

  it('starts, continues, is done or idle', () => {
    const empty = { ...queue, entries: [], minutes: 0 };
    expect(sessionMode(state, queue, session)).toBe('start');
    expect(sessionMode(state, queue, { ...session, running: true })).toBe('continue');
    expect(sessionMode(state, empty, { ...session, done: [{ item: 'x', outcome: 'passed' }] })).toBe('done');
    expect(sessionMode(initialState(), { ...empty, day: 1 }, session)).toBe('idle');
  });

  it('a first run is a log with no attempt', () => {
    expect(isFirstRun(initialState())).toBe(true);
    expect(isFirstRun(state)).toBe(false);
  });
});

describe('the forecast', () => {
  it('counts every scheduled item once, overdue ones on today', () => {
    const days = forecast(state, catalog, now, 400);
    const scheduled = Object.values(state.items).filter((p) => p.schedule).length;
    expect(days.reduce((n, d) => n + d.count, 0)).toBe(scheduled);
    const today = days[0];
    // What is due today is what the queue sees as due: taken and waiting.
    const q = buildQueue(state, catalog, now);
    expect(today?.count).toBe(q.entries.filter((e) => e.reason === 'review').length + q.waiting.reviews);
    expect(days.slice(1).every((d) => d.overdue === 0)).toBe(true);
  });

  it('is empty for an empty log', () => {
    expect(forecast(initialState(), catalog, now).every((d) => d.count === 0)).toBe(true);
  });
});

describe('activity', () => {
  it('has one cell per day ending today, with the log totals', () => {
    const cells = activity(state, now);
    expect(cells).toHaveLength(28);
    expect(cells.at(-1)?.day).toBe(dayIndex(now, state.settings));
    for (const c of cells) {
      const d = state.days[String(c.day)];
      expect(c.attempts).toBe(d?.attempts ?? 0);
      expect(c.level === 0).toBe(c.attempts === 0);
    }
    // Today has nothing yet, so the streak runs to yesterday, and the cells agree with it.
    const run = streak(state, now).current;
    expect(cells.slice(-1 - Math.min(run, 27), -1).every((c) => c.attempts > 0)).toBe(true);
  });

  it('grades a day by the share of the time box', () => {
    const s: ProgressState = { ...initialState(), days: { '10': { attempts: 1, passes: 1, activeMs: 30 * 60_000 }, '9': { attempts: 1, passes: 0, activeMs: 5 * 60_000 }, '8': { attempts: 1, passes: 0, activeMs: 12 * 60_000 } } };
    const cells = activity(s, 10 * DAY_MS + 5 * 3_600_000, 4);
    expect(cells.map((c) => c.level)).toEqual([0, 2, 1, 4]);
  });
});

describe('mastery', () => {
  it('keeps the pack order of skills and the numbers of skillStats', () => {
    const rows = skillRows(state, catalog, now);
    expect(rows.map((r) => r.skill)).toEqual(Object.keys(catalog.skills));
    const stats = new Map(skillStats(state, catalog, now).map((s) => [s.skill, s]));
    for (const r of rows) expect(r.mastery).toBe(stats.get(r.skill)?.mastery);
  });

  it('names what a locked skill waits for', () => {
    const rows = skillRows(initialState(), catalog, now);
    expect(rows.find((r) => r.skill === 'demo.repair')?.needs).toEqual(['Skill health', 'Skill traffic']);
    expect(rows.find((r) => r.skill === 'demo.basics')?.status).toBe('new');
  });

  it('groups domains by exam, heaviest first, and weights mastery by the shares', () => {
    const [group, ...rest] = examGroups(state, catalog, now, CURRICULUM);
    expect(rest).toEqual([]);
    expect(group?.domains.map((d) => d.domain)).toEqual(['demo.build', 'demo.operate', 'demo.empty']);
    const stats = new Map(domainStats(state, catalog, now).map((d) => [d.domain, d.mastery]));
    const expected = (60 * (stats.get('demo.build') ?? 0) + 30 * (stats.get('demo.operate') ?? 0)) / 100;
    expect(group?.weighted).toBeCloseTo(expected);
    expect(group?.domains[2]?.items).toBe(0);
  });

  it('puts domains no curriculum lists in a group of their own', () => {
    const groups = examGroups(state, catalog, now, []);
    expect(groups.map((g) => g.exam)).toEqual(['other']);
    expect(groups[0]?.weighted).toBeUndefined();
  });
});

describe('mistakes', () => {
  it('lists items with recent mistakes, most first', () => {
    const rows = mistakeRows(state, catalog, now);
    for (let i = 1; i < rows.length; i++) expect((rows[i - 1]?.recent ?? 0) >= (rows[i]?.recent ?? 0)).toBe(true);
    expect(rows.every((r) => r.recent > 0)).toBe(true);
  });

  it('says the kinds that have a count', () => {
    expect(mistakeKinds({ failures: 1, failedChecks: 2, hints: 0, solutions: 1 })).toBe('1 failed attempt · 2 failed checks · 1 solution viewed');
  });
});

describe('the content browser', () => {
  it('has a card for every item with its status in words', () => {
    const cards = itemCards(state, catalog, now, [{ item: 'demo.basics.lab-01', attempt: 'a1' }]);
    expect(cards).toHaveLength(Object.keys(catalog.items).length);
    expect(cards.find((c) => c.item === 'demo.basics.lab-01')?.attempt).toBe('a1');
    for (const c of cards) {
      if (c.status === 'new') expect(c.detail).toBe('new');
      if (c.status === 'due') expect(c.detail).toMatch(/^due/);
      if (c.status === 'learning') expect(c.detail).toMatch(/^learning, next (tomorrow|in \d+ days)$/);
      expect(c.tracks).toEqual(['demo.track.all']);
    }
  });

  it('filters by every facet at once', () => {
    const cards = itemCards(state, catalog, now, []);
    expect(cards.filter((c) => matches(c, NO_FILTERS))).toHaveLength(cards.length);
    const labs = cards.filter((c) => matches(c, { ...NO_FILTERS, kind: 'lab', skill: 'demo.health' }));
    expect(labs.map((c) => c.item)).toEqual(['demo.health.lab-01']);
    expect(cards.filter((c) => matches(c, { ...NO_FILTERS, domain: 'demo.operate', kind: 'lesson' })).length).toBe(4);
    expect(cards.filter((c) => matches(c, { ...NO_FILTERS, track: 'nope' }))).toEqual([]);
  });
});
