// A simulated learner (docs/LEARNING_MODEL.md §11): daily sessions over a catalog, driven by a
// seeded PRNG, producing a real progress log. It is how the learning layer is tested over months
// in milliseconds, and how the interface gets a believable history to show before a human has
// one. Nothing here touches a world: the learner's performance is drawn, not played.

import { initialPrngState, randomOver, type Random } from '@simlab/kernel';
import { buildCatalog, type Catalog, type ItemMeta, type PackContent } from '../pack.ts';
import type { AnyItem } from '../item/types.ts';
import { DAY_MS } from './day.ts';
import { PROGRESS_VERSION, type ProgressEvent } from './events.ts';
import { buildQueue, type Queue, type QueueEntry } from './queue.ts';
import { cardReview, finishAttempt } from './record.ts';
import { applyEvent, initialState, type ProgressState, type Schedule } from './reducer.ts';

export interface LearnerProfile {
  /** Chance of passing a new item, and of passing a review. Lessons always pass. */
  passNew: number;
  passReview: number;
  /** Chance of taking a hint, and of opening the X-ray, in an attempt that passes. */
  hint: number;
  xray: number;
  /** Time spent as a share of the target, drawn uniformly between these. */
  pace: [number, number];
  /** Days (from 0) on which the learner does nothing. */
  skip?: readonly number[];
}

export const STEADY_LEARNER: LearnerProfile = { passNew: 0.85, passReview: 0.88, hint: 0.2, xray: 0.1, pace: [0.4, 1.3] };

export interface SimulatedReview {
  day: number;
  item: string;
  rating: number;
  before?: Schedule;
  after: Schedule;
}

export interface SimulatedSession {
  day: number;
  /** The queue as built at the start of the day, and every queue built after an item was finished. */
  queues: { queue: Queue; state: ProgressState }[];
  done: QueueEntry[];
}

export interface Simulation {
  log: ProgressEvent[];
  /** The state kept up to date event by event while the log was written. */
  live: ProgressState;
  sessions: SimulatedSession[];
  reviews: SimulatedReview[];
  /** The time of the last event. */
  end: number;
}

export interface SimulateOptions {
  days: number;
  seed: number;
  /** The first session's time, milliseconds since the epoch; later sessions are whole days after it. */
  start: number;
  track: string;
  dailyMinutes?: number;
  profile?: LearnerProfile;
  /** How many hints a ladder has, per kind; default 3, 1 for a drill, 0 for a card. */
  hintCount?: (meta: ItemMeta) => number;
}

const defaultHints = (meta: ItemMeta): number => (meta.kind === 'drill' ? 1 : meta.kind === 'card' ? 0 : 3);

export function simulateLearner(catalog: Catalog, options: SimulateOptions): Simulation {
  const profile = options.profile ?? STEADY_LEARNER;
  const random: Random = randomOver(initialPrngState(options.seed, 'learn.simulate'));
  const log: ProgressEvent[] = [];
  let live = initialState();
  const record = (events: readonly ProgressEvent[]): void => {
    for (const e of events) {
      log.push(e);
      live = applyEvent(live, e);
    }
  };
  record([{ v: PROGRESS_VERSION, type: 'settings.changed', at: options.start, settings: { activeTrack: options.track, ...(options.dailyMinutes !== undefined ? { dailyMinutes: options.dailyMinutes } : {}) } }]);
  const sessions: SimulatedSession[] = [];
  const reviews: SimulatedReview[] = [];
  let attempts = 0;
  let now = options.start;
  for (let day = 0; day < options.days; day++) {
    if (profile.skip?.includes(day)) continue;
    now = options.start + day * DAY_MS;
    const session: SimulatedSession = { day, queues: [], done: [] };
    sessions.push(session);
    // The cap only guards the loop: a day never holds more items than fit its minutes.
    for (let n = 0; n < 500; n++) {
      const queue = buildQueue(live, catalog, now);
      session.queues.push({ queue, state: live });
      const entry = queue.entries[0];
      if (!entry) break;
      const meta = catalog.items[entry.item] as ItemMeta;
      const attempt = `sim-${++attempts}`;
      const passed = meta.kind === 'lesson' || random.float() < (entry.reason === 'new' ? profile.passNew : profile.passReview);
      const activeMs = Math.round(meta.targetMinutes * 60_000 * (profile.pace[0] + random.float() * (profile.pace[1] - profile.pace[0])));
      const before = live.items[entry.item]?.schedule;
      if (meta.kind === 'card') {
        record(cardReview({ attempt, item: entry.item, seed: entry.seed, at: now + activeMs, activeMs, correct: passed }));
      } else {
        const at = (share: number): number => now + Math.round(activeMs * share);
        record([{ v: PROGRESS_VERSION, type: 'attempt.started', at: now, attempt, item: entry.item, seed: entry.seed, mode: entry.reason }]);
        if (random.float() < profile.xray) record([{ v: PROGRESS_VERSION, type: 'attempt.xray', at: at(0.2), attempt, open: true }]);
        const hints = defaultHints(meta);
        if (hints > 0 && random.float() < profile.hint) record([{ v: PROGRESS_VERSION, type: 'attempt.hint', at: at(0.4), attempt, index: 0 }]);
        if (!passed || random.float() < 0.3) record([{ v: PROGRESS_VERSION, type: 'attempt.check', at: at(0.7), attempt, passed: false, score: 0, checks: [{ id: 'done', status: 'fail' }] }]);
        if (passed) record([{ v: PROGRESS_VERSION, type: 'attempt.check', at: at(1), attempt, passed: true, score: 1, checks: [{ id: 'done', status: 'pass' }] }]);
        record(finishAttempt(live, meta, { attempt, at: at(1), outcome: passed ? 'passed' : 'failed', activeMs, hintCount: (options.hintCount ?? defaultHints)(meta) }));
      }
      now += activeMs;
      session.done.push(entry);
      const after = live.items[entry.item]?.schedule;
      if (after && after !== before) reviews.push(before ? { day, item: entry.item, rating: after.rating, before, after } : { day, item: entry.item, rating: after.rating, after });
    }
  }
  return { log, live, sessions, reviews, end: now };
}

/**
 * A pack for tests and demonstrations: ten skills in a graph of prerequisites, and per skill a
 * lesson, a drill, a card and a lab, plus three incidents across skills.
 * Metadata only; the items have no worlds.
 */
export function demoPack(): PackContent {
  const skills = ['basics', 'objects', 'changes', 'health', 'traffic', 'repair', 'storage', 'access', 'capacity', 'recovery'];
  const requires: Record<string, string[]> = {
    objects: ['basics'],
    changes: ['objects'],
    health: ['objects'],
    traffic: ['changes'],
    repair: ['health', 'traffic'],
    storage: ['objects'],
    access: ['basics'],
    capacity: ['health'],
    recovery: ['storage', 'repair'],
  };
  const operate = ['health', 'repair', 'capacity', 'recovery'];
  const id = (s: string): string => `demo.${s}`;
  const items: AnyItem[] = [];
  const header = (name: string, skill: string, minutes: number, difficulty: number, extra: string[] = []) => ({
    id: `demo.${skill}.${name}-01`,
    title: `${name} on ${skill}`,
    skills: [id(skill), ...extra.map(id)],
    curriculum: [`demo.${operate.includes(skill) ? 'operate' : 'build'}.${skill}`],
    difficulty,
    targetMinutes: minutes,
  });
  for (const s of skills) {
    items.push({ ...header('lesson', s, 6, 1), kind: 'lesson' } as unknown as AnyItem);
    items.push({ ...header('drill', s, 2, 1), kind: 'drill' } as unknown as AnyItem);
    items.push({ ...header('card', s, 0.5, 1), kind: 'card' } as unknown as AnyItem);
    items.push({ ...header('lab', s, 8, 2), kind: 'lab' } as unknown as AnyItem);
  }
  items.push({ ...header('incident', 'repair', 15, 4, ['traffic']), kind: 'incident' } as unknown as AnyItem);
  items.push({ ...header('outage', 'health', 12, 3, ['changes']), kind: 'incident' } as unknown as AnyItem);
  items.push({ ...header('restore', 'recovery', 14, 4, ['storage']), kind: 'incident' } as unknown as AnyItem);
  return {
    pack: {
      id: 'demo',
      title: 'Demonstration pack',
      skills: skills.map((s) => ({ id: id(s), title: `Skill ${s}`, ...(requires[s] ? { requires: (requires[s] as string[]).map(id) } : {}) })),
      tracks: [{ id: 'demo.track.all', title: 'Everything, in order', items: items.map((i) => i.id) }],
    },
    items,
  };
}

export const demoCatalog = (): Catalog => buildCatalog([demoPack()]);
