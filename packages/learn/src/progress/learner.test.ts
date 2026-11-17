// The exit criteria of phase 11 on a simulated learner (docs/LEARNING_MODEL.md §11): ninety days
// of daily sessions against the demonstration pack.

import { describe, expect, test } from 'vitest';
import { catalogProblems, prerequisitesOf, type ItemMeta } from '../pack.ts';
import { DAY_MS, dayIndex } from './day.ts';
import { AGAIN, GOOD, parseLog } from './events.ts';
import { initialState, replay } from './reducer.ts';
import { demoCatalog, demoPack, simulateLearner, STEADY_LEARNER } from './simulate.ts';
import { domainStats, metSkills, skillStats, streak } from './stats.ts';

const START = Date.UTC(2026, 10, 17, 9, 0, 0);
const catalog = demoCatalog();
/** The daily time box, in minutes. */
const BOX = 20;
const run = (seed: number, extra: Partial<Parameters<typeof simulateLearner>[1]> = {}) =>
  simulateLearner(catalog, { days: 90, seed, start: START, track: 'demo.track.all', dailyMinutes: BOX, profile: { ...STEADY_LEARNER, passReview: 0.8, skip: [30, 31, 32, 60] }, ...extra });
const sim = run(7);

test('the demonstration pack is a valid pack', () => {
  expect(catalogProblems([demoPack()])).toEqual([]);
});

describe('ninety days of daily sessions', () => {
  test('the learner works through the track and keeps reviewing', () => {
    const attempted = Object.keys(sim.live.items).length;
    expect(attempted).toBe(Object.keys(catalog.items).length);
    expect(sim.reviews.filter((r) => r.before).length).toBeGreaterThan(300);
    expect(sim.sessions.length).toBe(86);
    expect(sim.log.length).toBeGreaterThan(1000);
  });

  test('intervals grow after successes and shrink after failures', () => {
    const repeats = sim.reviews.filter((r) => r.before);
    const good = repeats.filter((r) => r.rating >= GOOD);
    const again = repeats.filter((r) => r.rating === AGAIN);
    expect(good.length).toBeGreaterThan(150);
    expect(again.length).toBeGreaterThan(40);
    for (const r of good) {
      // What FSRS asks for grows with every success; the interval in force never shrinks, and
      // grows too once it is past the one-day floor a failure leaves an item on.
      expect(r.after.memory.scheduledDays, `${r.item} day ${r.day}`).toBeGreaterThan(r.before?.memory.scheduledDays as number);
      expect(r.after.intervalDays).toBeGreaterThanOrEqual(r.before?.intervalDays as number);
      if (r.after.memory.scheduledDays > 1) expect(r.after.intervalDays).toBeGreaterThan(r.before?.intervalDays as number);
    }
    expect(good.filter((r) => r.after.intervalDays > (r.before?.intervalDays as number)).length).toBeGreaterThan(100);
    for (const r of again) {
      const was = r.before?.intervalDays as number;
      // The floor is one day: an interval already there cannot shrink.
      if (was > 1) expect(r.after.intervalDays, `${r.item} day ${r.day}`).toBeLessThan(was);
      else expect(r.after.intervalDays).toBe(1);
    }
    // A failure costs more than one step: stability drops below what the item had before.
    for (const r of again) expect(r.after.memory.stability).toBeLessThan(r.before?.memory.stability as number);
  });

  test('every queue fits what is left of the time box', () => {
    for (const s of sim.sessions) {
      s.queues.forEach(({ queue, state }, i) => {
        const spent = (state.days[String(queue.day)]?.activeMs ?? 0) / 60_000;
        expect(queue.minutesLeft).toBeCloseTo(Math.max(0, BOX - spent), 9);
        if (queue.minutesLeft === 0) expect(queue.entries).toEqual([]);
        // The one exception: the first item of a day is offered even when it alone is longer.
        if (i === 0 && queue.entries.length === 1) return;
        expect(queue.minutes, `day ${s.day}, queue ${i}`).toBeLessThanOrEqual(queue.minutesLeft + 1e-9);
      });
      // The learner stops when the box is spent: every item was started with time left.
      for (const { queue, state } of s.queues.filter((q) => q.queue.entries.length > 0)) expect((state.days[String(queue.day)]?.activeMs ?? 0) / 60_000).toBeLessThan(BOX);
      expect(s.queues[s.queues.length - 1]?.queue.entries).toEqual([]);
    }
  });

  test('no two consecutive items share a primary skill while another choice exists', () => {
    let pairs = 0;
    let forced = 0;
    for (const s of sim.sessions) {
      for (const { queue, state } of s.queues) {
        const last = state.lastFinished && dayIndex(state.lastFinished.at, state.settings) === queue.day ? catalog.items[state.lastFinished.item]?.skills[0] : undefined;
        queue.entries.forEach((e, i) => {
          const previous = i === 0 ? last : queue.entries[i - 1]?.skill;
          if (previous === undefined) return;
          pairs++;
          if (e.skill !== previous) {
            expect(e.repeatsSkill).toBe(false);
            return;
          }
          forced++;
          expect(e.repeatsSkill, `day ${s.day}: ${e.item} repeats ${e.skill}`).toBe(true);
          // Forced: everything from here on has the same primary skill.
          expect(queue.entries.slice(i).every((x) => x.skill === previous)).toBe(true);
        });
      }
      // What the learner did, in order, obeys the same rule.
      s.done.forEach((e, i) => {
        if (i > 0 && e.skill === s.done[i - 1]?.skill) expect(e.repeatsSkill).toBe(true);
      });
    }
    expect(pairs).toBeGreaterThan(500);
    // Mostly at the start, when one skill is all there is.
    expect(forced / pairs).toBeLessThan(0.15);
  });

  test('due reviews come before new items in the choice, and reviews with recent mistakes first', () => {
    for (const s of sim.sessions) {
      for (const { queue } of s.queues) {
        // New material is offered only when every due review that fits was taken: none waits while a new item is in.
        if (queue.entries.some((e) => e.reason === 'new') && queue.waiting.reviews > 0) {
          const left = queue.minutesLeft - queue.entries.filter((e) => e.reason === 'review').reduce((n, e) => n + e.minutes, 0);
          // A review waits only because it does not fit: the longest item is 15 minutes.
          expect(left).toBeLessThan(15);
        }
      }
    }
    const withMistakes = sim.sessions.flatMap((s) => s.queues).filter(({ queue }) => queue.entries.some((e) => e.mistakes > 0) && queue.entries.filter((e) => e.reason === 'review').length > 2);
    expect(withMistakes.length).toBeGreaterThan(5);
  });

  test('prerequisites gate new items', () => {
    let gated = 0;
    for (const s of sim.sessions) {
      for (const { queue, state } of s.queues) {
        const met = metSkills(state, catalog);
        for (const e of queue.entries.filter((x) => x.reason === 'new')) {
          for (const need of prerequisitesOf(catalog.items[e.item] as ItemMeta, catalog)) expect(met.has(need), `day ${s.day}: ${e.item} needs ${need}`).toBe(true);
        }
        // Time was left and the track had items, yet they were held back.
        const track = catalog.tracks['demo.track.all']?.items ?? [];
        const held = track.filter((id) => !state.items[id] && prerequisitesOf(catalog.items[id] as ItemMeta, catalog).some((n) => !met.has(n)));
        if (held.length > 0) gated++;
      }
    }
    expect(gated).toBeGreaterThan(10);
    // On day 0 nothing past the first skill is offered: `objects` requires `basics`.
    const first = sim.sessions[0]?.queues[0]?.queue.entries ?? [];
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((e) => e.skill === 'demo.basics')).toBe(true);
    // The order in which skills were first practiced respects the chain.
    const firstDay = (skill: string): number => Math.min(...sim.sessions.filter((s) => s.done.some((e) => e.skill === skill)).map((s) => s.day));
    expect(firstDay('demo.basics')).toBeLessThanOrEqual(firstDay('demo.objects'));
    expect(firstDay('demo.objects')).toBeLessThanOrEqual(firstDay('demo.changes'));
    expect(firstDay('demo.traffic')).toBeLessThanOrEqual(firstDay('demo.repair'));
  });

  test('state rebuilt from the log equals the live state', () => {
    expect(replay(sim.log)).toEqual(sim.live);
    // Through the file format: one JSON object per line.
    const text = sim.log.map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(replay(parseLog(text))).toEqual(sim.live);
    expect(JSON.parse(JSON.stringify(sim.live))).toEqual(sim.live);
  });

  test('a replay can resume from a saved state', () => {
    const half = Math.floor(sim.log.length / 2);
    const saved = JSON.parse(JSON.stringify(replay(sim.log.slice(0, half)))) as ReturnType<typeof initialState>;
    expect(replay(sim.log.slice(half), saved)).toEqual(sim.live);
  });

  test('the same seed gives the same log; another seed a different one', () => {
    expect(run(7).log).toEqual(sim.log);
    expect(run(8).log).not.toEqual(sim.log);
  });

  test('a new variant seed on every review', () => {
    const seeds = new Map<string, number[]>();
    for (const e of sim.log) if (e.type === 'attempt.started' || e.type === 'card.reviewed') seeds.set(e.item, [...(seeds.get(e.item) ?? []), e.seed]);
    const repeated = [...seeds.values()].filter((s) => s.length > 2);
    expect(repeated.length).toBeGreaterThan(10);
    for (const s of repeated) expect(new Set(s).size).toBe(s.length);
  });

  test('missed days leave reviews overdue, and the queue takes the most forgotten first', () => {
    const after = sim.sessions.find((s) => s.day === 33)?.queues[0]?.queue;
    expect(after?.entries.some((e) => (e.overdueDays ?? 0) > 0)).toBe(true);
    const reviews = (after?.entries ?? []).filter((e) => e.reason === 'review');
    expect(reviews.length).toBeGreaterThan(1);
  });

  test('statistics follow: streaks, skills, domains', () => {
    const st = streak(sim.live, sim.end);
    // Sessions on days 0 to 29, 33 to 59 and 61 to 89.
    expect(sim.sessions.every((s) => s.done.length > 0)).toBe(true);
    expect(st).toEqual({ current: 29, longest: 30, today: true });
    expect(streak(sim.live, sim.end + DAY_MS)).toEqual({ current: 29, longest: 30, today: false });
    expect(streak(sim.live, sim.end + 2 * DAY_MS).current).toBe(0);
    const skills = skillStats(sim.live, catalog, sim.end);
    expect(skills.map((s) => s.skill)).toEqual(Object.keys(catalog.skills).sort());
    for (const s of skills) {
      expect(s.attempted).toBe(s.items);
      expect(s.mastery).toBeGreaterThan(0.5);
      expect(s.mastery).toBeLessThanOrEqual(1);
      expect(s.status === 'mastered' || s.status === 'learning').toBe(true);
    }
    expect(skills.some((s) => s.mistakes > 0)).toBe(true);
    const domains = domainStats(sim.live, catalog, sim.end);
    expect(domains.map((d) => d.domain)).toEqual(['demo.build', 'demo.operate']);
    for (const d of domains) {
      expect(d.attempted).toBe(d.items);
      expect(d.passRate).toBeGreaterThan(0.7);
      expect(d.passRate).toBeLessThan(1);
    }
    // Nothing is known about a learner who has not started.
    const fresh = skillStats(initialState(), catalog, START);
    expect(Object.fromEntries(fresh.map((s) => [s.skill, s.status]))).toMatchObject({ 'demo.basics': 'new', 'demo.objects': 'locked', 'demo.recovery': 'locked' });
    expect(fresh.every((s) => s.mastery === 0 && s.attempted === 0)).toBe(true);
  });
});

