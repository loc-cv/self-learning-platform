// The daily queue (docs/LEARNING_MODEL.md §8): what to practice now. Due reviews first, then new
// items from the active track whose prerequisites are met; fitted to what is left of the day's
// time box by target times; ordered so that two items with the same primary skill are not back to
// back while another choice exists. A pure function of the progress state, the catalog and now:
// it is rebuilt after every finished item.

import type { AnyItem } from '../item/types.ts';
import { isScheduled, prerequisitesOf, type Catalog, type ItemMeta } from '../pack.ts';
import { dayIndex } from './day.ts';
import type { ProgressState } from './reducer.ts';
import { attemptSeed, reviewSeed } from './seeds.ts';
import { itemRecall, metSkills, recentMistakes } from './stats.ts';

export interface QueueEntry {
  item: string;
  kind: ItemMeta['kind'];
  reason: 'review' | 'new';
  /** The variant to present: a new one on every review. */
  seed: number;
  /** The item's target time. */
  minutes: number;
  /** The primary skill: what interleaving compares. */
  skill: string;
  /** Recent mistakes on the item's skills; reviews with more come first. */
  mistakes: number;
  /** For a review: the estimated recall now and the days past due (0 on the day it is due). */
  recall?: number;
  overdueDays?: number;
  /** The entry follows one with the same primary skill because nothing else was left to choose. */
  repeatsSkill: boolean;
}

export interface Queue {
  /** The learner's day the queue is for. */
  day: number;
  /** Minutes of the time box not yet spent today, and the sum of the entries' target times. */
  minutesLeft: number;
  minutes: number;
  entries: QueueEntry[];
  /** Due reviews and available new items that did not fit today. */
  waiting: { reviews: number; fresh: number };
}

export interface QueueOptions {
  /** The items themselves, by id: with them a review's seed avoids the last variant's parameters. */
  items?: Readonly<Record<string, AnyItem>>;
}

type Candidate = Omit<QueueEntry, 'repeatsSkill'>;

/** Due reviews, most urgent first: recent mistakes on the item's skills, then the lowest recall. */
export function dueReviews(state: ProgressState, catalog: Catalog, now: number): Candidate[] {
  const today = dayIndex(now, state.settings);
  const skillMistakes = new Map<string, number>();
  for (const id of Object.keys(catalog.items).sort()) {
    const n = recentMistakes(state.items[id], today);
    if (n > 0) for (const s of (catalog.items[id] as ItemMeta).skills) skillMistakes.set(s, (skillMistakes.get(s) ?? 0) + n);
  }
  const out: Candidate[] = [];
  for (const id of Object.keys(state.items).sort()) {
    const meta = catalog.items[id];
    const p = state.items[id];
    if (!meta || !p?.schedule || !isScheduled(meta.kind)) continue;
    const dueDay = dayIndex(p.schedule.dueAt, state.settings);
    if (dueDay > today) continue;
    out.push({
      item: id,
      kind: meta.kind,
      reason: 'review',
      seed: 0,
      minutes: meta.targetMinutes,
      skill: meta.skills[0] as string,
      mistakes: Math.max(0, ...meta.skills.map((s) => skillMistakes.get(s) ?? 0)),
      recall: itemRecall(p, now),
      overdueDays: today - dueDay,
    });
  }
  return out.sort((a, b) => b.mistakes - a.mistakes || (a.recall as number) - (b.recall as number) || (a.item < b.item ? -1 : 1));
}

/** New items of the active track, in track order: never rated, not a finished lesson, prerequisites met. */
export function availableNew(state: ProgressState, catalog: Catalog): Candidate[] {
  const track = state.settings.activeTrack === undefined ? undefined : catalog.tracks[state.settings.activeTrack];
  if (!track) return [];
  const met = metSkills(state, catalog);
  const out: Candidate[] = [];
  for (const id of track.items) {
    const meta = catalog.items[id];
    if (!meta) continue;
    const p = state.items[id];
    if (p?.schedule || (!isScheduled(meta.kind) && (p?.passes ?? 0) > 0)) continue;
    if (prerequisitesOf(meta, catalog).some((s) => !met.has(s))) continue;
    out.push({ item: id, kind: meta.kind, reason: 'new', seed: 0, minutes: meta.targetMinutes, skill: meta.skills[0] as string, mistakes: 0 });
  }
  return out;
}

export function buildQueue(state: ProgressState, catalog: Catalog, now: number, options: QueueOptions = {}): Queue {
  const day = dayIndex(now, state.settings);
  const spent = (state.days[String(day)]?.activeMs ?? 0) / 60_000;
  const minutesLeft = Math.max(0, state.settings.dailyMinutes - spent);
  const reviews = dueReviews(state, catalog, now);
  const fresh = availableNew(state, catalog);

  // Selection: reviews by urgency, skipping one that does not fit so a shorter one can; then new
  // items in track order, stopping at the first that does not fit, so the track is never skipped
  // ahead. A day with nothing done yet always gets its first candidate, however long it is.
  const chosen: Candidate[] = [];
  let left = minutesLeft;
  for (const c of reviews) {
    if (c.minutes > left) continue;
    chosen.push(c);
    left -= c.minutes;
  }
  for (const c of fresh) {
    if (c.minutes > left) break;
    chosen.push(c);
    left -= c.minutes;
  }
  const first = reviews[0] ?? fresh[0];
  if (chosen.length === 0 && first && spent === 0) chosen.push(first);

  // Order: always the most urgent entry left whose primary skill differs from the one before it;
  // when every entry left has that skill, the most urgent of them, marked.
  const entries: QueueEntry[] = [];
  const rest = [...chosen];
  let previous = state.lastFinished && dayIndex(state.lastFinished.at, state.settings) === day ? catalog.items[state.lastFinished.item]?.skills[0] : undefined;
  while (rest.length > 0) {
    const other = rest.findIndex((c) => c.skill !== previous);
    const [next] = rest.splice(other === -1 ? 0 : other, 1) as [Candidate];
    entries.push({ ...next, seed: seedFor(next.item, state, options), repeatsSkill: other === -1 && previous !== undefined });
    previous = next.skill;
  }
  const count = (reason: 'review' | 'new'): number => chosen.filter((c) => c.reason === reason).length;
  return { day, minutesLeft, minutes: entries.reduce((n, e) => n + e.minutes, 0), entries, waiting: { reviews: reviews.length - count('review'), fresh: fresh.length - count('new') } };
}

/** The seed of an item's next attempt (seeds.ts). */
export function seedFor(id: string, state: ProgressState, options: QueueOptions = {}): number {
  const p = state.items[id];
  const item = options.items?.[id];
  const attempts = p?.attempts ?? 0;
  return item && item.kind !== 'exam' ? reviewSeed(item, attempts, p?.last?.seed) : attemptSeed(id, attempts);
}
