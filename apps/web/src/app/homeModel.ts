// What the home screen and the content browser draw, derived from the progress state, the catalog
// and now (docs/LEARNING_MODEL.md §8, §9). Pure functions: no clock, no content module, so the
// tests run in Node and the screens only lay out what these return. Every number here is one the
// log holds or a function of it; nothing is estimated beyond what stats.ts estimates.

import { dayIndex, DAY_MS, domainOf, isScheduled, itemStatus, metSkills, recentMistakes, RECENT_MISTAKE_DAYS, skillStats, domainStats, type Catalog, type ItemMeta, type ItemStatus, type Mistakes, type ProgressState, type Queue, type SkillStatus } from '@simlab/learn';
import type { CurriculumExam } from 'virtual:simlab/content';
import type { DailySession } from './daily.ts';

export type Kind = ItemMeta['kind'];

export const KIND_LABEL: Record<Kind, string> = { lesson: 'Lesson', drill: 'Drill', lab: 'Lab', incident: 'Incident', card: 'Card' };

// ---------- time and numbers ----------

/** "30 s" for a card, "8 min", "1 h 5 min". */
export function formatMinutes(minutes: number): string {
  if (minutes > 0 && minutes < 1) return `${Math.round(minutes * 60)} s`;
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

export const formatMs = (ms: number): string => formatMinutes(ms / 60_000);

export const percent = (x: number): string => `${Math.round(x * 100)}%`;

/** How long ago, in the coarsest unit that is not zero. */
export function ago(then: number, now: number): string {
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A learner's day as a calendar date. `dayIndex` counts days since the epoch in local time, so day
 * d is the local date of UTC day d: read it in UTC and no time zone of the browser comes in.
 */
export function dayDate(day: number): { weekday: string; label: string; long: string } {
  const d = new Date(day * DAY_MS);
  const weekday = WEEKDAYS[d.getUTCDay()] as string;
  const label = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] as string}`;
  return { weekday, label, long: `${weekday} ${label}` };
}

/** "today", "tomorrow", "in 3 days", "2 days ago". */
export function relativeDay(day: number, today: number): string {
  const n = day - today;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------- today's session ----------

export type SessionMode = 'start' | 'continue' | 'done' | 'idle';

/**
 * What the primary action is. `done`: the queue is empty and something was finished today;
 * `idle`: the queue is empty and nothing was (no track, or nothing ready).
 */
export function sessionMode(state: ProgressState, queue: Queue, session: DailySession): SessionMode {
  if (queue.entries.length > 0) return session.running || session.done.length > 0 ? 'continue' : 'start';
  return session.done.length > 0 || state.days[String(queue.day)] !== undefined ? 'done' : 'idle';
}

export interface PlanEntry {
  item: string;
  title: string;
  kind: Kind;
  reason: 'review' | 'new';
  minutes: number;
  /** Where the entry starts and ends on the session's bar, as shares of its scale. */
  from: number;
  to: number;
}

export interface SessionPlan {
  entries: PlanEntry[];
  /** The time box, what was spent of it today, and the sum of the entries' target times (minutes). */
  box: number;
  spent: number;
  minutes: number;
  /** The bar's scale: the box, or more when the first item alone is longer than what is left. */
  scale: number;
  reviews: number;
  fresh: number;
  /** What did not fit, in words; undefined when everything fits. */
  waiting?: string;
}

export function sessionPlan(state: ProgressState, catalog: Catalog, queue: Queue): SessionPlan {
  const box = state.settings.dailyMinutes;
  const spent = Math.max(0, box - queue.minutesLeft);
  const scale = Math.max(box, spent + queue.minutes);
  let at = spent;
  const entries = queue.entries.map((e): PlanEntry => {
    const from = at / scale;
    at += e.minutes;
    return { item: e.item, title: catalog.items[e.item]?.title ?? e.item, kind: e.kind, reason: e.reason, minutes: e.minutes, from, to: at / scale };
  });
  const parts: string[] = [];
  if (queue.waiting.reviews > 0) parts.push(plural(queue.waiting.reviews, 'more review'));
  if (queue.waiting.fresh > 0) parts.push(plural(queue.waiting.fresh, 'new item'));
  const plan: SessionPlan = {
    entries,
    box,
    spent,
    minutes: queue.minutes,
    scale,
    reviews: queue.entries.filter((e) => e.reason === 'review').length,
    fresh: queue.entries.filter((e) => e.reason === 'new').length,
  };
  if (parts.length > 0) plan.waiting = `${parts.join(' and ')} did not fit today's ${box} minutes. ${queue.waiting.reviews > 0 ? 'Reviews stay due and come first tomorrow.' : 'They come in track order on a later day.'}`;
  return plan;
}

// ---------- the due forecast ----------

export interface ForecastDay {
  day: number;
  /** Reviews due that day; on today, the overdue ones too. */
  count: number;
  overdue: number;
  minutes: number;
}

/** Reviews due per learner's day from today, from each scheduled item's due moment. */
export function forecast(state: ProgressState, catalog: Catalog, now: number, days = 14): ForecastDay[] {
  const today = dayIndex(now, state.settings);
  const out: ForecastDay[] = Array.from({ length: days }, (_, i) => ({ day: today + i, count: 0, overdue: 0, minutes: 0 }));
  for (const id of Object.keys(state.items).sort()) {
    const meta = catalog.items[id];
    const s = state.items[id]?.schedule;
    if (!meta || !s || !isScheduled(meta.kind)) continue;
    const due = dayIndex(s.dueAt, state.settings);
    const slot = out[Math.max(0, due - today)];
    if (!slot) continue;
    slot.count++;
    slot.minutes += meta.targetMinutes;
    if (due < today) slot.overdue++;
  }
  return out;
}

// ---------- streak and activity ----------

export interface ActivityDay {
  day: number;
  attempts: number;
  passes: number;
  activeMs: number;
  /** 0 nothing; 1 to 4 by the share of the time box spent: some, a third, two thirds, all of it. */
  level: 0 | 1 | 2 | 3 | 4;
}

export function activity(state: ProgressState, now: number, days = 28): ActivityDay[] {
  const today = dayIndex(now, state.settings);
  const box = state.settings.dailyMinutes * 60_000;
  return Array.from({ length: days }, (_, i) => {
    const day = today - days + 1 + i;
    const d = state.days[String(day)];
    const ms = d?.activeMs ?? 0;
    const share = box > 0 ? ms / box : 0;
    const level = !d || d.attempts === 0 ? 0 : share >= 1 ? 4 : share >= 2 / 3 ? 3 : share >= 1 / 3 ? 2 : 1;
    return { day, attempts: d?.attempts ?? 0, passes: d?.passes ?? 0, activeMs: ms, level };
  });
}

// ---------- mastery ----------

export interface SkillRow {
  skill: string;
  title: string;
  status: SkillStatus;
  mastery: number;
  items: number;
  attempted: number;
  passed: number;
  recentMistakes: number;
  /** For a locked skill: the prerequisites not met yet, by title. */
  needs: string[];
}

/** Every skill, in the order the packs list them (the author's order, not the ids'). */
export function skillRows(state: ProgressState, catalog: Catalog, now: number): SkillRow[] {
  const stats = new Map(skillStats(state, catalog, now).map((s) => [s.skill, s]));
  const met = metSkills(state, catalog);
  return Object.keys(catalog.skills).flatMap((skill) => {
    const s = stats.get(skill);
    if (!s) return [];
    const needs = s.status === 'locked' ? (catalog.skills[skill]?.requires ?? []).filter((r) => !met.has(r)).map((r) => catalog.skills[r]?.title ?? r) : [];
    return [{ skill, title: catalog.skills[skill]?.title ?? skill, status: s.status, mastery: s.mastery, items: s.items, attempted: s.attempted, passed: s.passed, recentMistakes: s.recentMistakes, needs }];
  });
}

export interface DomainRow {
  domain: string;
  title: string;
  /** Share of the exam in percent; undefined for a domain the curricula do not list. */
  weight?: number;
  items: number;
  attempted: number;
  passed: number;
  attempts: number;
  passRate: number;
  mastery: number;
  activeMs: number;
}

export interface ExamGroup {
  exam: string;
  title: string;
  domains: DomainRow[];
  /** Mastery weighted by the domains' shares of the exam; a domain with no items counts 0. */
  weighted?: number;
  items: number;
}

/**
 * The curriculum domains by exam, heaviest first, every domain of an exam the content touches
 * (one with no items yet shows as such: the gap is part of the picture). Domains no curriculum
 * lists come last, in one group without weights.
 */
export function examGroups(state: ProgressState, catalog: Catalog, now: number, curriculum: readonly CurriculumExam[]): ExamGroup[] {
  const stats = new Map(domainStats(state, catalog, now).map((d) => [d.domain, d]));
  const row = (domain: string, title: string, weight?: number): DomainRow => {
    const s = stats.get(domain);
    const r: DomainRow = { domain, title, items: s?.items ?? 0, attempted: s?.attempted ?? 0, passed: s?.passed ?? 0, attempts: s?.attempts ?? 0, passRate: s?.passRate ?? 0, mastery: s?.mastery ?? 0, activeMs: s?.activeMs ?? 0 };
    if (weight !== undefined) r.weight = weight;
    return r;
  };
  const listed = new Set<string>();
  const groups: ExamGroup[] = [];
  for (const exam of curriculum) {
    for (const d of exam.domains) listed.add(d.id);
    if (!exam.domains.some((d) => stats.has(d.id))) continue;
    const domains = exam.domains.map((d) => row(d.id, d.title, d.weight)).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.domain < b.domain ? -1 : 1));
    const total = domains.reduce((n, d) => n + (d.weight ?? 0), 0);
    groups.push({ exam: exam.id, title: exam.title, domains, weighted: total > 0 ? domains.reduce((n, d) => n + (d.weight ?? 0) * d.mastery, 0) / total : 0, items: itemsIn(catalog, (c) => exam.domains.some((d) => d.id === domainOf(c))) });
  }
  const other = [...stats.keys()].filter((d) => !listed.has(d)).sort();
  if (other.length > 0) groups.push({ exam: 'other', title: 'Other domains', domains: other.map((d) => row(d, d)), items: itemsIn(catalog, (c) => other.includes(domainOf(c))) });
  return groups;
}

const itemsIn = (catalog: Catalog, test: (competency: string) => boolean): number => Object.values(catalog.items).filter((i) => i.curriculum.some(test)).length;

// ---------- recent mistakes and resume ----------

export interface MistakeRow {
  item: string;
  title: string;
  kind: Kind;
  /** Mistakes in the last RECENT_MISTAKE_DAYS days: the log keeps the count per day, not per kind. */
  recent: number;
  /** All-time counts per kind, which is what the log keeps by kind. */
  allTime: Mistakes;
}

export function mistakeRows(state: ProgressState, catalog: Catalog, now: number): MistakeRow[] {
  const today = dayIndex(now, state.settings);
  const out: MistakeRow[] = [];
  for (const id of Object.keys(state.items).sort()) {
    const meta = catalog.items[id];
    const p = state.items[id];
    const recent = recentMistakes(p, today);
    if (!meta || !p || recent === 0) continue;
    out.push({ item: id, title: meta.title, kind: meta.kind, recent, allTime: p.mistakes });
  }
  return out.sort((a, b) => b.recent - a.recent || (a.item < b.item ? -1 : 1));
}

export { RECENT_MISTAKE_DAYS };

/** "2 failed checks · 1 hint": the kinds with a count, in a fixed order. */
export function mistakeKinds(m: Mistakes): string {
  const parts = [
    m.failures > 0 ? plural(m.failures, 'failed attempt') : '',
    m.failedChecks > 0 ? plural(m.failedChecks, 'failed check') : '',
    m.hints > 0 ? plural(m.hints, 'hint') : '',
    m.solutions > 0 ? plural(m.solutions, 'solution viewed', 'solutions viewed') : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

// ---------- the content browser ----------

export interface ItemCard {
  item: string;
  title: string;
  kind: Kind;
  difficulty: number;
  minutes: number;
  skills: string[];
  curriculum: string[];
  domains: string[];
  tracks: string[];
  status: ItemStatus;
  /** The status in a few words: "due today", "next in 4 days", "every 34 days". */
  detail: string;
  /** The date that goes with the detail, for a title attribute. */
  date?: string;
  /** The unfinished attempt of the item, newest first. */
  attempt?: string;
}

export function itemCards(state: ProgressState, catalog: Catalog, now: number, resumable: readonly { item: string; attempt: string }[]): ItemCard[] {
  const today = dayIndex(now, state.settings);
  const tracksOf = new Map<string, string[]>();
  for (const t of Object.keys(catalog.tracks)) for (const i of catalog.tracks[t]?.items ?? []) tracksOf.set(i, [...(tracksOf.get(i) ?? []), t]);
  return Object.values(catalog.items).map((meta) => {
    const p = state.items[meta.id];
    const status = itemStatus(p, state.settings, now);
    const s = p?.schedule;
    let detail: string = status;
    let date: string | undefined;
    if (s) {
      const due = dayIndex(s.dueAt, state.settings);
      date = dayDate(due).long;
      if (status === 'due') detail = due === today ? 'due today' : `due, ${plural(today - due, 'day')} overdue`;
      else if (status === 'mastered') detail = `mastered, every ${plural(Math.round(s.intervalDays), 'day')}`;
      else detail = `learning, next ${relativeDay(due, today)}`;
    } else if (status === 'mastered') detail = 'mastered, done once';
    const card: ItemCard = {
      item: meta.id,
      title: meta.title,
      kind: meta.kind,
      difficulty: meta.difficulty,
      minutes: meta.targetMinutes,
      skills: meta.skills,
      curriculum: meta.curriculum,
      domains: [...new Set(meta.curriculum.map(domainOf))],
      tracks: tracksOf.get(meta.id) ?? [],
      status,
      detail,
    };
    if (date !== undefined) card.date = date;
    const open = resumable.find((r) => r.item === meta.id);
    if (open) card.attempt = open.attempt;
    return card;
  });
}

export const ALL = '*';

export interface Filters {
  track: string;
  skill: string;
  domain: string;
  kind: string;
  status: string;
}

export const NO_FILTERS: Filters = { track: ALL, skill: ALL, domain: ALL, kind: ALL, status: ALL };

export function matches(card: ItemCard, f: Filters): boolean {
  return (
    (f.track === ALL || card.tracks.includes(f.track)) &&
    (f.skill === ALL || card.skills.includes(f.skill)) &&
    (f.domain === ALL || card.domains.includes(f.domain)) &&
    (f.kind === ALL || card.kind === f.kind) &&
    (f.status === ALL || card.status === f.status)
  );
}

export const STATUSES: readonly ItemStatus[] = ['new', 'learning', 'due', 'mastered'];

/** True when the log holds no finished attempt and none in progress: the first run. */
export const isFirstRun = (state: ProgressState): boolean => Object.keys(state.items).length === 0 && Object.keys(state.open).length === 0;
