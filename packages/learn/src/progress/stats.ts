// What is derived from the progress state and the catalog (docs/LEARNING_MODEL.md §9): mastery
// per skill, recent mistakes, per-domain statistics, streaks. The state knows items; the catalog
// says which skills and competencies an item serves, so these follow the content as it is now.

import type { Catalog, ItemMeta } from '../pack.ts';
import { isScheduled } from '../pack.ts';
import { dayIndex, DAY_MS } from './day.ts';
import { retrievability } from './fsrs.ts';
import type { ItemProgress, ProgressState } from './reducer.ts';

/** How far back "recent mistakes" looks. */
export const RECENT_MISTAKE_DAYS = 7;
/** A skill is mastered when the expected recall over its items is at least this. */
export const MASTERY_THRESHOLD = 0.8;

/** The probability of recalling an item now: 0 when it was never rated. */
export function itemRecall(p: ItemProgress | undefined, now: number): number {
  if (!p?.schedule) return 0;
  return retrievability(p.schedule.memory, (now - p.schedule.reviewedAt) / DAY_MS);
}

/** Mistakes on an item in the last `RECENT_MISTAKE_DAYS` learner's days, today included. */
export function recentMistakes(p: ItemProgress | undefined, today: number): number {
  if (!p) return 0;
  let n = 0;
  for (let d = today - RECENT_MISTAKE_DAYS + 1; d <= today; d++) n += p.mistakeDays[String(d)] ?? 0;
  return n;
}

/** An item whose interval has reached this many days counts as mastered. */
export const MATURE_INTERVAL_DAYS = 21;

/** Where an item stands, for lists and filters. */
export type ItemStatus = 'new' | 'learning' | 'due' | 'mastered';

/**
 * new: never rated (and, for a lesson, never passed). due: its review day has come. mastered: a
 * lesson that was passed, or an item whose interval is at least `MATURE_INTERVAL_DAYS`. learning:
 * everything in between.
 */
export function itemStatus(p: ItemProgress | undefined, settings: ProgressState['settings'], now: number): ItemStatus {
  if (!p?.schedule) return (p?.passes ?? 0) > 0 ? 'mastered' : 'new';
  if (dayIndex(p.schedule.dueAt, settings) <= dayIndex(now, settings)) return 'due';
  return p.schedule.intervalDays >= MATURE_INTERVAL_DAYS ? 'mastered' : 'learning';
}

/** The skills at least one passed item practices: what prerequisites ask for. */
export function metSkills(state: ProgressState, catalog: Catalog): Set<string> {
  const out = new Set<string>();
  for (const [id, p] of Object.entries(state.items)) if (p.passes > 0) for (const s of catalog.items[id]?.skills ?? []) out.add(s);
  return out;
}

export type SkillStatus = 'locked' | 'new' | 'learning' | 'mastered';

export interface SkillStats {
  skill: string;
  /** Items of the catalog that practice the skill, and how many were attempted and passed. */
  items: number;
  attempted: number;
  passed: number;
  /** Expected recall now, averaged over the skill's scheduled items; an unrated item counts 0. */
  mastery: number;
  recentMistakes: number;
  mistakes: number;
  status: SkillStatus;
}

function byKey<T>(items: readonly ItemMeta[], keys: (i: ItemMeta) => string[], init: (key: string) => T): Map<string, { value: T; items: ItemMeta[] }> {
  const out = new Map<string, { value: T; items: ItemMeta[] }>();
  for (const i of items) {
    for (const k of keys(i)) {
      if (!out.has(k)) out.set(k, { value: init(k), items: [] });
      out.get(k)?.items.push(i);
    }
  }
  return out;
}

const sortedItems = (catalog: Catalog): ItemMeta[] => Object.keys(catalog.items).sort().map((id) => catalog.items[id] as ItemMeta);

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

const totalMistakes = (p: ItemProgress | undefined): number => (p ? p.mistakes.failures + p.mistakes.failedChecks + p.mistakes.hints + p.mistakes.solutions : 0);

/** Every skill of the catalog, in id order. */
export function skillStats(state: ProgressState, catalog: Catalog, now: number): SkillStats[] {
  const today = dayIndex(now, state.settings);
  const met = metSkills(state, catalog);
  const groups = byKey(sortedItems(catalog), (i) => i.skills, () => null);
  return Object.keys(catalog.skills).sort().map((skill) => {
    const items = groups.get(skill)?.items ?? [];
    const progress = items.map((i) => state.items[i.id]);
    const mastery = mean(items.filter((i) => isScheduled(i.kind)).map((i) => itemRecall(state.items[i.id], now)));
    const attempted = progress.filter((p) => (p?.attempts ?? 0) > 0).length;
    const locked = (catalog.skills[skill]?.requires ?? []).some((r) => !met.has(r));
    const status: SkillStatus = attempted === 0 ? (locked ? 'locked' : 'new') : mastery >= MASTERY_THRESHOLD ? 'mastered' : 'learning';
    return {
      skill,
      items: items.length,
      attempted,
      passed: progress.filter((p) => (p?.passes ?? 0) > 0).length,
      mastery,
      recentMistakes: progress.reduce((n, p) => n + recentMistakes(p, today), 0),
      mistakes: progress.reduce((n, p) => n + totalMistakes(p), 0),
      status,
    };
  });
}

/** `cka.troubleshooting.clusters-nodes` → `cka.troubleshooting`: the curriculum domain of a competency. */
export function domainOf(competency: string): string {
  return competency.split('.').slice(0, 2).join('.');
}

export interface DomainStats {
  domain: string;
  items: number;
  attempted: number;
  passed: number;
  attempts: number;
  /** Passed attempts over finished attempts, 0 when there are none. */
  passRate: number;
  mastery: number;
  activeMs: number;
}

/** Per curriculum domain, in id order. An item counts in every domain one of its competencies belongs to. */
export function domainStats(state: ProgressState, catalog: Catalog, now: number): DomainStats[] {
  const groups = byKey(sortedItems(catalog), (i) => [...new Set(i.curriculum.map(domainOf))], () => null);
  return [...groups.keys()].sort().map((domain) => {
    const items = groups.get(domain)?.items ?? [];
    const progress = items.map((i) => state.items[i.id]);
    const attempts = progress.reduce((n, p) => n + (p?.attempts ?? 0), 0);
    const passes = progress.reduce((n, p) => n + (p?.passes ?? 0), 0);
    return {
      domain,
      items: items.length,
      attempted: progress.filter((p) => (p?.attempts ?? 0) > 0).length,
      passed: progress.filter((p) => (p?.passes ?? 0) > 0).length,
      attempts,
      passRate: attempts === 0 ? 0 : passes / attempts,
      mastery: mean(items.filter((i) => isScheduled(i.kind)).map((i) => itemRecall(state.items[i.id], now))),
      activeMs: progress.reduce((n, p) => n + (p?.activeMs ?? 0), 0),
    };
  });
}

export interface Streak {
  /** Consecutive learner's days with a finished attempt, ending today or yesterday. */
  current: number;
  longest: number;
  /** Whether today already counts. */
  today: boolean;
}

export function streak(state: ProgressState, now: number): Streak {
  const today = dayIndex(now, state.settings);
  const days = Object.keys(state.days).map(Number).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let previous: number | undefined;
  for (const d of days) {
    run = previous !== undefined && d === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = d;
  }
  const has = (d: number): boolean => state.days[String(d)] !== undefined;
  let current = 0;
  for (let d = has(today) ? today : today - 1; has(d); d--) current++;
  return { current, longest, today: has(today) };
}
